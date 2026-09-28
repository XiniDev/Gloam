import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { inviteCodes } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { formatInviteCode, normaliseCrockford, randomCrockford, sha256Hex } from "./crypto.ts";

export type InviteRow = typeof inviteCodes.$inferSelect;

/**
 * Invite codes (SPEC §8.1, AC-AUTH-08, AC-AUTH-10): 10 Crockford-base32 characters (≈50 bits), shown as
 * XXXXX-XXXXX, stored only as SHA-256 hashes, revoked when the table closes.
 */
export class InviteService {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(opts: { expiresAt: number | null; maxUses: number | null; now?: number }): {
    code: string;
    display: string;
    row: InviteRow;
  } {
    const code = randomCrockford(10);
    const row: InviteRow = {
      id: newId("inv"),
      codeHash: sha256Hex(code),
      createdAt: opts.now ?? Date.now(),
      expiresAt: opts.expiresAt,
      maxUses: opts.maxUses,
      uses: 0,
      revokedAt: null,
    };
    this.db.insert(inviteCodes).values(row).run();
    return { code, display: formatInviteCode(code), row };
  }

  /** The active invite matching the user's input, or null (never distinguishes "wrong" from "expired"). */
  check(input: string, now = Date.now()): InviteRow | null {
    const code = normaliseCrockford(input);
    if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(code)) return null;
    const row = this.db
      .select()
      .from(inviteCodes)
      .where(and(eq(inviteCodes.codeHash, sha256Hex(code)), isNull(inviteCodes.revokedAt)))
      .get();
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt <= now) return null;
    if (row.maxUses !== null && row.uses >= row.maxUses) return null;
    return row;
  }

  isActive(id: string, now = Date.now()): boolean {
    const row = this.db.select().from(inviteCodes).where(eq(inviteCodes.id, id)).get();
    if (!row || row.revokedAt !== null) return false;
    if (row.expiresAt !== null && row.expiresAt <= now) return false;
    return row.maxUses === null || row.uses < row.maxUses;
  }

  consume(id: string): void {
    const row = this.db.select().from(inviteCodes).where(eq(inviteCodes.id, id)).get();
    if (row)
      this.db
        .update(inviteCodes)
        .set({ uses: row.uses + 1 })
        .where(eq(inviteCodes.id, id))
        .run();
  }

  active(now = Date.now()): InviteRow[] {
    return this.db
      .select()
      .from(inviteCodes)
      .where(isNull(inviteCodes.revokedAt))
      .all()
      .filter((r) => r.expiresAt === null || r.expiresAt > now);
  }

  revokeAll(now = Date.now()): number {
    const res = this.db
      .update(inviteCodes)
      .set({ revokedAt: now })
      .where(isNull(inviteCodes.revokedAt))
      .run();
    return res.changes;
  }

  update(id: string, patch: { expiresAt?: number | null; maxUses?: number | null }): void {
    // Nothing to change is not an error (an UPDATE with nothing to SET would be one: a 500 for an empty policy).
    if (Object.keys(patch).length === 0) return;
    this.db.update(inviteCodes).set(patch).where(eq(inviteCodes.id, id)).run();
  }
}
