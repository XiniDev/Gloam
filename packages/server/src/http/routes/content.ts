import { createHash } from "node:crypto";
import { GloamError } from "@gloam/shared/protocol";
import type { Express } from "express";
import type { ServerContext } from "../../context.ts";
import { requireSession, route } from "../helpers.ts";

/**
 * Spell content over HTTP (SPEC §8.13 Content, Import; §33; AC-SPL-11):
 * - `GET /api/table/content/spells` — the SRD pack for whoever's at the table (it never changes under a running
 *   server: cached by the pack's hash, revalidated with its ETag).
 *
 * The spell schema and imports are the local API's (routes/api.ts: `/api/v1/schemas/spell.json`,
 * `POST /api/v1/content/spells:import`).
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
}
