import { createHash, randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIGHT_PRESETS } from "@gloam/shared";
import { TokenStatsIn } from "@gloam/shared/protocol";
import type {
  EffectEntity,
  LightEntity,
  SceneEntity,
  TokenEntity,
  TokenStats,
  WallEntity,
} from "@gloam/shared/schemas";
import { EMPTY_STATUS } from "@gloam/shared/schemas";
import sharp from "sharp";
import type { Uploader } from "../assets/service.ts";
import type { Purpose } from "../assets/types.ts";
import { rng } from "../bench/visionScene.ts";
import type { ServerContext } from "../context.ts";
import { CODECS } from "../engine/codecs.ts";
import { newId } from "../ids.ts";
import { MINI_COUNT, miniGlb } from "./minis.ts";

type V = { x: number; y: number };

/** The benchmark scene's size (SPEC §37). */
export const BENCH_SCENE = {
  name: "Benchmark (§37)",
  w: 200,
  h: 150,
  /** Pixels per foot of its map image (2400 × 1800). */
  pxPerFt: 12,
  walls: 300,
  doors: 12,
  lights: 20,
  animatedLights: 8,
  minis: 10,
  otherTokens: 30,
  viewers: 4,
} as const;

/** A flagstone floor drawn by code: irregular slabs of warm grey with dark joints and moss in the cracks. */
function floorSvg(w: number, h: number, seed: number): string {
  const r = rng(seed);
  const slabs: string[] = [];
  const S = 60; // one slab ≈ 5 ft at 12 px/ft
  for (let y = 0; y < h; y += S)
    for (let x = (y / S) % 2 ? -S / 2 : 0; x < w; x += S) {
      const g = 92 + Math.floor(r() * 36);
      const warm = Math.floor(r() * 10);
      slabs.push(
        `<rect x="${x + 3}" y="${y + 3}" width="${S - 6}" height="${S - 6}" rx="${4 + r() * 5}" fill="rgb(${g + warm},${g + warm / 2},${g - 6})"/>`,
      );
      if (r() < 0.08)
        slabs.push(
          `<circle cx="${x + r() * S}" cy="${y + r() * S}" r="${6 + r() * 10}" fill="rgb(70,86,52)" opacity="0.35"/>`,
        );
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="rgb(42,38,34)"/>${slabs.join("")}</svg>`;
}

/** Bytes through the upload pipeline as the campaign's (validated, processed, deduplicated): the asset's id. */
async function ingest(
  ctx: ServerContext,
  campaignId: string,
  by: Uploader,
  bytes: Uint8Array | Buffer,
  purpose: Purpose,
  name: string,
): Promise<string> {
  const tmp = join(ctx.paths.tmp, `bench-${randomBytes(8).toString("hex")}`);
  writeFileSync(tmp, bytes, { mode: 0o600 });
  try {
    const r = await ctx.assets.ingest({
      tmpPath: tmp,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      purpose,
      name,
      campaignId,
      uploader: by,
    });
    return r.asset.id;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * The benchmark scene (SPEC §37), added to a campaign as a scene of its own — archived, so it stays out of the DM's
 * way (the demo seeds it so; `pnpm bench` measures on it): a 200 × 150 ft image map; 40 creatures — 10 GLB minis
 * sharing 3 models of up to 20 k triangles, 30 coins and standees, 4 of them the players' viewers (darkvision; the
 * bench gives them owners); 300 walls with 12 doors; 20 lights, 8 of them flickering; 3 lasting effects (a fog cloud,
 * a darkness, spirit guardians); dynamic fog. Made by code, like the Lantern Crypt.
 */
export async function addBenchmarkScene(
  ctx: ServerContext,
  campaignId: string,
  by: Uploader,
  opts: { archived?: boolean } = {},
): Promise<{ sceneId: string; viewerTokenIds: string[]; creatureIds: string[] }> {
  const B = BENCH_SCENE;
  const r = rng(37);
  const now = Date.now();
  const W = B.w * B.pxPerFt;
  const H = B.h * B.pxPerFt;
  const mapPng = await sharp(Buffer.from(floorSvg(W, H, 37)))
    .png()
    .toBuffer();
  const mapId = await ingest(ctx, campaignId, by, mapPng, "map", "Benchmark flagstones");
  const minis: string[] = [];
  for (let i = 0; i < MINI_COUNT; i++) {
    const m = await miniGlb(i);
    minis.push(await ingest(ctx, campaignId, by, m.glb, "mini", m.name));
  }
  const sceneId = newId("scn");
  const scene: SceneEntity = {
    id: sceneId,
    campaignId,
    name: B.name,
    sort: 99,
    mapKind: "image",
    mapAssetId: mapId,
    calibration: { ftPerPx: 1 / B.pxPerFt, imageW: W, imageH: H },
    floor: { style: "stone" },
    ambient: { level: "dark", tint: "#FFFFFF" },
    fogMode: "dynamic",
    fogCellFt: 1,
    bounds: { minX: 0, minY: 0, maxX: B.w, maxY: B.h },
    spawn: { x: 12.5, y: 12.5 },
    music: null,
    walls3d: true,
    thumbnailAssetId: null,
    dmNotes: "",
    createdAt: now,
    updatedAt: now,
    archivedAt: opts.archived ? now : null,
    deletedAt: null,
  } as SceneEntity;

  // ── Walls: rooms on a 25-ft grid, each side broken by a gap; 12 of the segments doors ──
  const walls: WallEntity[] = [];
  const wall = (a: V, b: V, kind: WallEntity["kind"] = "wall"): WallEntity =>
    ({
      id: newId("wal"),
      sceneId,
      a,
      b,
      kind,
      doorState: kind === "door" ? "closed" : null,
      hidden: false,
      createdAt: now,
    }) as WallEntity;
  for (let gx = 0; gx < B.w && walls.length < B.walls; gx += 25)
    for (let gy = 0; gy < B.h && walls.length < B.walls; gy += 25) {
      walls.push(
        wall({ x: gx, y: gy }, { x: gx + 10, y: gy }),
        wall({ x: gx + 15, y: gy }, { x: gx + 25, y: gy }),
      );
      walls.push(
        wall({ x: gx, y: gy }, { x: gx, y: gy + 10 }),
        wall({ x: gx, y: gy + 15 }, { x: gx, y: gy + 25 }),
      );
    }
  // Pillars and broken walls in the rooms to make up the count.
  while (walls.length < B.walls) {
    const x = 3 + Math.floor(r() * (B.w / 5 - 1)) * 5;
    const y = 3 + Math.floor(r() * (B.h / 5 - 1)) * 5;
    walls.push(wall({ x, y }, { x: x + 2, y }), wall({ x: x + 2, y }, { x: x + 2, y: y + 2 }));
  }
  walls.length = B.walls;
  for (let i = 0; i < B.doors; i++) {
    const w = walls[i * 4 + 1] as WallEntity;
    w.kind = "door";
    w.doorState = i % 3 === 0 ? "open" : "closed";
  }

  // ── Lights: 20, the first 8 flickering torches ──
  const lights: LightEntity[] = [];
  for (let i = 0; i < B.lights; i++) {
    const preset =
      LIGHT_PRESETS.find((p) => p.id === (i < B.animatedLights ? "torch" : "lantern")) ?? LIGHT_PRESETS[0];
    lights.push({
      id: newId("lgt"),
      sceneId,
      tokenId: null,
      pos: { x: 5 + 25 * (i % 8) + r() * 15, y: 5 + 25 * Math.floor(i / 8) * 2 + r() * 15 },
      elevation: 5,
      bright: preset?.bright ?? 20,
      dim: preset?.dim ?? 20,
      color: preset?.color ?? "#FFB35C",
      intensity: 1,
      animation: i < B.animatedLights ? "torch" : "none",
      coneDeg: null,
      directionDeg: 0,
      magical: false,
      pierceDarkness: false,
      enabled: true,
      dmOnly: false,
      preset: preset?.id ?? null,
      shuttered: false,
      label: `${i < B.animatedLights ? "Torch" : "Lantern"} ${i + 1}`,
    });
  }

  // ── Creatures: 10 minis (3 models), 30 coins and standees; the first 4 coins the players' viewers ──
  const stats = (o: Record<string, unknown>): TokenStats =>
    TokenStatsIn.parse({ ...o, hpMax: o.hpMax ?? o.hp, initBonus: 1 }) as TokenStats;
  const cells: V[] = [];
  for (let gx = 0; gx < B.w; gx += 25)
    for (let gy = 0; gy < B.h; gy += 25) cells.push({ x: gx + 12.5, y: gy + 12.5 });
  const tokens: TokenEntity[] = [];
  const token = (
    i: number,
    name: string,
    mode: "model" | "coin" | "standee",
    assetId: string | null,
    disposition: TokenEntity["disposition"],
    sizeFt: number,
  ): TokenEntity => {
    const c = cells[i % cells.length] as V;
    const off = Math.floor(i / cells.length);
    return {
      id: newId("tok"),
      sceneId,
      actorId: null,
      link: "unlinked",
      name,
      pos: { x: c.x + off * 5 - 2.5, y: c.y + (i % 2 ? 2.5 : -2.5) },
      elevation: 0,
      rotationDeg: Math.floor(r() * 8) * 45,
      sizeFt,
      appearance: { mode, assetId: assetId ?? "", scale: 1, offsetY: 0, rotationOffsetDeg: 0 },
      ownerIds: [],
      disposition,
      hidden: false,
      revealTo: "vision",
      hpDisplay: "bar",
      stats: stats({
        hp: 20 + (i % 13),
        ac: 12 + (i % 5),
        size: sizeFt >= 10 ? "large" : "medium",
        senses: { darkvision: disposition === "party" ? 60 : 30 },
        speeds: { walk: 30 },
      }),
      status: { ...EMPTY_STATUS },
      overrides: {},
      lightId: null,
      locked: false,
      dmNote: "",
      moveMode: "walk",
      createdAt: now,
      updatedAt: now,
    } as TokenEntity;
  };
  for (let i = 0; i < B.viewers; i++) tokens.push(token(i, `Viewer ${i + 1}`, "coin", null, "party", 5));
  for (let i = 0; i < B.minis; i++)
    tokens.push(
      token(
        B.viewers + i,
        `Mini ${i + 1}`,
        "model",
        minis[i % minis.length] as string,
        "hostile",
        i % 3 === 1 ? 10 : 5,
      ),
    );
  for (let i = 0; i < B.otherTokens - B.viewers; i++)
    tokens.push(
      token(
        B.viewers + B.minis + i,
        `Creature ${i + 1}`,
        i % 2 ? "standee" : "coin",
        null,
        i % 4 ? "hostile" : "neutral",
        5,
      ),
    );

  // ── Lasting effects: a fog cloud, a darkness, spirit guardians round a viewer ──
  const effect = (
    name: string,
    shape: EffectEntity["shape"],
    props: Record<string, unknown>,
    vfx: string,
    attached: string | null,
  ): EffectEntity =>
    ({
      id: newId("eff"),
      sceneId,
      name,
      source: { kind: "custom" },
      shape,
      attachedTokenId: attached,
      props,
      triggers: [],
      concentrationTokenId: null,
      expires: { never: true },
      visibility: "everyone",
      vfx,
      movement: null,
      createdAt: now,
    }) as EffectEntity;
  const guardian = tokens[0] as TokenEntity;
  const effects: EffectEntity[] = [
    effect(
      "Fog Cloud",
      { kind: "sphere", origin: { x: 110, y: 60, z: 0 }, radius: 20 },
      { obscurement: "heavy" },
      "cold",
      null,
    ),
    effect(
      "Darkness",
      { kind: "sphere", origin: { x: 60, y: 110, z: 0 }, radius: 15 },
      { magicalDarkness: true, obscurement: "heavy" },
      "necrotic",
      null,
    ),
    effect(
      "Spirit Guardians",
      { kind: "sphere", origin: { x: guardian.pos.x, y: guardian.pos.y, z: 0 }, radius: 15 },
      { difficult: true },
      "radiant",
      guardian.id,
    ),
  ];

  // ── Written as the demo writes its scene: straight to the database, one transaction ──
  const put = (kind: keyof typeof CODECS, e: unknown) => {
    const codec = CODECS[kind] as { table: unknown; toRow: (x: unknown) => Record<string, unknown> };
    ctx.db
      .insert(codec.table as never)
      .values(codec.toRow(e) as never)
      .run();
  };
  ctx.sqlite.transaction(() => {
    put("scene", scene);
    for (const w of walls) put("wall", w);
    for (const l of lights) put("light", l);
    for (const t of tokens) put("token", t);
    for (const e of effects) put("effect", e);
  })();
  return {
    sceneId,
    viewerTokenIds: tokens.slice(0, B.viewers).map((t) => t.id),
    creatureIds: tokens.map((t) => t.id),
  };
}
