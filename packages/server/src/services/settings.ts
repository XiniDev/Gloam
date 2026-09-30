import { eq } from "drizzle-orm";
import { z } from "zod";
import type { SecretBox } from "../auth/crypto.ts";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";

/** UI-managed settings (SPEC §8.20 Settings, Appendix J). Stored one key per row as JSON. */
export const SettingsSchema = z
  .object({
    tunnelMode: z.enum(["quick", "named", "lan", "local"]).default("quick"),
    /** AES-256-GCM box (secret.key); never returned to clients in clear. */
    tunnelTokenBox: z.string().nullable().default(null),
    publicHostname: z.string().max(253).nullable().default(null),
    cloudflaredPath: z.string().max(1024).nullable().default(null),
    port: z.number().int().min(1).max(65535).nullable().default(null),
    lanConfirmed: z.boolean().default(false),
    autoAdmitReturning: z.boolean().default(false),
    dmsCanAdmit: z.boolean().default(true),
    autoApproveImages: z.boolean().default(false),
    allowAdminThroughDoorway: z.boolean().default(false),
    allowRemoteApi: z.boolean().default(false),
    selectedCampaignId: z.string().nullable().default(null),
    inviteExpiry: z.enum(["close", "2h", "4h", "8h"]).default("close"),
    inviteMaxUses: z.number().int().min(1).max(1000).nullable().default(null),
    newCampaignDefaults: z
      .object({
        rulesPack: z.enum(["srd-5.2.1", "srd-5.1"]).default("srd-5.2.1"),
        units: z.enum(["ft", "m"]).default("ft"),
      })
      .default({ rulesPack: "srd-5.2.1", units: "ft" }),
    checklist: z
      .object({ cloudflaredSeen: z.boolean().default(false), tableOpened: z.boolean().default(false) })
      .default({ cloudflaredSeen: false, tableOpened: false }),
    lastBackupDay: z.string().nullable().default(null),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingKey = keyof Settings;

/** Settings that only a request from the host PC may change (SPEC §8.20, §22.3). */
export const LOCAL_ONLY_SETTINGS: ReadonlySet<SettingKey> = new Set([
  "port",
  "tunnelMode",
  "tunnelTokenBox",
  "publicHostname",
  "cloudflaredPath",
  "lanConfirmed",
  // API tokens answering from anywhere but this computer: widened only from this computer (SPEC §8.23).
  "allowRemoteApi",
]);

export class SettingsService {
  private cache: Settings;
  private readonly db: Db;
  private readonly secret: SecretBox;
  private readonly listeners = new Set<(s: Settings, changed: SettingKey[]) => void>();

  constructor(db: Db, secret: SecretBox) {
    this.db = db;
    this.secret = secret;
    const rows = db.select().from(settings).all();
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.valueJson);
      } catch {
        // a corrupt row falls back to the default
      }
    }
    const known = Object.fromEntries(Object.entries(raw).filter(([k]) => k in SettingsSchema.shape));
    const parsed = SettingsSchema.safeParse(known);
    this.cache = parsed.success ? parsed.data : SettingsSchema.parse({});
  }

  get(): Readonly<Settings> {
    return this.cache;
  }

  update(patch: Partial<Settings>): Settings {
    const next = SettingsSchema.parse({ ...this.cache, ...patch });
    const changed = (Object.keys(patch) as SettingKey[]).filter(
      (k) => JSON.stringify(this.cache[k]) !== JSON.stringify(next[k]),
    );
    this.db.transaction((tx) => {
      for (const k of changed) {
        const valueJson = JSON.stringify(next[k]);
        tx.insert(settings)
          .values({ key: k, valueJson })
          .onConflictDoUpdate({ target: settings.key, set: { valueJson } })
          .run();
      }
    });
    this.cache = next;
    if (changed.length > 0) for (const l of this.listeners) l(next, changed);
    return next;
  }

  onChange(fn: (s: Settings, changed: SettingKey[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setTunnelToken(token: string | null): void {
    this.update({ tunnelTokenBox: token ? this.secret.encrypt(token) : null });
  }

  /** The decrypted named-tunnel token; only the tunnel manager should call this. */
  tunnelToken(): string | null {
    const box = this.cache.tunnelTokenBox;
    return box ? this.secret.decrypt(box) : null;
  }

  /** Public view: the token is masked, never returned in full after saving (AC-HOST-08). */
  publicView(): Omit<Settings, "tunnelTokenBox"> & { tunnelToken: string | null } {
    const { tunnelTokenBox: _box, ...rest } = this.cache;
    const token = this.tunnelToken();
    return { ...rest, tunnelToken: token ? maskSecret(token) : null };
  }

  remove(key: SettingKey): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}

export function maskSecret(s: string): string {
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••••••${s.slice(-4)}`;
}
