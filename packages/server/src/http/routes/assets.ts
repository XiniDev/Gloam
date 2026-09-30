import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GloamError } from "@gloam/shared/protocol";
import busboy from "busboy";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { cleanName, renderDto, type Uploader } from "../../assets/service.ts";
import {
  LOBBY_TOTAL,
  PROFILE_CAP,
  PURPOSE_PROFILES,
  PURPOSES,
  type Purpose,
  streamCap,
} from "../../assets/types.ts";
import type { ServerContext } from "../../context.ts";
import type { Role } from "../../services/campaigns.ts";
import { ok, requireSession, route, sendError } from "../helpers.ts";

const MB = 1024 * 1024;

class LimitExceeded extends Error {
  readonly status: number;
  constructor(message: string, status = 413) {
    super(message);
    this.status = status;
  }
}

/** Magic → the cap of the class that file will turn out to be, so a map-purpose GLB stops at 60 MB, not 80. */
function capFromMagic(purpose: Purpose, head: Buffer, fallback: number): number {
  const isGlb = head.length >= 4 && head.toString("latin1", 0, 4) === "glTF";
  const profiles = PURPOSE_PROFILES[purpose];
  if (isGlb && profiles.model) return PROFILE_CAP[profiles.model];
  if (!isGlb && profiles.image && purpose !== "audio") return PROFILE_CAP[profiles.image];
  return fallback;
}

/**
 * Counts, hashes and caps an upload while it streams (AC-AST-02): the first bytes pick the class cap, the user's
 * remaining quota is a second cap, and exceeding either aborts at once.
 */
class Meter extends Transform {
  bytes = 0;
  readonly hash = createHash("sha256");
  private cap: number;
  private readonly purpose: Purpose;
  private readonly quotaLeft: number | null;
  private head = Buffer.alloc(0);
  constructor(purpose: Purpose, quotaLeft: number | null) {
    super();
    this.purpose = purpose;
    this.cap = streamCap(purpose);
    this.quotaLeft = quotaLeft;
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.head.length < 16) {
      this.head = Buffer.concat([this.head, chunk]).subarray(0, 16);
      if (this.head.length >= 4) this.cap = capFromMagic(this.purpose, this.head, this.cap);
    }
    this.bytes += chunk.length;
    if (this.bytes > this.cap) {
      cb(
        new LimitExceeded(`This file is larger than the ${this.cap / MB} MB limit for this kind of upload.`),
      );
      return;
    }
    if (this.quotaLeft !== null && this.bytes > this.quotaLeft) {
      cb(
        new LimitExceeded(
          `This upload would go over your storage allowance (${Math.max(0, Math.floor(this.quotaLeft / MB))} MB left). Ask the DM to remove some of your uploads.`,
        ),
      );
      return;
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }
}

/** Who is uploading, for which campaign (SPEC §21.1 step 1). */
function uploaderFor(
  ctx: ServerContext,
  req: Request,
  purpose: Purpose,
): { uploader: Uploader; campaignId: string } {
  const a = requireSession(req);
  const t = ctx.table;
  if (a.session.kind === "admin") {
    const q = z.string().max(40).optional().parse(req.query.campaignId);
    const campaignId = q ?? t.campaignId ?? ctx.settings.get().selectedCampaignId;
    if (!campaignId || !ctx.campaigns.get(campaignId))
      throw new GloamError("NOT_FOUND", "Choose a campaign first.");
    return {
      uploader: { userId: a.user.id, name: a.user.displayName, role: "admin", lobby: false },
      campaignId,
    };
  }
  if (!t.isOpen || !t.campaignId || a.session.tableSessionNo !== t.sessionNo)
    throw new GloamError("TABLE_CLOSED");
  if (a.session.status === "admitted") {
    const role = ctx.campaigns.membership(t.campaignId, a.user.id) as Role | null;
    if (!role || role === "spectator") throw new GloamError("FORBIDDEN", "Spectators can't upload files.");
    return {
      uploader: { userId: a.user.id, name: a.user.displayName, role, lobby: false },
      campaignId: t.campaignId,
    };
  }
  if (a.session.status === "pending") {
    if (purpose !== "art")
      throw new GloamError("FORBIDDEN", "While you wait you can upload a drawing of your character.");
    return {
      uploader: { userId: a.user.id, name: a.user.displayName, role: "player", lobby: true },
      campaignId: t.campaignId,
    };
  }
  throw new GloamError("FORBIDDEN");
}

