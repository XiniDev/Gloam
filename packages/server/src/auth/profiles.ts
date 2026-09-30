import { PLAYER_COLORS } from "@gloam/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { devices, users } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { hashSecret, verifySecret } from "./passwords.ts";
import { AttemptLimiter } from "./rateLimit.ts";

export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;

/** NFC-normalise, strip control characters, collapse whitespace (SPEC §22.6). */
export function sanitizeDisplayName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\p{Cc}|\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 2–24 characters; letters, digits, spaces and -'_. (SPEC §8.2). */
export function validDisplayName(name: string): boolean {
  return /^[\p{L}\p{M}\p{N} \-'_.]{2,24}$/u.test(name) && [...name].length >= 2 && [...name].length <= 24;
}

export function validPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

export const PLAYER_COLOR_IDS = PLAYER_COLORS.map((c) => c.id) as string[];

/** "Chrome on Windows" style label from a User-Agent (SPEC §8.2 knock card). */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? "";
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /Firefox\//.test(s)
        ? "Firefox"
        : /Chrome\//.test(s)
          ? "Chrome"
          : /Safari\//.test(s)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad|iPod/.test(s)
    ? /iPad/.test(s)
      ? "iPad"
      : "iPhone"
    : /Android/.test(s)
      ? "Android"
      : /Windows/.test(s)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(s)
          ? "macOS"
          : /CrOS/.test(s)
            ? "ChromeOS"
            : /Linux/.test(s)
              ? "Linux"
              : "unknown OS";
  return `${browser} on ${os}`;
}

export class ProfileService {
  private readonly db: Db;
  /** 5 wrong PINs lock that profile's PIN entry for 15 minutes (AC-AUTH-04). */
  readonly pinLimiter = new AttemptLimiter({ max: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 });

  constructor(db: Db) {
    this.db = db;
  }

