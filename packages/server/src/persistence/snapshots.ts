import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { APP_VERSION } from "@gloam/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Db, Sqlite } from "../db/client.ts";
import { snapshots } from "../db/schema.ts";
import { newId } from "../ids.ts";
import type { Logger } from "../logger.ts";

export type SnapshotKind = "auto" | "manual" | "scene" | "close" | "shutdown" | "pre-restore";
export type SnapshotRow = typeof snapshots.$inferSelect;

/** Retention per kind (SPEC §20.3); `manual` is kept until deleted. */
export const RETENTION: Record<SnapshotKind, number | null> = {
  auto: 24,
  scene: 10,
  "pre-restore": 5,
  close: 20,
  shutdown: 20,
  manual: null,
};

/** Tables keyed by campaign_id that a snapshot carries (SPEC §20.3). Order = insert order on restore. */
export const CAMPAIGN_TABLES = [
  "scenes",
  "actors",
  "sheet_templates",
  "content",
  "handouts",
  "log_entries",
  "assets",
] as const;
/** Tables keyed by scene_id (their rows ride along with their scene). */
export const SCENE_TABLES = [
  "walls",
  "lights",
  "zones",
  "tokens",
  "effects",
  "fog_masks",
  "combats",
] as const;
const BLOB_COLUMNS: Record<string, string[]> = { fog_masks: ["data"] };

type Row = Record<string, unknown>;

export interface SnapshotDoc {
  format: "gloam-snapshot";
  schemaVersion: 1;
  app: string;
  createdAt: number;
  campaign: Row;
  tables: Record<string, Row[]>;
}

function encodeRow(table: string, row: Row): Row {
  const blobs = BLOB_COLUMNS[table];
  if (!blobs) return row;
  const out = { ...row };
  for (const c of blobs) {
    const v = out[c];
    if (v instanceof Uint8Array) out[c] = { $b64: Buffer.from(v).toString("base64") };
  }
  return out;
}

function decodeRow(table: string, row: Row): Row {
  const blobs = BLOB_COLUMNS[table];
  if (!blobs) return row;
  const out = { ...row };
  for (const c of blobs) {
    const v = out[c] as { $b64?: string } | undefined;
    if (v && typeof v === "object" && typeof v.$b64 === "string") out[c] = Buffer.from(v.$b64, "base64");
  }
  return out;
}

function insertRows(sqlite: Sqlite, table: string, rows: Row[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0] as Row);
  const stmt = sqlite.prepare(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  );
  for (const r of rows) stmt.run(...cols.map((c) => decodeRow(table, r)[c] ?? null));
}

export class SnapshotService {
  private readonly sqlite: Sqlite;
  private readonly db: Db;
  private readonly dir: string;
  private readonly log: Logger;
  constructor(sqlite: Sqlite, db: Db, dir: string, log: Logger) {
    this.sqlite = sqlite;
    this.db = db;
    this.dir = dir;
    this.log = log;
  }

