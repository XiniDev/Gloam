import { randomBytes } from "node:crypto";
import { type ErrorCode, GloamError } from "@gloam/shared/protocol";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { safeEqual } from "../auth/crypto.ts";
import { clientIp, isHttpsRequest, isLocalRequest } from "../auth/localOnly.ts";
import type { VerifiedSession } from "../auth/sessions.ts";
import type { ServerContext } from "../context.ts";
import { parseCookies } from "../rooms/dispatch.ts";

export interface GloamReq {
  ip: string;
  local: boolean;
  https: boolean;
  nonce: string;
  cookies: Record<string, string>;
  auth: VerifiedSession | null;
}

declare global {
  namespace Express {
    interface Request {
      gloam: GloamReq;
    }
  }
}

export const COOKIE = { sid: "gloam_sid", dev: "gloam_dev", csrf: "gloam_csrf", join: "gloam_join" } as const;
const DAY = 24 * 3600_000;

export function requestContext(ctx: ServerContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const peer = req.socket.remoteAddress;
    const cookies = parseCookies(req.headers.cookie);
    req.gloam = {
      ip: clientIp(peer, req.headers),
      local: isLocalRequest(peer, req.headers),
      https: isHttpsRequest((req.socket as { encrypted?: boolean }).encrypted === true, peer, req.headers),
      nonce: randomBytes(16).toString("base64"),
      cookies,
      auth: ctx.sessions.verify(cookies[COOKIE.sid]),
    };
    res.locals.nonce = req.gloam.nonce;
    next();
  };
}

export function setCookie(
  req: Request,
  res: Response,
  name: string,
  value: string,
  opts: { maxAgeMs?: number; httpOnly?: boolean; sameSite?: "lax" | "strict" } = {},
): void {
  res.cookie(name, value, {
    httpOnly: opts.httpOnly ?? true,
    sameSite: opts.sameSite ?? "lax",
    secure: req.gloam.https,
    path: "/",
    ...(opts.maxAgeMs !== undefined ? { maxAge: opts.maxAgeMs } : {}),
  });
}

export function clearCookie(req: Request, res: Response, name: string): void {
  res.clearCookie(name, { path: "/", secure: req.gloam.https, sameSite: "lax" });
}

/** CSRF token bound to the session (double-submit, SPEC §22.2): HMAC of the session id with secret.key. */
export function csrfFor(ctx: ServerContext, sessionId: string): string {
  return ctx.secret.hmac("csrf", sessionId);
}

/** Issues gloam_sid (+ gloam_csrf) for a new or rotated session token. */
export function issueSessionCookies(
  ctx: ServerContext,
  req: Request,
  res: Response,
  token: string,
  sessionId: string,
  kind: "admin" | "player",
): void {
  setCookie(req, res, COOKIE.sid, token, { maxAgeMs: kind === "admin" ? 7 * DAY : 30 * DAY });
  setCookie(req, res, COOKIE.csrf, csrfFor(ctx, sessionId), { httpOnly: false, sameSite: "strict" });
}

export function issueDeviceCookie(req: Request, res: Response, token: string): void {
  setCookie(req, res, COOKIE.dev, token, { maxAgeMs: 400 * DAY });
}

/** True when `Origin` (if present) names this server's own host. */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === (req.headers.host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF + Origin guard (AC-SEC-02). Cookie-authenticated state changes need a matching `x-gloam-csrf` header
 * bound to the session and an allowed Origin. Anonymous state changes (join, setup, login) still need an
 * allowed Origin. Bearer-token requests carrying no cookies are exempt (they can't be forged cross-site).
 */
export function csrfGuard(ctx: ServerContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!UNSAFE.has(req.method)) return next();
    if (req.path === "/api/csp-report") return next();
    const hasCookies = Object.keys(req.gloam.cookies).length > 0;
    const bearer =
      typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ");
    if (bearer && !hasCookies) return next();
    if (!originAllowed(req)) return sendError(res, 403, "FORBIDDEN", "Cross-origin request refused.");
    const auth = req.gloam.auth;
    if (auth) {
      const header = req.headers["x-gloam-csrf"];
      const expected = csrfFor(ctx, auth.session.id);
      if (
        typeof header !== "string" ||
        !safeEqual(header, expected) ||
        req.gloam.cookies[COOKIE.csrf] !== header
      ) {
        return sendError(res, 403, "FORBIDDEN", "Missing or invalid CSRF token.");
      }
    }
    next();
  };
}

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_YOUR_TURN: 409,
  MOVEMENT_LOCKED: 409,
  SPEED_ZERO: 409,
  OVER_BUDGET: 409,
  BLOCKED: 409,
  INVALID: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  LOCKED_SHEET: 423,
  RATE_LIMITED: 429,
  TABLE_CLOSED: 409,
};

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  detail?: unknown,
): void {
  if (res.headersSent) return;
  res.status(status).json({ error: { code, message, ...(detail === undefined ? {} : { detail }) } });
}

export function ok(res: Response, data: unknown = {}): void {
  res.json({ data });
}

/** Wraps an async route: GloamError → its status; zod errors → 400 INVALID; anything else → 500. */
export function route(fn: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof GloamError)
        return sendError(res, STATUS[err.code], err.code, err.message, err.detail);
      if (err instanceof z.ZodError) {
        const i = err.issues[0];
        return sendError(
          res,
          400,
          "INVALID",
          i ? `${i.path.join(".") || "body"}: ${i.message}` : "Invalid request.",
        );
      }
      next(err);
    }
  };
}

/** Parses a strict zod body. */
export function body<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  return schema.parse(req.body ?? {});
}

export function requireLocal(ctx: ServerContext, req: Request): void {
  if (!req.gloam.local) {
    ctx.security.record("localonly.refused", { ip: req.gloam.ip, detail: { path: req.path } });
    throw new GloamError("FORBIDDEN", "This page only works on the host PC.");
  }
}

export function requireAdmin(req: Request): VerifiedSession {
  const a = req.gloam.auth;
  if (a?.session.kind !== "admin" || !a.user.isAdmin)
    throw new GloamError("UNAUTHENTICATED", "Admin sign-in required.");
  return a;
}

export function requireSession(req: Request): VerifiedSession {
  const a = req.gloam.auth;
  if (!a) throw new GloamError("UNAUTHENTICATED");
  return a;
}