export function assetRoutes(app: Express, ctx: ServerContext): void {
  /** Upload (SPEC §21.1). Multipart with one file part; `purpose` and `name` ride in the query string (R3 note 34). */
  app.post("/api/assets", async (req: Request, res: Response) => {
    let tmp: string | null = null;
    let responded = false;
    const fail = (status: number, code: Parameters<typeof sendError>[2], message: string, abort = false) => {
      if (responded) return;
      responded = true;
      // Every refused upload is a security event (AC-ADM-04): who, from where, why (never the file's bytes).
      if (status !== 401)
        ctx.security.record("upload.rejected", {
          userId: req.gloam.auth?.user.id ?? null,
          ip: req.gloam.ip,
          detail: { status, reason: message, purpose: String(req.query.purpose ?? "") },
        });
      if (abort) {
        // Stop storing at once and answer now (AC-AST-02). Whatever the client is still sending is read and
        // discarded (Node drains it after the response), never stored. Closing with unread input would send a TCP
        // RST, and the client's stack may then throw away the answer it already received — so no
        // "Connection: close"; a client that never stops is cut off after 30 s (nginx's lingering_time).
        req.unpipe();
        req.resume();
        const linger = setTimeout(() => req.socket.destroy(), 30_000);
        linger.unref();
        req.socket.once("close", () => clearTimeout(linger));
      }
      sendError(res, status, code, message);
    };
    try {
      const purpose = z.enum(PURPOSES).parse(req.query.purpose);
      const { uploader, campaignId } = uploaderFor(ctx, req, purpose);
      if (!ctx.limits.uploads.take(uploader.userId))
        return fail(429, "RATE_LIMITED", "That's a lot of uploads — wait a minute and try again.", true);
      if (!String(req.headers["content-type"] ?? "").startsWith("multipart/form-data"))
        return fail(400, "INVALID", "Send the file as multipart/form-data.");
      const quota = ctx.assets.quotaFor(uploader);
      // The waiting room's own allowance, whoever's in it (each new face had its 20 MB: security review M4).
      const lobbyLeft = uploader.lobby ? LOBBY_TOTAL - ctx.assets.lobbyBytes(campaignId) : null;
      const personalLeft = quota === null ? null : quota - ctx.assets.usedBytes(uploader.userId);
      const quotaLeft = lobbyLeft === null ? personalLeft : Math.min(lobbyLeft, personalLeft ?? lobbyLeft);
      if (lobbyLeft !== null && lobbyLeft <= 0)
        return fail(
          413,
          "INVALID",
          "The waiting room holds all the uploads it can for now — add your art once the DM lets you in.",
          true,
        );
      if (quotaLeft !== null && quotaLeft <= 0)
        return fail(
          413,
          "INVALID",
          "You've used your whole storage allowance. Ask the DM to remove some uploads.",
          true,
        );

      const received = await new Promise<{ path: string; filename: string; meter: Meter } | null>(
        (resolveFile, rejectFile) => {
          const bb = busboy({
            headers: req.headers,
            limits: { files: 1, fields: 4, parts: 5, fileSize: streamCap(purpose) + 1 },
          });
          let got = false;
          bb.on("file", (_field, stream, info) => {
            if (got) {
              stream.resume();
              return;
            }
            got = true;
            tmp = join(ctx.paths.tmp, `up-${randomBytes(12).toString("hex")}`);
            const meter = new Meter(purpose, quotaLeft);
            stream.on("limit", () =>
              stream.destroy(
                new LimitExceeded(`This file is larger than the ${streamCap(purpose) / MB} MB limit.`),
              ),
            );
            pipeline(stream, meter, createWriteStream(tmp, { flags: "wx" }))
              .then(() => resolveFile({ path: tmp as string, filename: info.filename ?? "", meter }))
              .catch(rejectFile);
          });
          bb.on("error", rejectFile);
          bb.on("partsLimit", () => rejectFile(new GloamError("INVALID", "Send one file at a time.")));
          bb.on("close", () => {
            if (!got) resolveFile(null);
          });
          req.pipe(bb);
        },
      );
      if (!received) return fail(400, "INVALID", "No file was attached.");
      const name = cleanName(
        typeof req.query.name === "string" ? req.query.name : received.filename,
        purpose === "mini" ? "Mini" : purpose === "map" ? "Map" : "Upload",
      );
      const result = await ctx.assets.ingest({
        tmpPath: received.path,
        bytes: received.meter.bytes,
        sha256: received.meter.hash.digest("hex"),
        purpose,
        name,
        campaignId,
        uploader,
      });
      responded = true;
      ok(res, { asset: result.asset, deduped: result.deduped });
    } catch (err) {
      if (err instanceof LimitExceeded) fail(err.status, "INVALID", err.message, true);
      else if (err instanceof GloamError) {
        const status =
          err.code === "UNAUTHENTICATED"
            ? 401
            : err.code === "FORBIDDEN"
              ? 403
              : err.code === "NOT_FOUND"
                ? 404
                : err.code === "TABLE_CLOSED"
                  ? 409
                  : 400;
        fail(status, err.code, err.message);
      } else if (err instanceof z.ZodError)
        fail(400, "INVALID", "Choose what the file is for (map, mini, token…).");
      else {
        ctx.log.error({ err }, "upload failed");
        fail(500, "INVALID", "The upload failed — please try again.");
      }
    } finally {
      if (tmp) rmSync(tmp, { force: true });
    }
  });

  /** Remaining storage allowance, so the client can pre-check before uploading. */
  app.get(
    "/api/assets/quota",
    route((req, res) => {
      const purpose = z.enum(PURPOSES).catch("art").parse(req.query.purpose);
      const { uploader } = uploaderFor(ctx, req, purpose);
      const quota = ctx.assets.quotaFor(uploader);
      ok(res, { quota, used: ctx.assets.usedBytes(uploader.userId) });
    }),
  );

  /** One asset's description (variants, sizes, mini bounds) for whoever may read it; 404 otherwise. */
  app.get(
    "/api/assets/:assetId",
    route((req, res) => {
      const a = requireSession(req);
      const id = z
        .string()
        .regex(/^ast_[A-Za-z0-9]{8,32}$/)
        .parse(req.params.assetId);
      const asset = ctx.assets.get(id);
      const readable =
        asset &&
        ctx.assets.canRead(asset, {
          userId: a.user.id,
          kind: a.session.kind as "admin" | "player",
          status: a.session.status ?? undefined,
          tableSessionNo: a.session.tableSessionNo,
        });
      const dto = readable ? ctx.assets.dtoById(id) : null;
      if (!dto) throw new GloamError("NOT_FOUND");
      // The full record for the Admin, the campaign's DMs and the uploader; everyone else gets what drawing needs.
      const full =
        a.session.kind === "admin" ||
        dto.uploaderId === a.user.id ||
        ctx.campaigns.membership((asset as { campaignId: string }).campaignId, a.user.id) === "dm";
      ok(res, full ? dto : renderDto(dto));
    }),
  );

  /**
   * An audio track's length and loudness (SPEC §21.5, docs/research/sound.md §6.3), measured by the DM's browser as
   * it decodes the file: the length lets the server move the music on when a track ends; the loudness evens tracks
   * out. The campaign's DMs, the uploader or the Admin; the first measurement stays.
   */
  app.patch(
    "/api/assets/:assetId/audio",
    route((req, res) => {
      const a = requireSession(req);
      const id = z
        .string()
        .regex(/^ast_[A-Za-z0-9]{8,32}$/)
        .parse(req.params.assetId);
      const body = z
        .strictObject({
          durationMs: z
            .number()
            .min(100)
            .max(6 * 3600_000),
          loudnessLufs: z.number().min(-70).max(3),
        })
        .parse(req.body);
      const asset = ctx.assets.get(id);
      if (!asset) throw new GloamError("NOT_FOUND");
      const may =
        a.session.kind === "admin" ||
        asset.uploaderId === a.user.id ||
        ctx.campaigns.membership(asset.campaignId, a.user.id) === "dm";
      if (!may) throw new GloamError("NOT_FOUND");
      const set = ctx.assets.setAudioMeasure(asset.fileId, body);
      // The track playing may be this one: its end can be timed now.
      if (set) ctx.rooms.tables.get(asset.campaignId)?.audioChanged();
      ok(res, { set });
    }),
  );

  /**
   * Serving (SPEC §21.6): member-only, immutable, fixed Content-Type from the database, nosniff, a sandbox CSP
   * (AC-AST-05). Anything not readable answers 404, so asset ids can't be probed.
   */
  app.get("/assets/:assetId/:variant", (req: Request, res: Response) => {
    const a = req.gloam.auth;
    const notFound = () => res.status(404).type("text/plain").send("Not found");
    if (!a) return res.status(401).type("text/plain").send("Sign in first");
    const { assetId, variant } = req.params as { assetId: string; variant: string };
    if (!/^ast_[A-Za-z0-9]{8,32}$/.test(assetId) || !/^[a-z0-9]{1,16}$/.test(variant)) return notFound();
    const asset = ctx.assets.get(assetId);
    if (!asset) return notFound();
    const allowed = ctx.assets.canRead(asset, {
      userId: a.user.id,
      kind: a.session.kind as "admin" | "player",
      status: a.session.status ?? undefined,
      tableSessionNo: a.session.tableSessionNo,
    });
    if (!allowed) return notFound();
    const file = ctx.assets.file(asset.fileId);
    const v = file ? ctx.assets.variantPath(file, variant) : null;
    if (!v) return notFound();
    res.setHeader("Content-Type", v.mime);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("ETag", v.etag);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (req.headers["if-none-match"] === v.etag) return res.status(304).end();
    res.sendFile(
      v.path,
      { etag: false, lastModified: false, acceptRanges: true, dotfiles: "deny" },
      (err) => {
        if (err && !res.headersSent) notFound();
      },
    );
  });
}