  /** Builds the full campaign document (also used by `.gloam` export). */
  document(campaignId: string): SnapshotDoc {
    const campaign = this.sqlite.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId) as
      | Row
      | undefined;
    if (!campaign) throw new Error(`campaign ${campaignId} not found`);
    const tables: Record<string, Row[]> = {};
    for (const t of CAMPAIGN_TABLES) {
      tables[t] = (
        this.sqlite.prepare(`SELECT * FROM ${t} WHERE campaign_id = ?`).all(campaignId) as Row[]
      ).map((r) => encodeRow(t, r));
    }
    for (const t of SCENE_TABLES) {
      tables[t] = (
        this.sqlite
          .prepare(`SELECT * FROM ${t} WHERE scene_id IN (SELECT id FROM scenes WHERE campaign_id = ?)`)
          .all(campaignId) as Row[]
      ).map((r) => encodeRow(t, r));
    }
    return {
      format: "gloam-snapshot",
      schemaVersion: 1,
      app: APP_VERSION,
      createdAt: Date.now(),
      campaign,
      tables,
    };
  }

  write(campaignId: string, kind: SnapshotKind, name?: string): SnapshotRow {
    const doc = this.document(campaignId);
    const dir = join(this.dir, campaignId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const iso = new Date(doc.createdAt).toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${iso}-${kind}.json.gz`);
    const bytes = gzipSync(Buffer.from(JSON.stringify(doc)), { level: 6 });
    writeFileSync(path, bytes, { mode: 0o600 });
    const row: SnapshotRow = {
      id: newId("snp"),
      campaignId,
      name: name?.trim().slice(0, 80) || defaultName(kind, doc.createdAt),
      kind,
      path,
      bytes: bytes.length,
      createdAt: doc.createdAt,
    };
    this.db.insert(snapshots).values(row).run();
    this.prune(campaignId, kind);
    this.log.info({ campaignId, kind, bytes: bytes.length }, "snapshot written");
    return row;
  }

  private prune(campaignId: string, kind: SnapshotKind): void {
    const keep = RETENTION[kind];
    if (keep === null) return;
    const rows = this.db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.campaignId, campaignId), eq(snapshots.kind, kind)))
      .orderBy(desc(snapshots.createdAt))
      .all();
    for (const r of rows.slice(keep)) this.remove(r.id);
  }

  list(campaignId: string): SnapshotRow[] {
    return this.db
      .select()
      .from(snapshots)
      .where(eq(snapshots.campaignId, campaignId))
      .orderBy(desc(snapshots.createdAt))
      .all();
  }

  get(id: string): SnapshotRow | undefined {
    return this.db.select().from(snapshots).where(eq(snapshots.id, id)).get();
  }

  remove(id: string): void {
    const row = this.get(id);
    if (!row) return;
    rmSync(row.path, { force: true });
    this.db.delete(snapshots).where(eq(snapshots.id, id)).run();
  }

  read(id: string): SnapshotDoc {
    const row = this.get(id);
    if (!row) throw new Error("snapshot not found");
    const doc = JSON.parse(gunzipSync(readFileSync(row.path)).toString("utf8")) as SnapshotDoc;
    if (doc.format !== "gloam-snapshot" || doc.schemaVersion !== 1)
      throw new Error("unsupported snapshot format");
    return doc;
  }

  /** Replaces the campaign's rows with the snapshot's, in one transaction, after a `pre-restore` snapshot. */
  restore(id: string): { preRestoreId: string } {
    const row = this.get(id);
    if (!row) throw new Error("snapshot not found");
    const doc = this.read(id);
    const pre = this.write(row.campaignId, "pre-restore");
    this.replaceCampaign(row.campaignId, doc);
    return { preRestoreId: pre.id };
  }

  /** Low-level replacement used by restore (history stays as an audit trail but is no longer undoable). */
  replaceCampaign(campaignId: string, doc: SnapshotDoc): void {
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM scenes WHERE campaign_id = ?").run(campaignId);
      for (const t of CAMPAIGN_TABLES) {
        if (t === "scenes") continue;
        this.sqlite.prepare(`DELETE FROM ${t} WHERE campaign_id = ?`).run(campaignId);
      }
      const { id: _id, ...rest } = doc.campaign;
      const cols = Object.keys(rest);
      this.sqlite
        .prepare(`UPDATE campaigns SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE id = ?`)
        .run(...cols.map((c) => rest[c] ?? null), campaignId);
      for (const t of CAMPAIGN_TABLES) insertRows(this.sqlite, t, doc.tables[t] ?? []);
      for (const t of SCENE_TABLES) insertRows(this.sqlite, t, doc.tables[t] ?? []);
      this.sqlite.prepare("UPDATE history SET undoable = 0 WHERE campaign_id = ?").run(campaignId);
    });
    tx();
  }

  fileSize(id: string): number {
    const row = this.get(id);
    return row ? statSync(row.path).size : 0;
  }
}

function defaultName(kind: SnapshotKind, at: number): string {
  const when = new Date(at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const label: Record<SnapshotKind, string> = {
    auto: "Autosave",
    manual: "Manual save",
    scene: "Scene change",
    close: "Table closed",
    shutdown: "Server shutdown",
    "pre-restore": "Before restore",
  };
  return `${label[kind]} · ${when}`;
}
