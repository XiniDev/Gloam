import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
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

export class SecurityLog {
  private readonly db: Db;
  private readonly log: Logger;
  constructor(db: Db, log: Logger) {
    this.db = db;
    this.log = log;
  }

  record(
    event: SecurityEvent,
    opts: { userId?: string | null; ip?: string | null; detail?: Record<string, unknown> } = {},
  ): void {
    const detail: Record<string, unknown> = {};
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
