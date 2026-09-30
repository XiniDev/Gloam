import { GloamError } from "@gloam/shared/protocol";
import {
  CampaignLogEntrySchema,
  IMPORT_SCHEMA_NAMES,
  importJsonSchema,
  type Sheet,
  type Spell,
} from "@gloam/shared/schemas";
import { eq } from "drizzle-orm";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AttemptLimiter } from "../../auth/rateLimit.ts";
import type { ServerContext } from "../../context.ts";
import { actors } from "../../db/schema.ts";
import type { CommandActor } from "../../engine/commandBus.ts";
import { readSheet } from "../../engine/commands/actor.ts";
import type { ImportReport } from "../../engine/commands/content.ts";
import type { ActorImportReport, MonsterImportReport } from "../../engine/commands/imports.ts";
import type { ApiScope, ApiTokenAuth } from "../../services/apiTokens.ts";
import { campaignBus, campaignModel } from "../campaignBus.ts";
import { route } from "../helpers.ts";

/**
 * The local REST API, v1 (SPEC §8.23, §26.1; AC-API-01/02/03): what Xini's own Claude uses through the MCP server
 * (packages/mcp) — and what the web client's imports use — to import spells, monsters and characters, read sheets and
 * the campaign log, and write recaps into it.
 *
 * Who may call it:
 * - an **API token** (`Authorization: Bearer gloam_…`, made in Admin → API & MCP): its scopes, any campaign. Tokens
 *   work on this computer only — a request from anywhere else (through Cloudflare, over the LAN) is refused unless
 *   Allow remote API is on (AC-API-02). Unknown or revoked tokens are refused, and a caller who keeps trying is slowed.
 * - a **session** (the browser): the Admin, every scope and campaign; the DM of the open table, admitted to this
 *   sitting, every scope for that campaign. No one else.
 *
 * Replies are `{ data }`; imports add `report` — `created`, `updated`, `skipped`, `invalid[{ index, path, message }]`
 * (§26.1) — beside the full report in `data`. Schemas (`/schemas/<name>.json`) are public documents.
 */

/** Paths whose bodies (up to 4 MB) the route reads itself, once the caller is known (app.ts skips its 256-kB parser). */
export const BIG_BODY_PATHS = new Set([
  "/v1/content/spells:import",
  "/v1/content/monsters:import",
  "/v1/actors:import",
]);

/** Whoever is calling. */
type Caller =
  | { via: "token"; token: ApiTokenAuth }
  | { via: "session"; userId: string; name: string; admin: boolean; campaignId: string | null };

const Strategy = z.enum(["skip", "overwrite", "rename"]);
/** "true"/"false" in a query string. */
const QueryBool = z.enum(["true", "false"]).transform((v) => v === "true");