  get(id: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  admin(): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.isAdmin, true)).get();
  }

  async create(opts: {
    displayName: string;
    color: string;
    pin?: string | null;
    isAdmin?: boolean;
  }): Promise<UserRow> {
    const now = Date.now();
    const row: UserRow = {
      id: newId("usr"),
      displayName: sanitizeDisplayName(opts.displayName),
      color: opts.color,
      pinHash: opts.pin ? await hashSecret(opts.pin) : null,
      isAdmin: opts.isAdmin ?? false,
      createdAt: now,
      lastSeenAt: now,
      bannedAt: null,
      banReason: null,
      diceSkinJson: "{}",
      prefsJson: "{}",
      deletedAt: null,
    };
    this.db.insert(users).values(row).run();
    return row;
  }

  /** Profiles offered under "I've played before": name, colour and whether a PIN exists — nothing else. */
  listReturning(): { id: string; displayName: string; color: string; hasPin: boolean }[] {
    return this.db
      .select()
      .from(users)
      .where(and(eq(users.isAdmin, false), isNull(users.deletedAt), isNull(users.bannedAt)))
      .all()
      .map((u) => ({ id: u.id, displayName: u.displayName, color: u.color, hasPin: u.pinHash !== null }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  all(): UserRow[] {
    return this.db.select().from(users).where(isNull(users.deletedAt)).all();
  }

  /** PIN check with the per-profile lockout. */
  async verifyPin(userId: string, pin: string): Promise<"ok" | "wrong" | "locked" | "nopin"> {
    if (this.pinLimiter.lockedFor(userId) > 0) return "locked";
    const u = this.get(userId);
    if (!u || u.deletedAt !== null) return "wrong";
    if (!u.pinHash) return "nopin";
    if (validPin(pin) && (await verifySecret(u.pinHash, pin))) {
      this.pinLimiter.succeed(userId);
      return "ok";
    }
    const r = this.pinLimiter.fail(userId);
    return r.locked ? "locked" : "wrong";
  }

  async setPin(userId: string, pin: string | null): Promise<void> {
    this.db
      .update(users)
      .set({ pinHash: pin ? await hashSecret(pin) : null })
      .where(eq(users.id, userId))
      .run();
    // A new PIN is asked of every browser: those recognised before it was set show it too (banned ones stay banned).
    if (pin)
      this.db
        .delete(devices)
        .where(and(eq(devices.userId, userId), isNull(devices.bannedAt)))
        .run();
  }

  /** A browser admitted as the profile it claimed (an unverified claim the Admin or a DM let in). */
  confirmDevice(deviceId: string): void {
    this.db.update(devices).set({ confirmed: true }).where(eq(devices.id, deviceId)).run();
  }

  /** Bans one browser (an unverified claim turned away: the profile it named isn't its to lose). */
  banDevice(deviceId: string): void {
    this.db.update(devices).set({ bannedAt: Date.now() }).where(eq(devices.id, deviceId)).run();
  }

  update(
    userId: string,
    patch: Partial<Pick<UserRow, "displayName" | "color" | "diceSkinJson" | "prefsJson">>,
  ): void {
    const p = { ...patch };
    if (p.displayName !== undefined) p.displayName = sanitizeDisplayName(p.displayName);
    this.db.update(users).set(p).where(eq(users.id, userId)).run();
  }

  // ── devices ────────────────────────────────────────────────────────────────────────────────────────────

  newDeviceToken(): string {
    return randomToken(32);
  }

  /**
   * Records a browser (gloam_dev cookie) with a profile; returns the device row. `confirmed`: it has shown it's the
   * profile's (made it, knew its PIN, was recognised already). An unverified claim is recorded unconfirmed — never
   * recognised as the profile — until the Admin or a DM admits it (`confirmDevice`): it tied an impostor's browser to a
   * PIN-less profile before anyone looked (security review H2). A confirmed row is never made unconfirmed again.
   */
  linkDevice(userId: string, deviceToken: string, label: string, confirmed = true): DeviceRow {
    const hash = sha256Hex(deviceToken);
    const now = Date.now();
    const existing = this.db
      .select()
      .from(devices)
      .where(and(eq(devices.deviceHash, hash), eq(devices.userId, userId)))
      .get();
    if (existing) {
      const set = { lastSeenAt: now, label, confirmed: existing.confirmed || confirmed };
      this.db.update(devices).set(set).where(eq(devices.id, existing.id)).run();
      return { ...existing, ...set };
    }
    const row: DeviceRow = {
      id: newId("dev"),
      userId,
      deviceHash: hash,
      label,
      createdAt: now,
      lastSeenAt: now,
      bannedAt: null,
      confirmed,
    };
    this.db.insert(devices).values(row).run();
    return row;
  }

  /** The profile this browser most recently used, if it isn't banned or deleted. */
  profileForDevice(deviceToken: string | undefined): UserRow | null {
    if (!deviceToken) return null;
    const rows = this.db
      .select()
      .from(devices)
      .where(eq(devices.deviceHash, sha256Hex(deviceToken)))
      .all();
    const sorted = rows.filter((d) => d.confirmed).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const d of sorted) {
      const u = this.get(d.userId);
      if (u && !u.deletedAt && !u.bannedAt && !u.isAdmin) return u;
    }
    return null;
  }

  deviceBanned(deviceToken: string | undefined): boolean {
    if (!deviceToken) return false;
    return this.db
      .select()
      .from(devices)
      .where(eq(devices.deviceHash, sha256Hex(deviceToken)))
      .all()
      .some((d) => d.bannedAt !== null);
  }

  devicesFor(userId: string): DeviceRow[] {
    return this.db.select().from(devices).where(eq(devices.userId, userId)).all();
  }

  /** Ban blocks the profile and every device associated with it (SPEC §8.2). */
  ban(userId: string, reason: string | null): void {
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.update(users).set({ bannedAt: now, banReason: reason }).where(eq(users.id, userId)).run();
      tx.update(devices).set({ bannedAt: now }).where(eq(devices.userId, userId)).run();
      const hashes = tx
        .select()
        .from(devices)
        .where(eq(devices.userId, userId))
        .all()
        .map((d) => d.deviceHash);
      for (const h of hashes)
        tx.update(devices).set({ bannedAt: now }).where(eq(devices.deviceHash, h)).run();
    });
  }

  unban(userId: string): void {
    this.db.transaction((tx) => {
      tx.update(users).set({ bannedAt: null, banReason: null }).where(eq(users.id, userId)).run();
      const hashes = tx
        .select()
        .from(devices)
        .where(eq(devices.userId, userId))
        .all()
        .map((d) => d.deviceHash);
      for (const h of hashes)
        tx.update(devices).set({ bannedAt: null }).where(eq(devices.deviceHash, h)).run();
    });
  }

  softDelete(userId: string): void {
    this.db.update(users).set({ deletedAt: Date.now() }).where(eq(users.id, userId)).run();
  }
}
