/**
 * Asset pipeline constants and the parent ⇄ processor protocol (SPEC §8.16, §21). Shared by the server and the
 * processor child process, so this module must not import anything heavy.
 */

import { z } from "zod";

export const PURPOSES = ["map", "mini", "token", "portrait", "handout", "art", "audio"] as const;
export type Purpose = (typeof PURPOSES)[number];
export type AssetClass = "image" | "model" | "audio";

const MB = 1024 * 1024;

export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
export const MODEL_MIME = "model/gltf-binary";
/** file-type labels for the audio allow-list (R3 note 25). `video/mp4` is accepted for audio only after the
 * processor confirms an audio-only `moov`. */
export const AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/ogg",
  "audio/ogg; codecs=opus",
  "audio/wav",
  "audio/flac",
  "audio/x-m4a",
  "video/mp4",
]);

export function classOf(mime: string): AssetClass | null {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (mime === MODEL_MIME) return "model";
  if (AUDIO_MIMES.has(mime)) return "audio";
  return null;
}

/** Output profile: which variants and limits apply. */
export type Profile = "map" | "tok" | "hnd" | "mini" | "mapglb" | "aud";

/** Which content classes each purpose accepts, and with which profile (the detected type must match). */
export const PURPOSE_PROFILES: Record<Purpose, Partial<Record<AssetClass, Profile>>> = {
  map: { image: "map", model: "mapglb" },
  mini: { model: "mini" },
  token: { image: "tok" },
  portrait: { image: "tok" },
  art: { image: "tok" },
  handout: { image: "hnd" },
  audio: { audio: "aud" },
};

/** Byte caps (SPEC §8.16): maps 80 MB, other images 25 MB, GLB 60 MB, audio 50 MB. */
export const PROFILE_CAP: Record<Profile, number> = {
  map: 80 * MB,
  tok: 25 * MB,
  hnd: 25 * MB,
  mini: 60 * MB,
  mapglb: 60 * MB,
  aud: 50 * MB,
};

/** The largest cap any class of this purpose allows — the stream limit before the first bytes are seen. */
export function streamCap(purpose: Purpose): number {
  return Math.max(...Object.values(PURPOSE_PROFILES[purpose]).map((p) => PROFILE_CAP[p as Profile]));
}

/** Quotas (SPEC §8.16): players 200 MB of pending + approved uploads; people still in the lobby 20 MB. */
export const QUOTA = { player: 200 * MB, lobby: 20 * MB } as const;

/** Pixel limits: maps 16 384² (268 megapixels); tokens, portraits, handouts 50 megapixels. */
export const PIXEL_LIMIT: Record<"map" | "tok" | "hnd", number> = {
  map: 268_435_456,
  tok: 50_000_000,
  hnd: 50_000_000,
};

/** Image variants by long edge (SPEC §21.3). */
export const IMAGE_VARIANTS: Record<"map" | "tok" | "hnd", number[]> = {
  map: [8192, 4096, 1024, 256],
  tok: [1024, 512, 128],
  hnd: [2048, 512],
};

/** GLB triangle budgets and texture sizes (SPEC §21.4). */
export const GLB_BUDGET: Record<
  "mini" | "mapglb",
  { triangles: number; texture: number; primitives: number }
> = {
  mini: { triangles: 100_000, texture: 1024, primitives: 300 },
  mapglb: { triangles: 1_500_000, texture: 2048, primitives: 5_000 },
};

/** Per-job wall-clock limits (SPEC §21.1 step 5) and the processor's resident-memory ceiling. */
export const JOB_TIMEOUT_MS: Record<AssetClass, number> = { image: 20_000, model: 60_000, audio: 5_000 };
export const PROCESSOR_RSS_LIMIT = 1.5 * 1024 * MB;

/** `asset.list` filters (Library panel: tabs, search, tag, uploader, status, trash). */
export const LibraryQuery = z.strictObject({
  tab: z.enum(["minis", "tokens", "maps", "audio", "handouts", "all"]).optional(),
  q: z.string().max(80).optional(),
  tag: z.string().max(32).optional(),
  uploaderId: z.string().max(40).optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  trash: z.boolean().optional(),
});

// ── processor protocol ────────────────────────────────────────────────────────────────────────────────

export interface ProcessJob {
  id: string;
  cls: AssetClass;
  profile: Profile;
  /** The detected MIME type (file-type). */
  mime: string;
  /** The uploaded temp file (read-only for the processor). */
  input: string;
  /** A fresh, empty staging directory: the only place the processor writes. */
  outDir: string;
}

export interface VariantOut {
  /** e.g. "w1024", "glb", "orig" */
  name: string;
  /** File name inside `outDir`. */
  file: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface GlbStats {
  triangles: number;
  trianglesIn: number;
  textures: number;
  animations: string[];
  /** Model-space bounds after optimisation (normalisation hint, SPEC §8.5). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export interface ProcessMeta {
  width?: number;
  height?: number;
  /** "#rrggbb" placeholder colour for images. */
  dominant?: string;
  glb?: GlbStats;
  audio?: { container: string };
}

export type ProcessResult =
  | { ok: true; variants: VariantOut[]; meta: ProcessMeta }
  | { ok: false; reason: string };

export type ProcessorMessage =
  | { type: "result"; id: string; result: ProcessResult }
  | { type: "rss"; rss: number }
  | { type: "ready" };
