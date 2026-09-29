import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION } from "@gloam/shared";
import { GloamError } from "@gloam/shared/protocol";
import { z } from "zod";
import type { StoredVariant, Uploader } from "../assets/service.ts";
import { PURPOSES, type Purpose } from "../assets/types.ts";
import type { ServerContext } from "../context.ts";
import { type IdPrefix, newId } from "../ids.ts";
import { openZip, readEntry, writeZip } from "./gloamZip.ts";
import { CAMPAIGN_TABLES, SCENE_TABLES, type SnapshotDoc } from "./snapshots.ts";

/**
 * Moving a campaign between machines (SPEC §20.5; AC-PER-05): a `.gloam` is a zip of `manifest.json` (format,
 * version, counts, the SHA-256 of every file), `campaign.json` (the snapshot document) and `assets/<fileId>.<ext>` —
 * each referenced file's largest processed output. Importing (Admin only) checks the zip (gloamZip.ts), every file's
 * hash, and the document's every table and column against this database's; runs every asset through the upload
 * pipeline again; and makes a new campaign in which every id is new — every id-shaped string of a row type anywhere
 * in the document (dangling ones too) mapped once, so nothing imported can point at anything already here.
 */

type Row = Record<string, unknown>;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const Manifest = z.strictObject({
  format: z.literal("gloam-export"),
  version: z.literal(1),
  app: z.string().max(40),
  createdAt: z.number(),
  campaign: z.string().max(200),
  counts: z.record(z.string().max(40), z.number().int().min(0)),
  files: z.record(z.string().max(120), z.string().regex(/^[0-9a-f]{64}$/)),
});

/** Ids of row types — remapped wherever they appear. User ids and a sheet's own block ids travel as they are. */
const ROW_ID =
  /^(cmp|scn|tok|act|wal|lgt|zon|eff|ses|inv|rol|req|prm|his|snp|hnd|log|tpl|prp|api|ast|dev|tbs|cmb|job|cst|cnt|pls)_[0-9A-Za-z]{16}$/;

/** A file name for a campaign: its name as a slug, and the date. */
function exportName(name: string, at: number): string {
  const slug =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "campaign";
  return `${slug}-${new Date(at).toISOString().slice(0, 10)}.gloam`;
}

/** The variant an export carries for a file: its largest processed output (the widest image, the GLB, the audio). */
function fullVariant(variants: StoredVariant[]): StoredVariant | null {
  let best: StoredVariant | null = null;
  for (const v of variants)
    if (
      !best ||
      (v.width ?? 0) > (best.width ?? 0) ||
      ((v.width ?? 0) === (best.width ?? 0) && v.bytes > best.bytes)
    )
      best = v;
  return best;
}

/** Writes `data/exports/<campaign>-<date>.gloam`. */
export async function exportCampaign(
  ctx: ServerContext,
  campaignId: string,
): Promise<{ file: string; bytes: number }> {
  const doc = ctx.snapshots.document(campaignId);
  const files: Record<string, string> = {};
  const assetEntries: { name: string; read: () => Uint8Array; store: boolean }[] = [];
  const seen = new Set<string>();
  for (const a of doc.tables.assets ?? []) {
    const fileId = String(a.file_id);
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    const file = ctx.assets.file(fileId);
    if (!file) throw new Error(`The file of "${String(a.name)}" is missing from the data folder.`);
    const v = fullVariant(JSON.parse(String(file.variantsJson)) as StoredVariant[]);
    if (!v) throw new Error(`"${String(a.name)}" has no stored file to export.`);
    const ext = (v.path.split(".").pop() ?? "bin").toLowerCase();
    const name = `assets/${fileId}.${ext}`;
    const data = ctx.assets.readVariant(file, v.name);
    if (!data) throw new Error(`The file of "${String(a.name)}" can't be read.`);
    files[name] = sha256(data);
    // (Read again when written: memory holds one asset at a time.)
    assetEntries.push({ name, read: () => ctx.assets.readVariant(file, v.name) as Buffer, store: true });
  }
  const campaignJson = Buffer.from(JSON.stringify(doc));
  files["campaign.json"] = sha256(campaignJson);
  const counts: Record<string, number> = {};
  for (const [t, rows] of Object.entries(doc.tables)) counts[t] = rows.length;
  const manifest = {
    format: "gloam-export" as const,
    version: 1 as const,
    app: APP_VERSION,
    createdAt: doc.createdAt,
    campaign: String(doc.campaign.name ?? ""),
    counts,
    files,
  };
  const file = exportName(String(doc.campaign.name ?? ""), doc.createdAt);
  const bytes = await writeZip(join(ctx.paths.exports, file), [
    { name: "manifest.json", read: () => Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: "campaign.json", read: () => campaignJson },
    ...assetEntries,
  ]);
  ctx.log.info({ campaignId, file, bytes }, "campaign exported");
  return { file, bytes };
}

