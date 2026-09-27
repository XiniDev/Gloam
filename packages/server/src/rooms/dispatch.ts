import type { Client } from "@colyseus/core";
import { GloamError, type RateSpec, type Rejection } from "@gloam/shared/protocol";
import type { z } from "zod";
import { TokenBucket } from "../auth/rateLimit.ts";
import type { Logger } from "../logger.ts";
import { CLOSE } from "./registry.ts";

/** `client.auth` for both rooms. Never a key named `sessionId` (R3 deviation 3). */
export interface ClientAuth {
  userId: string;
  authSessionId: string;
  role: "admin" | "dm" | "player" | "spectator";
  name: string;
  color: string;
  ip: string;
  watcher?: boolean;
  /** Table room only: the campaign this auth was issued for. */
  campaignId?: string;
}

export interface HandlerCtx {
  client: Client;
  auth: ClientAuth;
}

export interface MessageDef<S extends z.ZodType> {
  schema: S;
  rate: RateSpec;
  handle: (ctx: HandlerCtx, payload: z.infer<S>) => unknown;
}

export function def<S extends z.ZodType>(
  schema: S,
  rate: RateSpec,
  handle: (ctx: HandlerCtx, payload: z.infer<S>) => unknown,
): MessageDef<S> {
  return { schema, rate, handle };
}

interface Abuse {
  bursts: number[];
}

/**
 * Builds Colyseus `messages` handlers: per-user token buckets per message type (§13.5), strict zod parsing
 * inside the handler (never Colyseus's validator, R3 deviation 10), GloamError → `ctx.reject({code,message})`.
 * A client that trips a limit three times within 60 s is disconnected with a warning (§13.5 abuse handling).
 */
export function buildHandlers(
  defs: Record<string, MessageDef<z.ZodType>>,
  log: Logger,
  onRateLimited?: (client: Client, type: string) => void,
): Record<string, (client: Client, payload: unknown, mctx: { reject: (r: unknown) => unknown }) => unknown> {
  const buckets = new Map<string, TokenBucket>();
  const abuse = new WeakMap<Client, Abuse>();
  const out: Record<
    string,
    (client: Client, payload: unknown, mctx: { reject: (r: unknown) => unknown }) => unknown
  > = {};
  for (const [type, d] of Object.entries(defs)) {
    out[type] = async (client, payload, mctx) => {
      const auth = client.auth as ClientAuth | undefined;
      if (!auth)
        return mctx.reject({ code: "UNAUTHENTICATED", message: "Not signed in." } satisfies Rejection);
      const key = `${auth.userId}:${type}`;
      let b = buckets.get(key);
      if (!b) {
        b = new TokenBucket(d.rate.capacity, d.rate.perSecond);
        buckets.set(key, b);
      }
      if (!b.take()) {
        const a = abuse.get(client) ?? { bursts: [] };
        const now = Date.now();
        a.bursts = a.bursts.filter((t) => now - t < 60_000);
        if (a.bursts.length === 0 || now - (a.bursts.at(-1) ?? 0) > 1000) a.bursts.push(now);
        abuse.set(client, a);
        onRateLimited?.(client, type);
        if (a.bursts.length >= 3) {
          client.send("toast", {
            kind: "warning",
            message: "Too many actions too quickly — reconnecting you.",
          });
          setTimeout(() => client.leave(CLOSE.rateLimited), 50);
        }
        return mctx.reject({ code: "RATE_LIMITED", message: "Slow down a little." } satisfies Rejection);
      }
      const parsed = d.schema.safeParse(payload);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return mctx.reject({
          code: "INVALID",
          message: issue ? `${issue.path.join(".") || "payload"}: ${issue.message}` : "Invalid message.",
        } satisfies Rejection);
      }
      try {
        const res = await d.handle({ client, auth }, parsed.data);
        return res === undefined ? { ok: true } : res;
      } catch (err) {
        if (err instanceof GloamError) return mctx.reject(err.toRejection());
        log.error({ err, type }, "message handler failed");
        return mctx.reject({
          code: "INVALID",
          message: "Something went wrong on the server.",
        } satisfies Rejection);
      }
    };
  }
  return out;
}

/** Parses a Cookie header into a map (no decoding surprises: values are opaque tokens). */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Same-origin check for Colyseus routes that bypass Express (R3 deviation 2). Absent Origin = non-browser. */
export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  const host = headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
