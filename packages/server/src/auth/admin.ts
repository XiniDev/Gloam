import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { admin } from "../db/schema.ts";
import { randomToken, safeEqual, sha256Hex } from "./crypto.ts";
import { hashSecret, verifySecret } from "./passwords.ts";

export const SETUP_TOKEN_MS = 30 * 60_000;
export const MAGIC_TOKEN_MS = 10 * 60_000;
export const MIN_PASSWORD = 12;

interface OneTime {
  hash: string;
  expiresAt: number;
  used: boolean;
}

/**
 * The single Admin credential and the one-time bootstrap links (SPEC §8.1): `/setup?token=…` (30 min) on first
 * run and `/admin/magic?token=…` (10 min) otherwise. Tokens live only in memory, hashed, single use.
 */
export class AdminAuth {
  private readonly db: Db;
  private setupToken: OneTime | null = null;
  private magicTokens: OneTime[] = [];

  constructor(db: Db) {
    this.db = db;
  }

  hasPassword(): boolean {
    return this.db.select().from(admin).where(eq(admin.id, 1)).get() !== undefined;
  }

  async setPassword(password: string): Promise<void> {
    if (password.length < MIN_PASSWORD)
      throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
    const now = Date.now();
    const passwordHash = await hashSecret(password);
    this.db
      .insert(admin)
      .values({ id: 1, passwordHash, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: admin.id, set: { passwordHash, updatedAt: now } })
      .run();
  }

  async verifyPassword(password: string): Promise<boolean> {
    const row = this.db.select().from(admin).where(eq(admin.id, 1)).get();
    if (!row) return false;
    return verifySecret(row.passwordHash, password);
  }

  issueSetupToken(now = Date.now()): string {
    const token = randomToken(24);
    this.setupToken = { hash: sha256Hex(token), expiresAt: now + SETUP_TOKEN_MS, used: false };
    return token;
  }

  issueMagicToken(now = Date.now()): string {
    const token = randomToken(24);
    this.magicTokens = this.magicTokens.filter((t) => !t.used && t.expiresAt > now);
    this.magicTokens.push({ hash: sha256Hex(token), expiresAt: now + MAGIC_TOKEN_MS, used: false });
    return token;
  }

  private check(t: OneTime | null, token: string, now: number): boolean {
    return !!t && !t.used && t.expiresAt > now && safeEqual(t.hash, sha256Hex(token));
  }

  /** Validates without consuming (so the setup page can render before the password is submitted). */
  peekSetup(token: string, now = Date.now()): boolean {
    return !this.hasPassword() && this.check(this.setupToken, token, now);
  }

  consumeSetup(token: string, now = Date.now()): boolean {
    if (!this.peekSetup(token, now) || !this.setupToken) return false;
    this.setupToken.used = true;
    return true;
  }

  consumeMagic(token: string, now = Date.now()): boolean {
    const t = this.magicTokens.find((m) => this.check(m, token, now));
    if (!t) return false;
    t.used = true;
    return true;
  }
}