/** A table's columns, as this database has them (a document's columns must be among them: they become SQL). */
function columnsOf(ctx: ServerContext, table: string): Set<string> {
  return new Set(
    (ctx.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
}

/** One old → new id map for the whole import. */
class IdMap {
  readonly map = new Map<string, string>();
  of(old: string): string {
    let v = this.map.get(old);
    if (!v) {
      v = newId(old.slice(0, old.indexOf("_")) as IdPrefix);
      this.map.set(old, v);
    }
    return v;
  }
  /** A value with every row id in it replaced — in a JSON document too, its keys as well as its strings. */
  value(v: unknown): unknown {
    if (typeof v === "string") {
      if (ROW_ID.test(v)) return this.of(v);
      const t = v.trimStart();
      if ((t.startsWith("{") || t.startsWith("[")) && v.length < 64 * 1024 * 1024) {
        try {
          return JSON.stringify(this.deep(JSON.parse(v)));
        } catch {
          return v;
        }
      }
      return v;
    }
    return v;
  }
  private deep(v: unknown): unknown {
    if (typeof v === "string") return ROW_ID.test(v) ? this.of(v) : v;
    if (Array.isArray(v)) return v.map((x) => this.deep(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[ROW_ID.test(k) ? this.of(k) : k] = this.deep(x);
      return out;
    }
    return v;
  }
}

/** A document row checked against its table: known columns only, plain values (a blob as `{ $b64 }`). */
function checkRow(table: string, row: unknown, cols: Set<string>): Row {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new GloamError("INVALID", `The campaign file's ${table} has a row that isn't one.`);
  for (const [k, v] of Object.entries(row as Row)) {
    if (!cols.has(k))
      throw new GloamError("INVALID", `The campaign file's ${table} has a column Gloam doesn't know.`);
    const blob = v && typeof v === "object" && typeof (v as { $b64?: unknown }).$b64 === "string";
    if (v !== null && typeof v !== "string" && typeof v !== "number" && !blob)
      throw new GloamError("INVALID", `The campaign file's ${table} has a value Gloam can't store.`);
  }
  return row as Row;
}

function insert(ctx: ServerContext, table: string, rows: Row[]): void {
  for (const r of rows) {
    const cols = Object.keys(r);
    if (!cols.length) continue;
    ctx.sqlite
      .prepare(
        `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      )
      .run(
        ...cols.map((c) => {
          const v = r[c] as unknown;
          return v && typeof v === "object"
            ? Buffer.from(String((v as { $b64: string }).$b64), "base64")
            : (v ?? null);
        }),
      );
  }
}

/**
 * Imports a `.gloam` at `path` as a new campaign (the importing Admin its uploader of record). Everything is checked
 * before anything is written; the assets are processed (the pipeline's own validation); the rows go in in one
 * transaction — a failure anywhere leaves no campaign behind.
 */
export async function importCampaign(
  ctx: ServerContext,
  path: string,
  by: Uploader,
): Promise<{ campaignId: string; name: string; counts: Record<string, number>; ids: Map<string, string> }> {
  const zip = openZip(path);
  let manifest: z.infer<typeof Manifest>;
  let doc: SnapshotDoc;
  const blobs = new Map<string, Buffer>();
  try {
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    const m = byName.get("manifest.json");
    const c = byName.get("campaign.json");
    if (!m || !c)
      throw new GloamError("INVALID", "That isn't a campaign file: its manifest or campaign is missing.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readEntry(zip.fd, m).toString("utf8"));
    } catch (err) {
      if (err instanceof GloamError) throw err;
      throw new GloamError("INVALID", "Its manifest isn't readable.");
    }
    const mr = Manifest.safeParse(parsed);
    if (!mr.success)
      throw new GloamError("INVALID", "Its manifest isn't one Gloam writes (a newer version?).");
    manifest = mr.data;
    // Every file the manifest names is there, every file there is named, and each is what the manifest says.
    for (const name of Object.keys(manifest.files))
      if (!byName.has(name))
        throw new GloamError("INVALID", `It's missing ${JSON.stringify(name.slice(0, 80))}.`);
    for (const e of zip.entries) {
      if (e.name === "manifest.json") continue;
      const want = manifest.files[e.name];
      if (!want) throw new GloamError("INVALID", `It holds a file its manifest doesn't list.`);
      const data = readEntry(zip.fd, e);
      if (sha256(data) !== want)
        throw new GloamError("INVALID", `A file in it has been changed since it was exported.`);
      if (e.name === "campaign.json") {
        try {
          doc = JSON.parse(data.toString("utf8")) as SnapshotDoc;
        } catch {
          throw new GloamError("INVALID", "Its campaign document isn't readable.");
        }
      } else blobs.set(e.name.slice("assets/".length, e.name.lastIndexOf(".")), data);
    }
  } finally {
    zip.close();
  }
  // biome-ignore lint/style/noNonNullAssertion: set above (the manifest requires campaign.json, read in the loop)
  const d = doc!;
  if (
    !d ||
    d.format !== "gloam-snapshot" ||
    d.schemaVersion !== 1 ||
    !d.campaign ||
    typeof d.tables !== "object"
  )
    throw new GloamError("INVALID", "Its campaign document isn't one Gloam writes.");
  const known = new Set<string>([...CAMPAIGN_TABLES, ...SCENE_TABLES]);
  for (const t of Object.keys(d.tables))
    if (!known.has(t))
      throw new GloamError("INVALID", "Its campaign document has a table Gloam doesn't know.");
  const tables: Record<string, Row[]> = {};
  for (const t of known) {
    const rows = d.tables[t] ?? [];
    if (!Array.isArray(rows)) throw new GloamError("INVALID", `Its ${t} isn't a list.`);
    const cols = columnsOf(ctx, t);
    tables[t] = rows.map((r) => checkRow(t, r, cols));
  }
  const campaign = checkRow("campaigns", d.campaign, columnsOf(ctx, "campaigns"));
  const scenes = new Set(tables.scenes?.map((s) => String(s.id)));
  for (const t of SCENE_TABLES)
    for (const r of tables[t] ?? [])
      if (!scenes.has(String(r.scene_id)))
        throw new GloamError("INVALID", `Its ${t} refer to a scene it doesn't contain.`);

  const ids = new IdMap();
  const campaignId = ids.of(String(campaign.id));
  const now = Date.now();
  // The campaign row first (its assets and rows hang off it), then the assets through the pipeline, then the rest.
  const newCampaign: Row = {};
  for (const [k, v] of Object.entries(campaign)) newCampaign[k] = ids.value(v);
  newCampaign.id = campaignId;
  newCampaign.updated_at = now;
  insert(ctx, "campaigns", [newCampaign]);
  const tmp = mkdtempSync(join(ctx.paths.tmp, "import-"));
  try {
    // Each asset reference: its file re-run through the upload pipeline (§20.5: re-validated), a reference of its own.
    const made = new Map<string, string>(); // file id + purpose → the new file id
    for (const a of tables.assets ?? []) {
      const oldFile = String(a.file_id);
      const data = blobs.get(oldFile);
      if (!data) throw new GloamError("INVALID", `The file of "${String(a.name).slice(0, 80)}" is missing.`);
      const purpose = String(a.purpose) as Purpose;
      if (!(PURPOSES as readonly string[]).includes(purpose))
        throw new GloamError("INVALID", `"${String(a.name).slice(0, 80)}" has a purpose Gloam doesn't know.`);
      const newAssetId = ids.of(String(a.id));
      const key = `${oldFile}|${purpose}`;
      let fileId = made.get(key);
      if (!fileId) {
        const p = join(tmp, `${made.size}`);
        writeFileSync(p, data);
        let r: Awaited<ReturnType<typeof ctx.assets.ingest>>;
        try {
          r = await ctx.assets.ingest({
            tmpPath: p,
            bytes: data.length,
            sha256: sha256(data),
            purpose,
            name: String(a.name ?? "Imported"),
            campaignId,
            uploader: by,
          });
        } catch (err) {
          throw new GloamError(
            "INVALID",
            `"${String(a.name).slice(0, 80)}" didn't pass the upload checks: ${(err as Error).message}`,
          );
        }
        const made1 = ctx.assets.get(r.asset.id)?.fileId;
        if (!made1) throw new Error("The imported file's reference went missing.");
        fileId = made1;
        made.set(key, fileId);
        // The reference the pipeline made becomes this asset: its own id, and its library fields as exported.
        ctx.sqlite.prepare("DELETE FROM assets WHERE id = ?").run(r.asset.id);
      }
      const row: Row = {};
      for (const [k, v] of Object.entries(a)) row[k] = ids.value(v);
      Object.assign(row, {
        id: newAssetId,
        campaign_id: campaignId,
        file_id: fileId,
        uploader_id: by.userId,
      });
      insert(ctx, "assets", [row]);
    }
    const counts: Record<string, number> = { assets: tables.assets?.length ?? 0 };
    ctx.sqlite.transaction(() => {
      for (const t of [...CAMPAIGN_TABLES, ...SCENE_TABLES]) {
        if (t === "assets") continue;
        const rows = (tables[t] ?? []).map((r) => {
          const out: Row = {};
          for (const [k, v] of Object.entries(r)) out[k] = ids.value(v);
          if (t !== "scenes" && "campaign_id" in out) out.campaign_id = campaignId;
          if (t === "scenes") out.campaign_id = campaignId;
          return out;
        });
        insert(ctx, t, rows);
        counts[t] = rows.length;
      }
    })();
    ctx.log.info({ campaignId, counts }, "campaign imported");
    return { campaignId, name: String(campaign.name ?? ""), counts, ids: ids.map };
  } catch (err) {
    // Nothing half-made: the campaign and everything hanging off it go (its processed files are the store's).
    ctx.sqlite.prepare("DELETE FROM campaigns WHERE id = ?").run(campaignId);
    throw err;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
