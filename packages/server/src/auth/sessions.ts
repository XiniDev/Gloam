import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { sessions, users } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { randomToken, sha256Hex } from "./crypto.ts";

export type SessionKind = "admin" | "player";
export type SessionStatus = "pending" | "admitted" | "denied" | "kicked";
export type SessionRow = typeof sessions.$inferSelect;
export type UserRow = typeof users.$inferSelect;

const DAY = 24 * 60 * 60 * 1000;
/** Lifetimes (SPEC §22.2): players 30 days; Admin 12 h idle, 7 days absolute. */
export const PLAYER_SESSION_MS = 30 * DAY;
export const ADMIN_IDLE_MS = 12 * 60 * 60 * 1000;
export const ADMIN_ABSOLUTE_MS = 7 * DAY;

export interface VerifiedSession {
  session: SessionRow;
  user: UserRow;
}

export class SessionService {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(opts: {
    userId: string;
    kind: SessionKind;
    status?: SessionStatus;
    tableSessionNo?: number | null;
    deviceId?: string | null;
    identityKind?: string | null;
    deviceLabel?: string | null;
    knockedAt?: number | null;
    ip?: string | null;
    now?: number;
  }): { token: string; session: SessionRow } {
    const now = opts.now ?? Date.now();
    const token = randomToken(32);
    const row: SessionRow = {
      id: newId("ses"),
      userId: opts.userId,
      tokenHash: sha256Hex(token),
      kind: opts.kind,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + (opts.kind === "admin" ? ADMIN_ABSOLUTE_MS : PLAYER_SESSION_MS),
      revokedAt: null,
      tableSessionNo: opts.tableSessionNo ?? null,
      status: opts.status ?? (opts.kind === "admin" ? "admitted" : "pending"),
      deviceId: opts.deviceId ?? null,
      identityKind: opts.identityKind ?? null,
      deviceLabel: opts.deviceLabel ?? null,
      knockedAt: opts.knockedAt ?? null,
      admittedAs: null,
      ip: opts.ip ?? null,
    };
    this.db.insert(sessions).values(row).run();
    return { token, session: row };
  }

  /** Resolves a cookie token to a live session and its (not banned, not deleted) user. */
  verify(token: string | undefined, now = Date.now()): VerifiedSession | null {
    if (!token || token.length < 20 || token.length > 100) return null;
    const row = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256Hex(token)))
      .get();
    if (!row || row.revokedAt !== null || row.expiresAt < now) return null;
    if (row.kind === "admin" && now - row.lastSeenAt > ADMIN_IDLE_MS) return null;
    const user = this.db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user || user.deletedAt !== null) return null;
    if (user.bannedAt !== null && !user.isAdmin) return null;
    if (now - row.lastSeenAt > 30_000) {
      this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.id)).run();
      this.db.update(users).set({ lastSeenAt: now }).where(eq(users.id, user.id)).run();
      row.lastSeenAt = now;
    }
    return { session: row, user };
  }

  get(id: string): SessionRow | undefined {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  /** New token for the same session (SPEC §22.2: rotate on admission and on admin login). */
  rotate(id: string): string {
    const token = randomToken(32);
    this.db
      .update(sessions)
      .set({ tokenHash: sha256Hex(token) })
      .where(eq(sessions.id, id))
      .run();
    return token;
  }

  update(id: string, patch: Partial<Omit<SessionRow, "id" | "tokenHash">>): void {
    this.db.update(sessions).set(patch).where(eq(sessions.id, id)).run();
  }

  revoke(id: string, now = Date.now()): void {
    this.db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, id)).run();
  }

  revokeAllForUser(userId: string, now = Date.now()): void {
    this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .run();
  }

  liveForUser(userId: string): SessionRow[] {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .all();
  }
}
