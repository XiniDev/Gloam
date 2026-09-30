import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdtemp, open } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { GloamError } from "@gloam/shared/protocol";
import { isDm } from "@gloam/shared/rules";
import { and, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { fileTypeFromFile } from "file-type";
import type { ServerContext } from "../context.ts";
import { assetFiles, assets } from "../db/schema.ts";
import { type AssetEntity, CODECS } from "../engine/codecs.ts";
import { newId } from "../ids.ts";
import type { Role } from "../services/campaigns.ts";
import { AssetProcessor } from "./processorHost.ts";
import {
  classOf,
  PROFILE_CAP,
  type ProcessMeta,
  type Profile,
  PURPOSE_PROFILES,
  type Purpose,
  QUOTA,
} from "./types.ts";

export interface Uploader {
  userId: string;
  name: string;
  role: Role;
  /** Still in the lobby (not yet admitted): art only, 20 MB (SPEC §8.16 Quotas). */
  lobby: boolean;
}

export interface StoredVariant {
  name: string;
  /** Relative to the data directory's `assets/` folder. */
  path: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface AssetDto {
  id: string;
  name: string;
  purpose: string;
  cls: "image" | "model" | "audio";
  status: "pending" | "approved" | "rejected";
  uploaderId: string;
  uploaderName: string;
  tags: string[];
  createdAt: number;
  deleted: boolean;
  bytes: number;
  width?: number;
  height?: number;
  dominant?: string;
  glb?: ProcessMeta["glb"];
  overrides: AssetEntity["overrides"];
  variants: { name: string; mime: string; bytes: number; width?: number; height?: number }[];
  /** Tokens and scenes using it (filled by the table room from the live model). */
  usage?: number;
  /** Audio: its length and integrated loudness, as the DM's browser measured them (SPEC §21.5, sound.md §6.3). */
  durationMs?: number;
  loudnessLufs?: number;
}

/**
 * What a player's client needs to draw an asset — nothing about who uploaded it, what it's called or how it's
 * tagged (a DM's "Lich reveal — act 3" must not spoil itself through a token's asset id).
 */
export type AssetRenderDto = Pick<
  AssetDto,
  | "id"
  | "purpose"
  | "cls"
  | "width"
  | "height"
  | "dominant"
  | "overrides"
  | "variants"
  | "durationMs"
  | "loudnessLufs"
> & { glb?: { bounds: NonNullable<ProcessMeta["glb"]>["bounds"]; animations: string[] } };

export function renderDto(d: AssetDto): AssetRenderDto {
  return {
    id: d.id,
    purpose: d.purpose,
    cls: d.cls,
    width: d.width,
    height: d.height,
    dominant: d.dominant,
    overrides: d.overrides,
    variants: d.variants,
    ...(d.glb ? { glb: { bounds: d.glb.bounds, animations: d.glb.animations } } : {}),
    ...(d.durationMs ? { durationMs: d.durationMs } : {}),
    ...(d.loudnessLufs !== undefined ? { loudnessLufs: d.loudnessLufs } : {}),
  };
}

export interface LibraryFilter {
  tab?: "minis" | "tokens" | "maps" | "audio" | "handouts" | "all";
  q?: string;
  tag?: string;
  uploaderId?: string;
  status?: "pending" | "approved" | "rejected";
  trash?: boolean;
}

const TAB_PURPOSES: Record<NonNullable<LibraryFilter["tab"]>, string[] | null> = {
  minis: ["mini"],
  tokens: ["token", "portrait", "art"],
  maps: ["map"],
  audio: ["audio"],
  handouts: ["handout"],
  all: null,
};

const PURPOSE_LABEL: Record<Purpose, string> = {
  map: "Maps",
  mini: "Minis",
  token: "Tokens",
  portrait: "Portraits",
  handout: "Handouts",
  art: "Drawings",
  audio: "Music and ambience",
};

const MB = 1024 * 1024;
const REJECTED_TTL_MS = 24 * 60 * 60 * 1000;

/** A readable reason for a file whose type isn't on the allow-list (SPEC §8.16 "Not accepted"). */
async function unsupportedReason(
  path: string,
  detected: string | undefined,
  purpose: Purpose,
): Promise<string> {
  const models = purpose === "mini" || purpose === "map";
  const glbHint = "export it as .glb from Blender (File → Export → glTF 2.0, Format: glTF Binary)";
  if (detected && /zip|rar|7z|x-tar|gzip/.test(detected))
    return models
      ? `Archives aren't accepted — ${glbHint}.`
      : "Archives aren't accepted — upload the image or audio file itself.";
  // file-type labels SVG/XML and plain text generically (or not at all): look at the text itself.
  if (!detected || /xml|^text\//.test(detected)) {
    const fh = await open(path, "r");
    const head = Buffer.alloc(512);
    await fh.read(head, 0, 512, 0);
    await fh.close();
    const text = head.toString("latin1");
    if (/^\s*(<\?xml[^>]*>\s*)?<svg/i.test(text))
      return "SVG images aren't accepted (they can contain scripts) — export it as PNG or WebP.";
    if (/^\s*\{\s*"(asset|accessors|buffers|scenes)"/.test(text))
      return `Multi-file glTF (.gltf) isn't accepted — ${glbHint}.`;
    if (/^Kaydara FBX|^solid |^\s*(v|vn|vt|f|o|g|mtllib|usemtl) /m.test(text))
      return `FBX, OBJ and STL models aren't accepted — ${glbHint}.`;
  }
  return `That file type${detected ? ` (${detected})` : ""} isn't supported. Upload PNG, JPEG, WebP, GIF or AVIF images, .glb models, or MP3, OGG, WAV, M4A or FLAC audio.`;
}

/** Keeps a display name printable and short. */
export function cleanName(raw: string | undefined, fallback: string): string {
  const base = (raw ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const s = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return s || fallback;
}

export class AssetService {
  readonly processor: AssetProcessor;
  private readonly ctx: ServerContext;

  constructor(ctx: ServerContext) {
    this.ctx = ctx;
    this.processor = new AssetProcessor(ctx.log.child({ mod: "assets" }), {
      testHooks: ctx.config.nodeEnv === "test",
      timeoutMs: ctx.config.processor.timeoutMs,
      rssLimit: ctx.config.processor.rssLimit,
    });
  }

  /** Bytes counting toward a user's quota: their pending + approved, non-deleted references (each file once). */
  usedBytes(userId: string): number {
    const rows = this.ctx.db
      .select({ fileId: assets.fileId, bytes: assetFiles.bytes })
      .from(assets)
      .innerJoin(assetFiles, eq(assets.fileId, assetFiles.id))
      .where(and(eq(assets.uploaderId, userId), isNull(assets.deletedAt), ne(assets.status, "rejected")))
      .all();
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.fileId, r.bytes);
    let total = 0;
    for (const b of seen.values()) total += b;
    return total;
  }

  /** null = unlimited (DMs and the Admin). */
  quotaFor(u: Uploader): number | null {
    if (isDm(u.role)) return null;
    return u.lobby ? QUOTA.lobby : QUOTA.player;
  }

  /**
   * Steps 3–7 of SPEC §21.1 for a fully received temp file: detect the type by content, check it against the
   * purpose, de-duplicate by hash, run the processor, store the outputs and create this campaign's reference.
   */
  async ingest(o: {
    tmpPath: string;
    bytes: number;
    sha256: string;
    purpose: Purpose;
    name: string;
    campaignId: string;
    uploader: Uploader;
  }): Promise<{ asset: AssetDto; deduped: boolean }> {
    const detected = (await fileTypeFromFile(o.tmpPath))?.mime;
    const cls = detected ? classOf(detected) : null;
    if (!detected || !cls)
      throw new GloamError("INVALID", await unsupportedReason(o.tmpPath, detected, o.purpose));
    // An MP4 container counts as audio only for the audio purpose (and only if the processor finds no video).
    const profile = PURPOSE_PROFILES[o.purpose][cls] as Profile | undefined;
    if (!profile || (detected === "video/mp4" && o.purpose !== "audio")) {
      const want =
        o.purpose === "mini"
          ? "Minis must be .glb 3D models."
          : o.purpose === "audio"
            ? "Music and ambience must be audio files (MP3, OGG, WAV, M4A or FLAC)."
            : o.purpose === "map"
              ? "Maps must be images or .glb 3D maps."
              : `${PURPOSE_LABEL[o.purpose]} must be images — upload 3D models as minis or maps.`;
      throw new GloamError("INVALID", want);
    }
    if (o.bytes > PROFILE_CAP[profile])
      throw new GloamError(
        "INVALID",
        `This file is ${(o.bytes / MB).toFixed(1)} MB — the limit here is ${PROFILE_CAP[profile] / MB} MB.`,
      );
    const fileId = `${o.sha256}-${profile}`;
    let file = this.ctx.db.select().from(assetFiles).where(eq(assetFiles.id, fileId)).get();
    const deduped = Boolean(file);
    if (!file) file = await this.process(o, detected, cls, profile, fileId);
    // One reference per uploader, campaign, file and purpose: a repeated upload returns the existing one.
    const existing = this.ctx.db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.campaignId, o.campaignId),
          eq(assets.fileId, fileId),
          eq(assets.uploaderId, o.uploader.userId),
          eq(assets.purpose, o.purpose),
          isNull(assets.deletedAt),
          ne(assets.status, "rejected"),
        ),
      )
      .get();
    if (existing) return { asset: this.dto(CODECS.asset.fromRow(existing), file), deduped: true };
    const dm = isDm(o.uploader.role);
    const autoImages = this.ctx.settings.get().autoApproveImages === true && cls === "image";
    const status: AssetEntity["status"] = dm || autoImages ? "approved" : "pending";
    const now = Date.now();
    const asset: AssetEntity = {
      id: newId("ast"),
      campaignId: o.campaignId,
      fileId,
      name: o.name,
      purpose: o.purpose,
      tags: [],
      uploaderId: o.uploader.userId,
      status,
      createdAt: now,
      reviewedBy: status === "approved" ? (dm ? o.uploader.userId : "auto") : null,
      reviewedAt: status === "approved" ? now : null,
      deletedAt: null,
      overrides: {},
    };
    const room = this.ctx.rooms.tables.get(o.campaignId);
    if (room) {
      room.bus.execute(
        "asset.register",
        { asset },
        { userId: o.uploader.userId, role: o.uploader.role, name: o.uploader.name },
      );
    } else {
      this.ctx.db
        .insert(assets)
        .values(CODECS.asset.toRow(asset) as never)
        .run();
    }
    return { asset: this.dto(asset, file), deduped };
  }

  private async process(
    o: { tmpPath: string; bytes: number; sha256: string; name: string },
    mime: string,
    cls: "image" | "model" | "audio",
    profile: Profile,
    fileId: string,
  ): Promise<typeof assetFiles.$inferSelect> {
    const staging = await mkdtemp(join(this.ctx.paths.tmp, "job-"));
    try {
      const result = await this.processor.process({
        id: newId("job"),
        cls,
        profile,
        mime,
        input: o.tmpPath,
        outDir: staging,
      });
      if (!result.ok) throw new GloamError("INVALID", result.reason);
      const shard = o.sha256.slice(0, 2);
      const dir = join(this.ctx.paths.assets, shard);
      mkdirSync(dir, { recursive: true });
      const variants: StoredVariant[] = result.variants.map((v) => {
        const ext = v.file.split(".").pop() ?? "bin";
        const dest = `${o.sha256}-${profile}-${v.name}.${ext}`;
        renameSync(join(staging, v.file), join(dir, dest));
        return {
          name: v.name,
          path: `${shard}/${dest}`,
          mime: v.mime,
          bytes: v.bytes,
          width: v.width,
          height: v.height,
        };
      });
      const row = {
        id: fileId,
        kind: cls,
        mime,
        bytes: o.bytes,
        width: result.meta.width ?? null,
        height: result.meta.height ?? null,
        durationMs: null,
        variantsJson: JSON.stringify(variants),
        metaJson: JSON.stringify({ sha256: o.sha256, profile, ...result.meta }),
        createdAt: Date.now(),
      };
      this.ctx.db.insert(assetFiles).values(row).onConflictDoNothing().run();
      return this.ctx.db.select().from(assetFiles).where(eq(assetFiles.id, fileId)).get() as typeof row;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  file(fileId: string) {
    return this.ctx.db.select().from(assetFiles).where(eq(assetFiles.id, fileId)).get();
  }

  get(assetId: string): AssetEntity | undefined {
    const r = this.ctx.db.select().from(assets).where(eq(assets.id, assetId)).get();
    return r ? CODECS.asset.fromRow(r) : undefined;
  }

  dto(a: AssetEntity, file: typeof assetFiles.$inferSelect): AssetDto {
    const variants = JSON.parse(String(file.variantsJson)) as StoredVariant[];
    const meta = JSON.parse(String(file.metaJson)) as ProcessMeta & {
      sha256?: string;
      loudnessLufs?: number;
    };
    return {
      id: a.id,
      name: a.name,
      purpose: a.purpose,
      cls: file.kind as AssetDto["cls"],
      status: a.status,
      uploaderId: a.uploaderId,
      uploaderName: this.ctx.profiles.get(a.uploaderId)?.displayName ?? "someone",
      tags: a.tags,
      createdAt: a.createdAt,
      deleted: a.deletedAt !== null,
      bytes: file.bytes,
      width: file.width ?? undefined,
      height: file.height ?? undefined,
      dominant: meta.dominant,
      glb: meta.glb,
      overrides: a.overrides,
      variants: variants.map((v) => ({
        name: v.name,
        mime: v.mime,
        bytes: v.bytes,
        width: v.width,
        height: v.height,
      })),
      ...(file.durationMs ? { durationMs: file.durationMs } : {}),
      ...(typeof meta.loudnessLufs === "number" ? { loudnessLufs: meta.loudnessLufs } : {}),
    };
  }

  /**
   * An audio file's length and loudness, measured by a DM's browser on upload or first play (SPEC §21.5): kept on
   * the file (every campaign using it shares them). Measured once: a value already there stays.
   */
  setAudioMeasure(fileId: string, m: { durationMs: number; loudnessLufs: number }): boolean {
    const f = this.file(fileId);
    if (!f || f.kind !== "audio" || f.durationMs) return false;
    const meta = JSON.parse(String(f.metaJson)) as Record<string, unknown>;
    this.ctx.db
      .update(assetFiles)
      .set({
        durationMs: Math.round(m.durationMs),
        metaJson: JSON.stringify({ ...meta, loudnessLufs: m.loudnessLufs }),
      })
      .where(eq(assetFiles.id, fileId))
      .run();
    return true;
  }

  dtoById(assetId: string): AssetDto | null {
    const a = this.get(assetId);
    const f = a ? this.file(a.fileId) : undefined;
    return a && f ? this.dto(a, f) : null;
  }

  /**
   * The Library listing (SPEC §8.16): DMs see everything; everyone else sees only their own uploads (the Library is
   * the DM's tool — players pick from what they brought, and never browse the DM's names and tags).
   */
  list(campaignId: string, viewer: { userId: string; role: Role }, f: LibraryFilter = {}): AssetDto[] {
    const rows = this.ctx.db
      .select()
      .from(assets)
      .innerJoin(assetFiles, eq(assets.fileId, assetFiles.id))
      .where(eq(assets.campaignId, campaignId))
      .all();
    const dm = isDm(viewer.role);
    const purposes = TAB_PURPOSES[f.tab ?? "all"];
    const q = f.q?.trim().toLowerCase();
    const out: AssetDto[] = [];
    for (const r of rows) {
      const a = CODECS.asset.fromRow(r.assets);
      if (f.trash ? a.deletedAt === null : a.deletedAt !== null) continue;
      if (!dm && a.uploaderId !== viewer.userId) continue;
      if (purposes && !purposes.includes(a.purpose)) continue;
      if (f.status && a.status !== f.status) continue;
      if (f.uploaderId && a.uploaderId !== f.uploaderId) continue;
      if (f.tag && !a.tags.includes(f.tag.toLowerCase())) continue;
      if (q && !a.name.toLowerCase().includes(q) && !a.tags.some((t) => t.includes(q))) continue;
      out.push(this.dto(a, r.asset_files));
    }
    return out.sort((x, y) => y.createdAt - x.createdAt);
  }

  /**
   * Who may fetch an asset (SPEC §21.6): the Admin; the uploader (any status); DMs of its campaign; and admitted
   * members of the running table for approved assets. Everything else answers 404 (no existence oracle).
   */
  canRead(
    a: AssetEntity,
    s: { userId: string; kind: "admin" | "player"; status?: string; tableSessionNo?: number | null },
  ): boolean {
    if (s.kind === "admin") return true;
    if (a.uploaderId === s.userId) return true;
    const t = this.ctx.table;
    const admitted =
      s.status === "admitted" &&
      t.isOpen &&
      t.campaignId === a.campaignId &&
      s.tableSessionNo === t.sessionNo;
    if (!admitted) return false;
    const role = this.ctx.campaigns.membership(a.campaignId, s.userId);
    if (role === "dm") return true;
    return Boolean(role) && a.status === "approved";
  }

  /** Absolute path of a variant, confined to the assets directory. */
  variantPath(
    file: typeof assetFiles.$inferSelect,
    name: string,
  ): { path: string; mime: string; etag: string } | null {
    const variants = JSON.parse(String(file.variantsJson)) as StoredVariant[];
    const v = variants.find((x) => x.name === name);
    if (!v) return null;
    const root = resolve(this.ctx.paths.assets);
    const abs = resolve(root, v.path);
    if (!abs.startsWith(root + sep)) return null;
    return { path: abs, mime: v.mime, etag: `"${file.id}-${v.name}"` };
  }

  /**
   * Every campaign's uploads at a glance (SPEC §8.20 Assets): how many, how much they take (each file once per
   * campaign), how many wait for approval; and what a clean-up would remove — files nothing references, rejected
   * uploads past their 24 h.
   */
  overview(now = Date.now()): {
    campaigns: { campaignId: string; name: string; assets: number; bytes: number; pending: number }[];
    files: number;
    fileBytes: number;
    orphans: { files: number; bytes: number; rejected: number };
  } {
    const rows = this.ctx.db
      .select({
        campaignId: assets.campaignId,
        fileId: assets.fileId,
        status: assets.status,
        deletedAt: assets.deletedAt,
        reviewedAt: assets.reviewedAt,
      })
      .from(assets)
      .all();
    const files = new Map(
      this.ctx.db
        .select()
        .from(assetFiles)
        .all()
        .map((f) => [f.id, f]),
    );
    const byCampaign = new Map<string, { assets: number; files: Set<string>; pending: number }>();
    for (const r of rows) {
      if (r.deletedAt !== null) continue;
      const c = byCampaign.get(r.campaignId) ?? { assets: 0, files: new Set<string>(), pending: 0 };
      c.assets++;
      c.files.add(r.fileId);
      if (r.status === "pending") c.pending++;
      byCampaign.set(r.campaignId, c);
    }
    const names = new Map(this.ctx.campaigns.list(true).map((c) => [c.id, c.name]));
    const used = new Set(rows.map((r) => r.fileId));
    let orphanFiles = 0;
    let orphanBytes = 0;
    let fileBytes = 0;
    for (const f of files.values()) {
      fileBytes += f.bytes;
      if (!used.has(f.id)) {
        orphanFiles++;
        orphanBytes += f.bytes;
      }
    }
    return {
      campaigns: [...byCampaign.entries()].map(([campaignId, c]) => ({
        campaignId,
        name: names.get(campaignId) ?? "A deleted campaign",
        assets: c.assets,
        bytes: [...c.files].reduce((n, id) => n + (files.get(id)?.bytes ?? 0), 0),
        pending: c.pending,
      })),
      files: files.size,
      fileBytes,
      orphans: {
        files: orphanFiles,
        bytes: orphanBytes,
        rejected: rows.filter(
          (r) => r.status === "rejected" && r.reviewedAt !== null && r.reviewedAt < now - REJECTED_TTL_MS,
        ).length,
      },
    };
  }

  /** Rejected references older than 24 h are purged, then files nothing references (SPEC §8.16 Approval). */
  purge(now = Date.now()): { references: number; files: number } {
    const stale = this.ctx.db
      .select({ id: assets.id, campaignId: assets.campaignId })
      .from(assets)
      .where(and(eq(assets.status, "rejected"), lt(assets.reviewedAt, now - REJECTED_TTL_MS)))
      .all();
    if (stale.length) {
      this.ctx.db
        .delete(assets)
        .where(
          inArray(
            assets.id,
            stale.map((s) => s.id),
          ),
        )
        .run();
      for (const s of stale) this.ctx.rooms.tables.get(s.campaignId)?.model.remove("asset", s.id);
    }
    const used = new Set(
      this.ctx.db
        .select({ f: assets.fileId })
        .from(assets)
        .all()
        .map((r) => r.f),
    );
    let files = 0;
    for (const f of this.ctx.db.select().from(assetFiles).all()) {
      if (used.has(f.id)) continue;
      for (const v of JSON.parse(String(f.variantsJson)) as StoredVariant[]) {
        const p = resolve(this.ctx.paths.assets, v.path);
        if (p.startsWith(resolve(this.ctx.paths.assets) + sep)) rmSync(p, { force: true });
      }
      this.ctx.db.delete(assetFiles).where(eq(assetFiles.id, f.id)).run();
      files++;
    }
    return { references: stale.length, files };
  }

  /** Reads a stored variant (tests and the Admin's storage view). */
  readVariant(file: typeof assetFiles.$inferSelect, name: string): Buffer | null {
    const v = this.variantPath(file, name);
    return v ? readFileSync(v.path) : null;
  }
}
