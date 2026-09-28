/**
 * A seeded play scene for the vision service, for the benchmark (SPEC §37: 200 × 150 ft, 500 walls, 50 lights,
 * 8 players) and for the tests that check the incremental recompute against a from-scratch one: rooms whose walls are
 * broken by gaps and doors, pillars, fixed lights, creatures (some carrying torches, some players' darkvision
 * viewers), and the events of play — creatures moving (their torches with them) and doors opening and shutting.
 */
import type { CampaignModel as Model } from "../engine/model.ts";
import { CampaignModel } from "../engine/model.ts";
import type { Op } from "../engine/ops.ts";

export interface VisionSceneSize {
  w: number;
  h: number;
  walls: number;
  doors: number;
  fixedLights: number;
  /** Players, each seeing through one darkvision token. */
  players: number;
  /** Other creatures; the first `carried` of them carry torches. */
  creatures: number;
  carried: number;
  seed: number;
}

export const BENCH_SIZE: VisionSceneSize = {
  w: 200,
  h: 150,
  walls: 500,
  doors: 12,
  fixedLights: 38,
  players: 8,
  creatures: 32,
  carried: 12,
  seed: 37,
};

export const SCENE_ID = "scn_benchbenchbench";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface VisionScene {
  model: Model;
  players: string[];
  tokens: string[];
  doors: string[];
  lights: string[];
  /** The next event of play, applied to the model; returns its ops and what kind it was. */
  step(e: number): { ops: Op[]; kind: "door" | "torch" | "viewer" | "creature" };
}

