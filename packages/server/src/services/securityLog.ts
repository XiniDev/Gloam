import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { securityLog } from "../db/schema.ts";
import type { Logger } from "../logger.ts";

/** Security events (SPEC §8.20 Security log, AC-ADM-04). Details must never contain secrets. */
export type SecurityEvent =
  | "admin.setup"
  | "admin.login"
  | "admin.login.failed"
  | "admin.magic"
  | "admin.logout"
  | "admin.password.reset"
  | "join.code.failed"
  | "join.code.ok"
  | "join.ratelimited"
  | "join.pin.failed"
  | "join.pin.locked"
  | "knock"
  | "knock.autoadmit"
  | "knock.autodeny"
  | "admit"
  | "deny"
  | "kick"
  | "ban"
  | "unban"
  | "invite.create"
  | "invite.rotate"
  | "invite.revoke"
  | "invite.lock"
  | "table.open"
  | "table.close"
  | "api.token.create"
  | "api.token.revoke"
  | "api.token.use"
  | "api.token.refused"
  | "upload.rejected"
  | "csp.violation"
  | "ws.ratelimited"
  | "localonly.refused"
  | "settings.change"
  | "profile.update"
  | "profile.delete";

export interface SecurityLogEntry {
  id: number;
  event: string;
  userId: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
  createdAt: number;
}

const FORBIDDEN_DETAIL_KEYS = /pass|pin|token|code|secret|cookie|hash/i;

/**
 * Events anyone can cause over and over (refusals and failures): the same one from the same address is written once a
 * minute, the repeats counted into the next (`repeats`) — a script hammering /setup filled the database and buried the
 * events that matter (security review M5). Admissions, bans and every other decision are each written.
 */
const COALESCED: ReadonlySet<SecurityEvent> = new Set<SecurityEvent>([
  "admin.login.failed",
  "join.code.failed",
  "join.ratelimited",
  "join.pin.failed",
  "api.token.refused",
  "upload.rejected",
  "csp.violation",
  "ws.ratelimited",
  "localonly.refused",
]);
const COALESCE_MS = 60_000;
/** How long the log keeps an event, and at most how many it keeps (the oldest go first). */
export const SECURITY_LOG_RETENTION = { days: 180, rows: 50_000 } as const;

export class SecurityLog {
  private readonly db: Db;
  private readonly log: Logger;
  constructor(db: Db, log: Logger) {
    this.db = db;
    this.log = log;
  }

  /** Per coalesced (event, address, profile, details): until when the next one is folded in, and how many were. */
  private readonly quiet = new Map<string, { until: number; repeats: number }>();

  record(
    event: SecurityEvent,
    opts: { userId?: string | null; ip?: string | null; detail?: Record<string, unknown> } = {},
  ): void {
    let repeats = 0;
    if (COALESCED.has(event)) {
      const now = Date.now();
      // (The same event: from the same address and profile, with the same details — a refusal for another reason is
      // another event.)
      const key = `${event}|${opts.ip ?? ""}|${opts.userId ?? ""}|${JSON.stringify(opts.detail ?? {})}`;
      const q = this.quiet.get(key);
      if (q && now < q.until) {
        q.repeats++;
        return;
      }
      repeats = q?.repeats ?? 0;
      this.quiet.set(key, { until: now + COALESCE_MS, repeats: 0 });
      if (this.quiet.size > 10_000)
        for (const [k, v] of this.quiet) if (v.until < now && v.repeats === 0) this.quiet.delete(k);
    }
    const detail: Record<string, unknown> = repeats ? { repeats } : {};
    for (const [k, v] of Object.entries(opts.detail ?? {})) {
      // Defence in depth: a caller mistake must not write a secret into the log.
      detail[k] = FORBIDDEN_DETAIL_KEYS.test(k) ? "[redacted]" : v;
    }
    this.db
      .insert(securityLog)
      .values({
        event,
        userId: opts.userId ?? null,
        ip: opts.ip ?? null,
        detailJson: JSON.stringify(detail),
        createdAt: Date.now(),
      })
      .run();
    this.log.info(
      { security: event, userId: opts.userId ?? undefined, ip: opts.ip ?? undefined },
      "security event",
    );
  }

  /** Drops what's older than the retention, and the oldest beyond its size (the daily housekeeping runs it). */
  prune(now = Date.now()): number {
    const byAge = this.db
      .delete(securityLog)
      .where(lt(securityLog.createdAt, now - SECURITY_LOG_RETENTION.days * 86_400_000))
      .run().changes;
    const newest = this.db
      .select({ id: securityLog.id })
      .from(securityLog)
      .orderBy(desc(securityLog.id))
      .limit(1)
      .offset(SECURITY_LOG_RETENTION.rows)
      .get();
    const bySize = newest
      ? this.db.delete(securityLog).where(lte(securityLog.id, newest.id)).run().changes
      : 0;
    return byAge + bySize;
  }

  list(opts: { event?: string; before?: number; since?: number; limit?: number } = {}): SecurityLogEntry[] {
    const where: SQL[] = [];
    if (opts.event) where.push(eq(securityLog.event, opts.event));
    if (opts.before) where.push(lt(securityLog.id, opts.before));
    if (opts.since) where.push(gte(securityLog.createdAt, opts.since));
    const rows = this.db
      .select()
      .from(securityLog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(securityLog.id))
      .limit(Math.min(opts.limit ?? 200, 1000))
      .all();
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      userId: r.userId,
      ip: r.ip,
      detail: JSON.parse(r.detailJson) as Record<string, unknown>,
      createdAt: r.createdAt,
    }));
  }
}