export function apiRoutes(app: Express, ctx: ServerContext): void {
  // A caller whose tokens keep failing is stopped: 10 wrong in a minute locks the IP out for a minute (checked before
  // the token is — a lucky guess while locked out gets nothing).
  const failures = new AttemptLimiter({ max: 10, windowMs: 60_000, lockMs: 60_000 });
  // Refusals are logged once a minute per IP and reason (a script retrying mustn't flood the log).
  const refusedAt = new Map<string, number>();
  const refuse = (
    req: Request,
    reason: string,
    code: "UNAUTHENTICATED" | "FORBIDDEN",
    message: string,
  ): never => {
    const key = `${req.gloam.ip}|${reason}`;
    const now = Date.now();
    if (now - (refusedAt.get(key) ?? 0) >= 60_000) {
      refusedAt.set(key, now);
      ctx.security.record("api.token.refused", {
        ip: req.gloam.ip,
        detail: { reason, request: `${req.method} ${req.path}` },
      });
    }
    throw new GloamError(code, message);
  };

  /** Who's calling, allowed `scope` — or refused. */
  const caller = (req: Request, scope: ApiScope): Caller => {
    const header = req.headers.authorization;
    if (typeof header === "string" && /^Bearer\s/i.test(header)) {
      if (failures.lockedFor(req.gloam.ip) > 0)
        throw new GloamError("RATE_LIMITED", "Too many wrong tokens. Wait a minute.");
      // Host only, unless the Admin allowed otherwise (AC-API-02): a request through Cloudflare (or from the LAN)
      // isn't this computer's.
      if (!req.gloam.local && !ctx.settings.get().allowRemoteApi)
        refuse(
          req,
          "remote",
          "FORBIDDEN",
          "API tokens work on this computer only. To use one from elsewhere, turn on Allow remote API in Admin → API & MCP.",
        );
      const t = ctx.apiTokens.verify(header.replace(/^Bearer\s+/i, "").trim());
      if (!t) {
        failures.fail(req.gloam.ip);
        refuse(req, "unknown", "UNAUTHENTICATED", "That API token isn't known, or it was revoked.");
      }
      const token = t as ApiTokenAuth;
      if (!token.scopes.has(scope))
        refuse(req, "scope", "FORBIDDEN", `This token doesn't have the ${scope} scope. Make one that does.`);
      ctx.apiTokens.used(token, { ip: req.gloam.ip, method: req.method, path: req.path });
      return { via: "token", token };
    }
    const a = req.gloam.auth;
    if (!a) throw new GloamError("UNAUTHENTICATED", "Sign in, or send an API token.");
    if (a.session.kind === "admin" && a.user.isAdmin)
      return { via: "session", userId: a.user.id, name: a.user.displayName, admin: true, campaignId: null };
    // Otherwise the DM of the open table, admitted to this sitting of it — never a pending, denied or kicked session,
    // nor one from an earlier sitting (security review M1).
    const t = ctx.table;
    if (
      !t.isOpen ||
      !t.campaignId ||
      a.session.status !== "admitted" ||
      a.session.tableSessionNo !== t.sessionNo
    )
      throw new GloamError("TABLE_CLOSED");
    if (ctx.campaigns.membership(t.campaignId, a.user.id) !== "dm")
      throw new GloamError("FORBIDDEN", "Only the DM does this.");
    return {
      via: "session",
      userId: a.user.id,
      name: a.user.displayName,
      admin: false,
      campaignId: t.campaignId,
    };
  };

  /** The campaign a call is about: the one it names (if the caller may use it), else the table's or the selected one. */
  const campaignFor = (c: Caller, named: string | undefined): string => {
    if (c.via === "session" && !c.admin) {
      if (named && named !== c.campaignId)
        throw new GloamError("FORBIDDEN", "Only the campaign at the table.");
      return c.campaignId as string;
    }
    const id = named ?? ctx.table.campaignId ?? ctx.settings.get().selectedCampaignId;
    if (!id || !ctx.campaigns.get(id))
      throw new GloamError("NOT_FOUND", "No such campaign. List them first.");
    return id;
  };

  /** Who the change is recorded as: the DM themselves, or the Admin as the token (its name in the history). */
  const actorOf = (c: Caller): CommandActor => {
    if (c.via === "session")
      return { userId: c.userId, role: c.admin ? "admin" : "dm", name: c.name, actingAs: null };
    const admin = ctx.profiles.admin();
    if (!admin) throw new GloamError("CONFLICT", "Set up Gloam first.");
    return { userId: admin.id, role: "admin", name: `${c.token.name} (API)`, actingAs: null };
  };

  /** Reads the caller before a big body is read (never an anonymous caller's 4 MB), then the body. */
  const bigBody =
    (scope: ApiScope) =>
    (req: Request, res: Response, next: NextFunction): void => {
      void route(() => {
        caller(req, scope);
        express.json({ limit: "4mb" })(req, res, next);
      })(req, res, next);
    };

  // ── Schemas: public documents (the AI prompt embeds them) ───────────────────────────────────────────────────────
  for (const name of IMPORT_SCHEMA_NAMES) {
    const doc = JSON.stringify(importJsonSchema(name), null, 2);
    app.get(`/api/v1/schemas/${name}.json`, (_req: Request, res: Response) => {
      res.type("application/schema+json").setHeader("Cache-Control", "public, max-age=3600").send(doc);
    });
  }

  // ── Campaigns ───────────────────────────────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/v1/campaigns",
    route((req, res) => {
      const c = caller(req, "campaign:read");
      const list = ctx.campaigns
        .list(true)
        .filter((x) => c.via === "token" || c.admin || x.id === c.campaignId)
        .map((x) => {
          const scene = x.activeSceneId ? campaignModel(ctx, x.id).get("scene", x.activeSceneId) : undefined;
          return {
            id: x.id,
            name: x.name,
            activeScene: scene ? { id: scene.id, name: scene.name } : null,
            sessionNo: x.sessionNo,
            archived: x.archivedAt !== null,
            atTable: ctx.table.isOpen && ctx.table.campaignId === x.id,
          };
        });
      res.json({ data: list });
    }),
  );

  app.get(
    "/api/v1/campaigns/:id/summary",
    route((req, res) => {
      const c = caller(req, "campaign:read");
      const id = campaignFor(c, String(req.params.id));
      const model = campaignModel(ctx, id);
      const camp = model.campaign;
      const party = model
        .all("actor")
        .filter((a) => a.kind === "character" && a.deletedAt === null)
        .map((a) => {
          const s = readSheet(a).core;
          return {
            actorId: a.id,
            name: s.name,
            player: a.ownerUserId ? (ctx.profiles.get(a.ownerUserId)?.displayName ?? null) : null,
            classes: s.classes.map((k) => `${k.name} ${k.level}`).join(" / "),
            level: s.classes.reduce((n, k) => n + k.level, 0),
            hp: { current: s.hp.current, max: s.hp.max },
            ac: s.ac.value,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const scenes = model
        .all("scene")
        .filter((s) => s.deletedAt === null && s.archivedAt === null)
        .sort((a, b) => a.sort - b.sort)
        .map((s) => ({ id: s.id, name: s.name, active: s.id === camp.activeSceneId }));
      res.json({
        data: {
          id: camp.id,
          name: camp.name,
          sessionNo: camp.sessionNo,
          atTable: ctx.table.isOpen && ctx.table.campaignId === camp.id,
          party,
          scenes,
        },
      });
    }),
  );

  // ── Content ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const SpellQuery = z.strictObject({
    query: z.string().max(80).optional(),
    level: z.coerce.number().int().min(0).max(9).optional(),
    pack: z.enum(["srd-5.2.1", "homebrew"]).optional(),
    campaignId: z.string().min(3).max(40).optional(),
  });
  app.get(
    "/api/v1/content/spells",
    route((req, res) => {
      const c = caller(req, "content:read");
      const q = SpellQuery.parse(req.query);
      // With a campaign: the packs it plays with and its own spells; without, the SRD's alone.
      const campaignId =
        q.campaignId || (c.via === "session" && !c.admin) ? campaignFor(c, q.campaignId) : undefined;
      const model = campaignId ? campaignModel(ctx, campaignId) : null;
      const packs = model?.campaign.settings.packs ?? ["srd-5.2.1"];
      const all: { spell: Spell; pack: string }[] = [
        ...(packs.includes("srd-5.2.1")
          ? ctx.content.spells.map((spell) => ({ spell, pack: "srd-5.2.1" }))
          : []),
        ...(model
          ? model
              .all("content")
              .filter(
                (x) => x.type === "spell" && x.status === "active" && x.campaignId === model.campaign.id,
              )
              .map((x) => ({ spell: x.data as unknown as Spell, pack: "homebrew" }))
          : []),
      ];
      const words = (q.query ?? "").trim().toLowerCase();
      const found = all
        .filter(({ pack }) => (q.pack ? pack === q.pack : true))
        .filter(({ spell }) => (q.level === undefined ? true : spell.level === q.level))
        .filter(({ spell }) => !words || spell.name.toLowerCase().includes(words) || spell.id.includes(words))
        .sort((a, b) => a.spell.level - b.spell.level || a.spell.name.localeCompare(b.spell.name));
      res.json({
        data: found.slice(0, 50).map(({ spell, pack }) => ({
          id: spell.id,
          name: spell.name,
          level: spell.level,
          school: spell.school,
          ritual: spell.ritual,
          concentration: spell.duration.concentration,
          pack,
        })),
        ...(found.length > 50
          ? { errors: [`${found.length} found; the first 50 shown. Narrow the search.`] }
          : {}),
      });
    }),
  );

  /** An import's entries: a list, or `{ <key>: [...] }` (with the web client's own fields beside it). */
  const entries = (b: unknown, key: string): { list: unknown[]; rest: Record<string, unknown> } => {
    if (Array.isArray(b)) return { list: b, rest: {} };
    if (b && typeof b === "object" && Array.isArray((b as Record<string, unknown>)[key])) {
      const { [key]: list, ...rest } = b as Record<string, unknown>;
      return { list: list as unknown[], rest };
    }
    throw new GloamError("INVALID", `Send a list of ${key}, or { "${key}": [...] }.`);
  };
  const ImportQuery = z.strictObject({
    campaignId: z.string().min(3).max(40).optional(),
    dryRun: QueryBool.optional(),
    onConflict: Strategy.optional(),
  });
  const ImportRest = z.strictObject({
    campaignId: z.string().min(3).max(40).optional(),
    dryRun: z.boolean().optional(),
    strategy: Strategy.optional(),
    onConflict: Strategy.optional(),
  });
  /** What an import is asked to do: the query's word first, the body's next; a dry run unless told otherwise. */
  const importOptions = (req: Request, rest: Record<string, unknown>) => {
    const q = ImportQuery.parse(req.query);
    const r = ImportRest.parse(rest);
    return {
      campaignId: q.campaignId ?? r.campaignId,
      dryRun: q.dryRun ?? r.dryRun ?? true,
      strategy: q.onConflict ?? r.onConflict ?? r.strategy ?? "skip",
    };
  };
  const invalidOf = (
    list: { index: number; issues?: { path: string; message: string }[]; errors?: string[] }[],
  ) =>
    list.flatMap((i) =>
      i.issues
        ? i.issues.map((x) => ({ index: i.index, path: x.path, message: x.message }))
        : (i.errors ?? []).map((m) => ({ index: i.index, path: "", message: m })),
    );

  app.post(
    "/api/v1/content/spells\\:import",
    bigBody("content:write"),
    route((req, res) => {
      const c = caller(req, "content:write");
      const { list, rest } = entries(req.body, "spells");
      const o = importOptions(req, rest);
      const campaignId = campaignFor(c, o.campaignId);
      const report = campaignBus(ctx, campaignId).execute<ImportReport>(
        "content.spell.import",
        { spells: list, dryRun: o.dryRun, strategy: o.strategy },
        actorOf(c),
      );
      res.json({
        data: report,
        report: {
          created: [...report.imported],
          updated: report.overwritten,
          skipped: report.skipped,
          invalid: invalidOf(report.invalid),
        },
      });
    }),
  );

  app.post(
    "/api/v1/content/monsters\\:import",
    bigBody("content:write"),
    route((req, res) => {
      const c = caller(req, "content:write");
      const { list, rest } = entries(req.body, "monsters");
      const o = importOptions(req, rest);
      const campaignId = campaignFor(c, o.campaignId);
      const report = campaignBus(ctx, campaignId).execute<MonsterImportReport>(
        "content.monster.import",
        { monsters: list, dryRun: o.dryRun, strategy: o.strategy },
        actorOf(c),
      );
      res.json({
        data: report,
        report: {
          created: report.imported,
          updated: report.overwritten,
          skipped: report.skipped,
          invalid: invalidOf(report.invalid),
        },
      });
    }),
  );

  // ── Sheets ──────────────────────────────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/actors\\:import",
    bigBody("sheets:write"),
    route((req, res) => {
      const c = caller(req, "sheets:write");
      // One sheet, a list of them, or { sheets: [...] }.
      const body = req.body as unknown;
      const one = body && typeof body === "object" && !Array.isArray(body) && "core" in (body as object);
      const { list, rest } = one ? { list: [body], rest: {} } : entries(body, "sheets");
      const { ownerUserId, ...opts } = rest as { ownerUserId?: unknown };
      const o = importOptions(req, opts);
      const campaignId = campaignFor(c, o.campaignId);
      const report = campaignBus(ctx, campaignId).execute<ActorImportReport>(
        "actor.import",
        {
          sheets: list,
          dryRun: o.dryRun,
          ownerUserId: typeof ownerUserId === "string" ? ownerUserId : null,
        },
        actorOf(c),
      );
      res.json({
        data: report,
        report: {
          created: report.created.map((x) => x.actorId ?? x.name),
          updated: [],
          skipped: [],
          invalid: invalidOf(report.invalid),
        },
      });
    }),
  );

  app.get(
    "/api/v1/actors/:id",
    route((req, res) => {
      const c = caller(req, "sheets:read");
      const id = String(req.params.id);
      const row = ctx.db
        .select({ campaignId: actors.campaignId })
        .from(actors)
        .where(eq(actors.id, id))
        .get();
      const openCampaign = [...ctx.rooms.tables.values()].find((r) => r.model.get("actor", id))?.campaignId;
      const campaignId = openCampaign ?? row?.campaignId;
      if (!campaignId) throw new GloamError("NOT_FOUND", "No such character.");
      campaignFor(c, campaignId);
      const a = campaignModel(ctx, campaignId).get("actor", id);
      if (!a || a.deletedAt !== null) throw new GloamError("NOT_FOUND", "No such character.");
      const sheet: Sheet = readSheet(a);
      res.json({
        data: {
          id: a.id,
          campaignId,
          kind: a.kind,
          player: a.ownerUserId ? (ctx.profiles.get(a.ownerUserId)?.displayName ?? null) : null,
          sheet,
        },
      });
    }),
  );

  // ── The campaign log ────────────────────────────────────────────────────────────────────────────────────────────
  const LogQuery = z.strictObject({ sinceSession: z.coerce.number().int().min(0).max(100_000).optional() });
  app.get(
    "/api/v1/campaigns/:id/log",
    route((req, res) => {
      const c = caller(req, "log:read");
      const id = campaignFor(c, String(req.params.id));
      const q = LogQuery.parse(req.query);
      const list = ctx.campaigns.log(
        id,
        q.sinceSession === undefined ? {} : { sinceSession: q.sinceSession },
      );
      res.json({
        data: list.map((e) => ({
          id: e.id,
          sessionNo: e.sessionNo,
          kind: e.kind,
          text: e.text,
          author: typeof e.data.author === "string" ? e.data.author : null,
          visibility: e.visibility,
          createdAt: e.createdAt,
        })),
      });
    }),
  );

  app.post(
    "/api/v1/campaigns/:id/log",
    route((req, res) => {
      const c = caller(req, "log:write");
      const id = campaignFor(c, String(req.params.id));
      const e = CampaignLogEntrySchema.parse(req.body ?? {});
      const author = c.via === "token" ? `${c.token.name} (API)` : c.name;
      const room = ctx.rooms.table(id);
      if (room) room.appendLog(e.kind, e.text, { author });
      else ctx.campaigns.appendLog(id, { kind: e.kind, text: e.text, data: { author } });
      const last = ctx.campaigns.log(id, { limit: 1 })[0];
      res.status(201).json({
        data: last && {
          id: last.id,
          sessionNo: last.sessionNo,
          kind: last.kind,
          text: last.text,
          author,
          createdAt: last.createdAt,
        },
      });
    }),
  );
}
