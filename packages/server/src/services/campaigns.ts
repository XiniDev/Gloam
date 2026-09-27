import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { campaigns, logEntries, memberships, tableSessions, users } from "../db/schema.ts";
import { newId } from "../ids.ts";

export type CampaignRow = typeof campaigns.$inferSelect;
export type Role = "admin" | "dm" | "player" | "spectator";
export type MemberRole = "dm" | "player" | "spectator";

export interface LogEntry {
  id: string;
  campaignId: string;
  sessionNo: number;
  kind: string;
  text: string;
  data: Record<string, unknown>;
  visibility: string;
  userId: string | null;
  createdAt: number;
}

/** Campaigns, memberships/roles, table sessions and the campaign log (SPEC §8.3, §8.18). */
export class CampaignService {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(opts: { name: string; rulesPack?: string; units?: "ft" | "m" }): CampaignRow {
    const now = Date.now();
    const row: CampaignRow = {
      id: newId("cmp"),
      name: opts.name.trim().slice(0, 80) || "Untitled campaign",
      coverAssetId: null,
      rulesPack: opts.rulesPack ?? "srd-5.2.1",
      units: opts.units ?? "ft",
      houseRulesJson: "{}",
      settingsJson: "{}",
      activeSceneId: null,
      sessionNo: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.db.insert(campaigns).values(row).run();
    return row;
  }

  get(id: string): CampaignRow | undefined {
    return this.db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  }

  list(includeArchived = false): CampaignRow[] {
    return this.db
      .select()
      .from(campaigns)
      .where(includeArchived ? undefined : isNull(campaigns.archivedAt))
      .orderBy(asc(campaigns.createdAt))
      .all();
  }

  update(id: string, patch: Partial<Omit<CampaignRow, "id" | "createdAt">>): void {
    this.db
      .update(campaigns)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(campaigns.id, id))
      .run();
  }

  delete(id: string): void {
    this.db.delete(campaigns).where(eq(campaigns.id, id)).run();
  }

  // ── roles ──────────────────────────────────────────────────────────────────────────────────────────────

  membership(campaignId: string, userId: string): MemberRole | null {
    const m = this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId)))
      .get();
    return m?.role ?? null;
  }

  setMembership(campaignId: string, userId: string, role: MemberRole): void {
    this.db
      .insert(memberships)
      .values({ campaignId, userId, role, createdAt: Date.now() })
      .onConflictDoUpdate({ target: [memberships.campaignId, memberships.userId], set: { role } })
      .run();
  }

  removeMembership(campaignId: string, userId: string): void {
    this.db
      .delete(memberships)
      .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId)))
      .run();
  }

  members(campaignId: string): { userId: string; role: MemberRole; displayName: string; color: string }[] {
    return this.db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        displayName: users.displayName,
        color: users.color,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.campaignId, campaignId))
      .all();
  }

  /** Admin is omnipotent; otherwise the campaign membership decides (§6). */
  roleOf(campaignId: string, user: { id: string; isAdmin: boolean }): Role | null {
    if (user.isAdmin) return "admin";
    return this.membership(campaignId, user.id);
  }

  // ── table sessions ─────────────────────────────────────────────────────────────────────────────────────

  beginTableSession(campaignId: string, mode: string): { id: string; sessionNo: number } {
    const c = this.get(campaignId);
    if (!c) throw new Error("campaign not found");
    const sessionNo = c.sessionNo + 1;
    const id = newId("tbs");
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.update(campaigns).set({ sessionNo, updatedAt: now }).where(eq(campaigns.id, campaignId)).run();
      tx.insert(tableSessions).values({ id, campaignId, sessionNo, mode, openedAt: now }).run();
    });
    this.appendLog(campaignId, { kind: "session.open", text: `Session ${sessionNo} began.`, data: { mode } });
    return { id, sessionNo };
  }

  endTableSession(id: string, reason: "closed" | "shutdown" | "crash"): void {
    const row = this.db.select().from(tableSessions).where(eq(tableSessions.id, id)).get();
    if (!row || row.closedAt !== null) return;
    this.db
      .update(tableSessions)
      .set({ closedAt: Date.now(), closeReason: reason })
      .where(eq(tableSessions.id, id))
      .run();
    const text =
      reason === "crash" ? `Session ${row.sessionNo} ended unexpectedly.` : `Session ${row.sessionNo} ended.`;
    this.appendLog(row.campaignId, {
      kind: "session.close",
      text,
      data: { reason },
      sessionNo: row.sessionNo,
    });
  }

  /** Crash hygiene (§11): close any table session left open by a crash. Returns how many were closed. */
  closeDanglingTableSessions(): number {
    const open = this.db.select().from(tableSessions).where(isNull(tableSessions.closedAt)).all();
    for (const s of open) this.endTableSession(s.id, "crash");
    return open.length;
  }

  tableSessionsFor(campaignId: string): (typeof tableSessions.$inferSelect)[] {
    return this.db
      .select()
      .from(tableSessions)
      .where(eq(tableSessions.campaignId, campaignId))
      .orderBy(desc(tableSessions.openedAt))
      .all();
  }

  // ── campaign log ───────────────────────────────────────────────────────────────────────────────────────

  appendLog(
    campaignId: string,
    e: {
      kind: string;
      text: string;
      data?: Record<string, unknown>;
      visibility?: string;
      userId?: string | null;
      sessionNo?: number;
    },
  ): LogEntry {
    const c = this.get(campaignId);
    const entry: LogEntry = {
      id: newId("log"),
      campaignId,
      sessionNo: e.sessionNo ?? c?.sessionNo ?? 0,
      kind: e.kind,
      text: e.text,
      data: e.data ?? {},
      visibility: e.visibility ?? "everyone",
      userId: e.userId ?? null,
      createdAt: Date.now(),
    };
    this.db
      .insert(logEntries)
      .values({ ...entry, dataJson: JSON.stringify(entry.data) })
      .run();
    return entry;
  }

  log(campaignId: string, opts: { sinceSession?: number; limit?: number } = {}): LogEntry[] {
    const rows = this.db
      .select()
      .from(logEntries)
      .where(eq(logEntries.campaignId, campaignId))
      .orderBy(asc(logEntries.createdAt))
      .all();
    return rows
      .filter((r) => opts.sinceSession === undefined || r.sessionNo >= opts.sinceSession)
      .slice(-(opts.limit ?? 5000))
      .map((r) => ({
        id: r.id,
        campaignId: r.campaignId,
        sessionNo: r.sessionNo,
        kind: r.kind,
        text: r.text,
        data: JSON.parse(r.dataJson) as Record<string, unknown>,
        visibility: r.visibility,
        userId: r.userId,
        createdAt: r.createdAt,
      }));
  }
}