export function buildVisionScene(size: VisionSceneSize): VisionScene {
  const { w: W, h: H } = size;
  const r = rng(size.seed);
  const now = Date.now();
  const campaign = {
    id: "cmp_benchbenchbench",
    name: "Bench",
    coverAssetId: null,
    rulesPack: "srd-5.2.1",
    units: "ft",
    houseRules: {},
    settings: { partyVision: false },
    activeSceneId: SCENE_ID,
    sessionNo: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const model = new CampaignModel(campaign as never);
  model.put("scene", {
    id: SCENE_ID,
    campaignId: campaign.id,
    name: "Bench",
    sort: 0,
    mapKind: "image",
    mapAssetId: null,
    fogMode: "dynamic",
    fogCellFt: 1,
    ambient: { level: "dark", tint: "" },
    bounds: { minX: 0, minY: 0, maxX: W, maxY: H },
    deletedAt: null,
    archivedAt: null,
  } as never);
  // Walls: a grid of 20 × 15-ft rooms whose walls are broken by gaps (or doors), plus pillars.
  let nWalls = 0;
  const doors: string[] = [];
  const wall = (ax: number, ay: number, bx: number, by: number, kind = "wall") => {
    const id = `wal_bench${String(nWalls++).padStart(8, "0")}`;
    model.put("wall", {
      id,
      sceneId: SCENE_ID,
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
      kind,
      doorState: kind === "door" ? "closed" : null,
      hidden: false,
    } as never);
    if (kind === "door") doors.push(id);
  };
  const roomWalls = Math.round(size.walls * 0.84);
  for (let x = 20; x < W && nWalls < roomWalls; x += 20)
    for (let y = 0; y < H && nWalls < roomWalls; y += 15) {
      // A vertical wall piece with a gap (or a door) in its middle.
      wall(x, y, x, y + 6);
      if (doors.length < size.doors && r() < 0.2) wall(x, y + 6, x, y + 9, "door");
      wall(x, y + 9, x, y + 15);
    }
  while (nWalls < size.walls) {
    const x = 5 + r() * (W - 10);
    const y = 5 + r() * (H - 10);
    wall(x, y, x + 2, y);
    if (nWalls < size.walls) wall(x + 2, y, x + 2, y + 2);
  }
  // Tokens: the players' darkvision viewers, then other creatures (the first few carrying torches).
  const tokens: string[] = [];
  const lights: string[] = [];
  const players = Array.from({ length: size.players }, (_, i) => `usr_bench${String(i).padStart(8, "0")}`);
  for (let i = 0; i < size.players + size.creatures; i++) {
    const id = `tok_bench${String(i).padStart(8, "0")}`;
    const viewer = i < size.players;
    const carries = !viewer && i < size.players + size.carried;
    const lightId = carries ? `lgt_bench${String(i).padStart(8, "0")}` : null;
    const pos = { x: 5 + r() * (W - 10), y: 5 + r() * (H - 10) };
    model.put("token", {
      id,
      sceneId: SCENE_ID,
      actorId: null,
      link: "unlinked",
      name: `Creature ${i}`,
      pos,
      elevation: 0,
      rotationDeg: 0,
      sizeFt: 5,
      appearance: { mode: "coin", scale: 1, offsetY: 0, rotationOffsetDeg: 0 },
      ownerIds: viewer ? [players[i] as string] : [],
      disposition: viewer ? "party" : "hostile",
      hidden: false,
      revealTo: "vision",
      hpDisplay: "bar",
      stats: {
        hp: 10,
        hpMax: 10,
        hpTemp: 0,
        ac: 12,
        speeds: { walk: 30, fly: 0, swim: 0, climb: 0, burrow: 0, hover: false },
        senses: { darkvision: viewer ? 60 : 0, blindsight: 0, tremorsense: i === 3 ? 30 : 0, truesight: 0 },
        saves: {},
        dexMod: 0,
        initBonus: 0,
        resist: [],
        immune: [],
        vuln: [],
        conditionImmune: [],
        reachFt: 5,
        size: "medium",
        isPC: viewer,
      },
      status: null,
      overrides: {},
      lightId,
      locked: false,
      dmNote: "",
      moveMode: "walk",
      createdAt: now,
      updatedAt: now,
    } as never);
    tokens.push(id);
    if (lightId) {
      lights.push(lightId);
      model.put("light", {
        id: lightId,
        sceneId: SCENE_ID,
        tokenId: id,
        pos,
        elevation: 0,
        bright: 20,
        dim: 20,
        color: "#FF9A3C",
        intensity: 1,
        animation: "torch",
        coneDeg: null,
        directionDeg: 0,
        magical: false,
        pierceDarkness: false,
        enabled: true,
        dmOnly: false,
        preset: "torch",
      } as never);
    }
  }
  // Fixed lights (sconces, braziers).
  for (let i = 0; i < size.fixedLights; i++) {
    const id = `lgt_fixed${String(i).padStart(8, "0")}`;
    lights.push(id);
    model.put("light", {
      id,
      sceneId: SCENE_ID,
      tokenId: null,
      pos: { x: 5 + r() * (W - 10), y: 5 + r() * (H - 10) },
      elevation: 6,
      bright: 10 + r() * 20,
      dim: 10 + r() * 20,
      color: "#FFB35C",
      intensity: 1,
      animation: "candle",
      coneDeg: null,
      directionDeg: 0,
      magical: false,
      pierceDarkness: false,
      enabled: true,
      dmOnly: false,
      preset: null,
    } as never);
  }

  const step = (e: number): ReturnType<VisionScene["step"]> => {
    const ops: Op[] = [];
    if (doors.length && e % 25 === 24) {
      // A door opens or shuts.
      const id = doors[e % doors.length] as string;
      const d = model.get("wall", id) as { doorState: string };
      const next = { ...d, doorState: d.doorState === "open" ? "closed" : "open" };
      model.put("wall", next as never);
      ops.push({ k: "set", e: "wall", id, path: ["doorState"], value: next.doorState, prev: d.doorState });
      return { ops, kind: "door" };
    }
    // A creature moves up to 30 ft (its torch with it).
    const i = Math.floor(r() * tokens.length);
    const id = tokens[i] as string;
    const t = model.get("token", id) as { pos: { x: number; y: number }; lightId: string | null };
    const pos = {
      x: Math.min(W - 3, Math.max(3, t.pos.x + (r() - 0.5) * 60)),
      y: Math.min(H - 3, Math.max(3, t.pos.y + (r() - 0.5) * 60)),
    };
    model.put("token", { ...t, pos } as never);
    ops.push({ k: "set", e: "token", id, path: ["pos"], value: pos, prev: t.pos });
    if (t.lightId) {
      const l = model.get("light", t.lightId) as { pos: unknown };
      model.put("light", { ...l, pos } as never);
      ops.push({ k: "set", e: "light", id: t.lightId, path: ["pos"], value: pos, prev: l.pos });
    }
    return { ops, kind: t.lightId ? "torch" : i < size.players ? "viewer" : "creature" };
  };

  return { model, players, tokens, doors, lights, step };
}
