import { GloamError } from "@gloam/shared/protocol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomToken, sha256Hex } from "../auth/crypto.ts";
import type { ServerContext } from "../context.ts";
import { apiTokens } from "../db/schema.ts";
import { newId } from "../ids.ts";

/** What an API token may do (SPEC §8.23). */
export const API_SCOPES = [
  "content:read",
  "content:write",
  "sheets:read",
  "sheets:write",
  "log:read",
  "log:write",
  "campaign:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const ApiScope = z.enum(API_SCOPES);

/** A token as the console lists it: never its secret, never its hash. */
export interface ApiTokenInfo {
  id: string;
  name: string;
  scopes: ApiScope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** A token that checked out: who it is and what it may do. */
export interface ApiTokenAuth {
  id: string;
  name: string;
  scopes: ReadonlySet<ApiScope>;
}

/** Tokens start with this, so one pasted somewhere it shouldn't be is recognisable (and scannable) for what it is. */
const PREFIX = "gloam_";
/** A use is written to the Security log at most this often per token (a busy import would flood it otherwise). */
const USE_LOG_MS = 60_000;
/** `last_used_at` is written at most this often per token. */
const TOUCH_MS = 60_000;

/**
 * API tokens (SPEC §8.23; AC-API-01): made in Admin → API & MCP with a name and scopes, the secret shown once and only
 * its SHA-256 kept; revoked there. The secret is 32 random bytes — a hash lookup is safe against guessing, and
 * failures are rate-limited per IP besides (the routes). Every make, revoke, use (once a minute a token) and refusal
 * is in the Security log (AC-ADM-04), without the secret.
 */
export class ApiTokenService {
  private readonly ctx: ServerContext;
  private readonly lastLogged = new Map<string, number>();
  private readonly lastTouched = new Map<string, number>();

  constructor(ctx: ServerContext) {
    this.ctx = ctx;
  }

  list(): ApiTokenInfo[] {
    return this.ctx.db
      .select()
      .from(apiTokens)
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        scopes: parseScopes(r.scopesJson),
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** A new token: its secret (shown this once) and how it's listed. */
  create(
    name: string,
    scopes: ApiScope[],
    by: { userId: string; ip: string },
  ): { token: string; info: ApiTokenInfo } {
    const clean = [...new Set(scopes)].filter((s) => (API_SCOPES as readonly string[]).includes(s));
    if (!clean.length) throw new GloamError("INVALID", "Give the token at least one scope.");
    const token = `${PREFIX}${randomToken(32)}`;
    const row = {
      id: newId("tok"),
      name: name.trim(),
      tokenHash: sha256Hex(token),
      scopesJson: JSON.stringify(clean),
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.ctx.db.insert(apiTokens).values(row).run();
    this.ctx.security.record("api.token.create", {
      userId: by.userId,
      ip: by.ip,
      detail: { name: row.name, scopes: clean },
    });
    return {
      token,
      info: {
        id: row.id,
        name: row.name,
        scopes: clean,
        createdAt: row.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      },
    };
  }

  revoke(id: string, by: { userId: string; ip: string }): void {
    const row = this.ctx.db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    if (!row) throw new GloamError("NOT_FOUND", "No such token.");
    if (row.revokedAt) return;
    this.ctx.db.update(apiTokens).set({ revokedAt: Date.now() }).where(eq(apiTokens.id, id)).run();
    this.ctx.security.record("api.token.revoke", {
      userId: by.userId,
      ip: by.ip,
      detail: { name: row.name },
    });
  }

  /** The token a bearer secret is, if it's one that stands (not revoked). */
  verify(secret: string): ApiTokenAuth | null {
    if (!secret.startsWith(PREFIX) || secret.length > 200) return null;
    const row = this.ctx.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, sha256Hex(secret)))
      .get();
    if (!row || row.revokedAt) return null;
    return { id: row.id, name: row.name, scopes: new Set(parseScopes(row.scopesJson)) };
  }

  /** A use: when it was last used, and (once a minute a token) the Security log. */
  used(t: ApiTokenAuth, req: { ip: string; method: string; path: string }): void {
    const now = Date.now();
    if (now - (this.lastTouched.get(t.id) ?? 0) >= TOUCH_MS) {
      this.lastTouched.set(t.id, now);
      this.ctx.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, t.id)).run();
    }
    if (now - (this.lastLogged.get(t.id) ?? 0) >= USE_LOG_MS) {
      this.lastLogged.set(t.id, now);
      this.ctx.security.record("api.token.use", {
        ip: req.ip,
        detail: { name: t.name, request: `${req.method} ${req.path}` },
      });
    }
  }
}

function parseScopes(json: unknown): ApiScope[] {
  const parsed = z.array(z.string()).safeParse(typeof json === "string" ? JSON.parse(json) : json);
  return parsed.success
    ? (parsed.data.filter((s) => (API_SCOPES as readonly string[]).includes(s)) as ApiScope[])
    : [];
}
