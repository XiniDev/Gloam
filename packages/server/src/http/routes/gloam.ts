import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { GloamError } from "@gloam/shared/protocol";
import busboy from "busboy";
import type { Express, Request, Response } from "express";
import type { ServerContext } from "../../context.ts";
import { exportCampaign, importCampaign } from "../../persistence/gloamPort.ts";
import { ok, requireAdmin, route, sendError } from "../helpers.ts";

/** A `.gloam` upload's size at most (compressed; what it unpacks to has its own 4 GB limit, gloamZip.ts). */
const IMPORT_CAP = 4 * 1024 ** 3;
/** An export's file name, as `exportCampaign` makes it — nothing else is served from the exports folder. */
const EXPORT_NAME = /^[a-z0-9-]{1,60}\.gloam$/;

/**
 * Campaign export and import (SPEC §20.5; AC-PER-05), the Admin's alone: export writes `data/exports/<name>.gloam`
 * and serves it back by that name; import takes one `.gloam` as multipart, streamed to a temp file under a size cap,
 * and makes a new campaign of it (gloamPort.ts checks everything before it writes).
 */
export function gloamRoutes(app: Express, ctx: ServerContext): void {
  app.post(
    "/api/admin/campaigns/:id/export",
    route(async (req, res) => {
      requireAdmin(req);
      const id = String(req.params.id);
      if (!ctx.campaigns.get(id)) throw new GloamError("NOT_FOUND");
      ok(res, await exportCampaign(ctx, id));
    }),
  );

  app.get(
    "/api/admin/exports/:file",
    route((req, res) => {
      requireAdmin(req);
      const file = String(req.params.file);
      if (!EXPORT_NAME.test(file)) throw new GloamError("INVALID", "That isn't an export's name.");
      const path = join(ctx.paths.exports, file);
      if (!existsSync(path)) throw new GloamError("NOT_FOUND");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(statSync(path).size));
      res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
      res.setHeader("Cache-Control", "no-store");
      createReadStream(path).pipe(res);
    }),
  );

  app.post("/api/admin/campaigns/import", async (req: Request, res: Response) => {
    let tmp: string | null = null;
    try {
      const a = requireAdmin(req);
      if (!String(req.headers["content-type"] ?? "").startsWith("multipart/form-data"))
        throw new GloamError("INVALID", "Send the .gloam file as multipart/form-data.");
      const got = await new Promise<string | null>((resolve, reject) => {
        const bb = busboy({
          headers: req.headers,
          limits: { files: 1, fields: 0, parts: 1, fileSize: IMPORT_CAP },
        });
        let seen = false;
        bb.on("file", (_field, stream) => {
          if (seen) {
            stream.resume();
            return;
          }
          seen = true;
          tmp = join(ctx.paths.tmp, `gloam-${randomBytes(12).toString("hex")}`);
          stream.on("limit", () =>
            stream.destroy(
              new GloamError("INVALID", "That file is larger than a campaign file may be (4 GB)."),
            ),
          );
          pipeline(stream, createWriteStream(tmp, { flags: "wx", mode: 0o600 }))
            .then(() => resolve(tmp))
            .catch(reject);
        });
        bb.on("error", reject);
        bb.on("close", () => {
          if (!seen) resolve(null);
        });
        req.pipe(bb);
      });
      if (!got) throw new GloamError("INVALID", "No file was attached.");
      const r = await importCampaign(ctx, got, {
        userId: a.user.id,
        name: a.user.displayName,
        role: "admin",
        lobby: false,
      });
      ok(res, { campaignId: r.campaignId, name: r.name, counts: r.counts, ids: Object.fromEntries(r.ids) });
    } catch (err) {
      if (err instanceof GloamError)
        sendError(
          res,
          err.code === "UNAUTHENTICATED" ? 401 : err.code === "FORBIDDEN" ? 403 : 400,
          err.code,
          err.message,
        );
      else {
        ctx.log.error({ err }, "campaign import failed");
        sendError(res, 500, "INVALID", "The import failed — please try again.");
      }
    } finally {
      if (tmp) rmSync(tmp, { force: true });
    }
  });
}
