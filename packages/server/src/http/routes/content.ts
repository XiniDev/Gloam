import { createHash } from "node:crypto";
import { GloamError } from "@gloam/shared/protocol";
import { applyPatch } from "@gloam/shared/rules";
import { SpellSchema } from "@gloam/shared/schemas";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { ServerContext } from "../../context.ts";
import { CommandBus } from "../../engine/commandBus.ts";
import type { ImportReport } from "../../engine/commands/content.ts";
import { CampaignModel } from "../../engine/model.ts";
import { registerCommands } from "../../engine/registry.ts";
import type { Role } from "../../services/campaigns.ts";
import { ok, requireSession, route } from "../helpers.ts";

/**
 * Spell content over HTTP (SPEC §8.13 Content, Import; §33; AC-SPL-11):
 * - `GET /api/table/content/spells` — the SRD pack for whoever's at the table (it never changes under a running
 *   server: cached by the pack's hash, revalidated with its ETag).
 * - `GET /api/v1/schemas/spell.json` — the published spell schema (what imports are checked against, what "Copy AI
 *   prompt" embeds). Public, as the character schema is.
 * - `POST /api/v1/content/spells:import` — a DM (or the Admin) imports a list of spells: a dry run reports, a real one
 *   imports; clashes by skip / overwrite / rename. Through the campaign's command bus: the open table's, or — the table
 *   closed — the campaign's own, straight to the database (the table loads it when it opens).
 */
export function contentRoutes(app: Express, ctx: ServerContext): void {
  const pack = ctx.content;
  const packJson = JSON.stringify({ data: { spells: pack.spells } });
  const etag = `"${createHash("sha256").update(packJson).digest("hex").slice(0, 32)}"`;
  app.get(
    "/api/table/content/spells",
    route((req, res) => {
      const a = requireSession(req);
      const t = ctx.table;
      if (a.session.kind !== "admin") {
        if (
          !t.isOpen ||
          !t.campaignId ||
          a.session.tableSessionNo !== t.sessionNo ||
          a.session.status !== "admitted"
        )
          throw new GloamError("TABLE_CLOSED");
      }
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, max-age=86400");
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      res.type("application/json").send(packJson);
    }),
  );

  const schema = JSON.stringify(spellJsonSchema(), null, 2);
  app.get("/api/v1/schemas/spell.json", (_req: Request, res: Response) => {
    res.type("application/schema+json").setHeader("Cache-Control", "public, max-age=3600").send(schema);
  });

  const ImportBody = z.strictObject({
    spells: z.array(z.unknown()).min(1).max(1000),
    dryRun: z.boolean().default(true),
    strategy: z.enum(["skip", "overwrite", "rename"]).default("skip"),
    campaignId: z.string().min(3).max(40).optional(),
  });
  // Express reads ":import" as a parameter; the literal colon is escaped.
  app.post(
    "/api/v1/content/spells\\:import",
    route((req, res) => {
      const a = requireSession(req);
      const b = ImportBody.parse(req.body ?? {});
      const t = ctx.table;
      const campaignId = b.campaignId ?? t.campaignId ?? ctx.settings.get().selectedCampaignId;
      if (!campaignId || !ctx.campaigns.get(campaignId))
        throw new GloamError("NOT_FOUND", "Choose a campaign first.");
      const role =
        a.session.kind === "admin"
          ? "admin"
          : (ctx.campaigns.membership(campaignId, a.user.id) as Role | null);
      if (role !== "admin" && role !== "dm") throw new GloamError("FORBIDDEN", "Only the DM imports spells.");
      const actor = { userId: a.user.id, role, name: a.user.displayName, actingAs: null };
      const room = ctx.rooms.table(campaignId);
      const bus = room?.bus ?? offlineBus(ctx, campaignId);
      const report = bus.execute<ImportReport>(
        "content.spell.import",
        { spells: b.spells, dryRun: b.dryRun, strategy: b.strategy },
        actor,
      );
      ok(res, report);
    }),
  );
}

/** The published spell schema (JSON Schema of the import shape: defaults may be left out). */
export function spellJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SpellSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}

/** A campaign's command bus with no table open: commits go to the database with their history, nothing is sent. */
function offlineBus(ctx: ServerContext, campaignId: string): CommandBus {
  const model = CampaignModel.load(ctx.db, campaignId);
  if (!model) throw new GloamError("NOT_FOUND", "That campaign no longer exists.");
  const bus = new CommandBus(ctx, model, {
    onCommitted: () => {},
    sheet: { apply: (sheet, patch) => applyPatch(sheet, patch) },
  });
  registerCommands(bus);
  return bus;
}
