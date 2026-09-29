import { contains, type Footprint, footprint, resolveArea } from "@gloam/shared/aoe";
import {
  type P,
  pathLength,
  pointAtLength,
  samplePath,
  type VisPoly,
  visContains,
  visOverlap,
} from "@gloam/shared/geometry";
import { maxMoveLength } from "@gloam/shared/movement";
import { GloamError } from "@gloam/shared/protocol";
import type { EffectEntity, SceneEntity, TokenEntity } from "@gloam/shared/schemas";
import {
  type CellRect,
  coneOf,
  creatureSamples,
  DARK,
  fillVis,
  type LightLevel,
  LightRaster,
  markSeen,
  perceiveCreature,
  prepareViewer,
  Raster,
  rleDecode,
  rleEncode,
  type ViewerSight,
  VisionGeometry,
  type VisionLight,
  VisionWorld,
} from "@gloam/shared/vision";
import type { FogApplier } from "../engine/commandBus.ts";
import { moveDurationMs } from "../engine/commands/move.ts";
import { bodyOf } from "../engine/commands/spells.ts";
import type { CampaignModel } from "../engine/model.ts";
import type { Op, Rect } from "../engine/ops.ts";
import { type IdPrefix, newId } from "../ids.ts";
import type { Perception } from "../rooms/views.ts";
import { FogStore } from "./fogStore.ts";
import { sceneEffects, sceneLights, sceneWalls, tokenCreature, tokenViewer } from "./sources.ts";

/** How often explored memory is written to the database (SPEC §15.5). */
export const EXPLORED_FLUSH_MS = 5000;
/** Path sampling for moves seen partially (SPEC §15.6). */
const MOVE_SAMPLE_FT = 1;

export interface VisionHost {
  /** Player user ids whose vision is computed (online or not). */
  players(): string[];
  /** Sends to every connected client of a user. */
  toUser(userId: string, type: string, payload: unknown): void;
  /** Sends to DMs and spectators (they get the union of every player's fog). */
  toOverseers(type: string, payload: unknown): void;
}

/** A tremorsense marker as a player holds it (§15.4 step 4): an opaque id and the position to 1 ft. */
export interface SensedMark {
  id: string;
  x: number;
  y: number;
}

/** What a client needs to draw fog for one scene (`fog.snapshot`, §15.8). */
export interface FogSnapshot {
  sceneId: string;
  mode: SceneEntity["fogMode"];
  x0: number;
  y0: number;
  cell: number;
  w: number;
  h: number;
  /** Painted reveal layers the client may see: `reveal:all` and its own (DMs and spectators: every one). */
  layers: { layer: string; runs: number[] }[];
  /** Explored memory (dynamic mode): the player's own; for DMs and spectators the union of the players'. */
  explored: number[] | null;
}

/** A clipped move for one viewer (§15.6). */
export interface MoveSeen {
  id: string;
  path: P[];
  durationMs: number;
  /** Wait this long before starting (the part of the move before it came into view). */
  delayMs: number;
  appear: boolean;
  disappear: boolean;
}

interface Player {
  viewers: ViewerSight[];
  key: string;
  perceived: Set<string>;
  /** Carried lights whose light reaches this player's sight while the carrier isn't perceived. */
  lights: Set<string>;
  sensed: Map<string, SensedMark>;
  explored: Raster | null;
  /** What the explored raster was last marked with: raster version, viewer key and sights, light version. */
  marked: Marked;
  /** Whether a carried light reaches this player's sight, by the regions it was worked out from. */
  reach: Map<string, Reach>;
  /** The player's glows: each light in `lights` → its opaque stand-in id (a new one each time it comes back). */
  glows: Map<string, string>;
  /** Effects in view by their area: it meets what they see now or have explored (§13.4). */
  effects: Set<string>;
  /** Effects held up by a creature they don't perceive whose area meets what they see now — seen only as that. */
  glimpses: Set<string>;
  /** Each glimpse → its opaque stand-in id (a new one each time it comes back). */
  glimpseIds: Map<string, string>;
  /** Whether each effect's area met their sight or memory, by what it was worked out from. */
  fxSeen: Map<string, FxSeen>;
}

/** An effect's area against a player's sight and memory, and what that was worked out from. */
interface FxSeen {
  key: string;
  sights: readonly (VisPoly | null)[];
  fog: number;
  /** It meets what they see now. */
  now: boolean;
  /** It meets what they see now or have explored. */
  seen: boolean;
}

/** A carried light's reach for one player, and what it was worked out from (the fog version for painted fog). */
interface Reach {
  lit: VisPoly;
  cone: string;
  sights: (VisPoly | null)[];
  fog: number;
  hit: boolean;
}

interface Marked {
  full: number;
  key: string;
  sights: readonly (VisPoly | null)[];
  light: number;
}
const UNMARKED: Marked = { full: -1, key: "", sights: [], light: -1 };

const newPlayer = (): Player => ({
  viewers: [],
  key: "",
  perceived: new Set(),
  lights: new Set(),
  sensed: new Map(),
  explored: null,
  marked: UNMARKED,
  reach: new Map(),
  glows: new Map(),
  effects: new Set(),
  glimpses: new Set(),
  glimpseIds: new Map(),
  fxSeen: new Map(),
});

/**
 * Stand-in ids for glows and glimpses: kept while a light (an effect) stays one, new when it becomes one again
 * (nothing to link across).
 */
function rekey(
  ids: ReadonlySet<string>,
  was: ReadonlyMap<string, string>,
  prefix: IdPrefix = "lgt",
): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) out.set(id, was.get(id) ?? newId(prefix));
  return out;
}

/** The pseudo-player whose sensed markers spectators hold (the union of the players'). */
const SPECTATORS = "*spectators";

/**
 * The server vision service (SPEC §15.5): for the active scene it keeps the blocking geometry (rebuilt when walls,
 * doors or opaque effects change), the lights and their light raster (refreshed around lights that changed), each
 * player's viewers, the tokens they perceive, the creatures they sense, and their explored memory; it also applies
 * and stores painted fog. Players who perceive a token get it in their view (views.ts asks `perceives`).
 */
export class VisionService implements Perception, FogApplier {
  private readonly store: FogStore;
  private sceneId = "";
  private scene: SceneEntity | null = null;
  private geo: VisionGeometry | null = null;
  private world: VisionWorld | null = null;
  private light: LightRaster | null = null;
  private lightKeys = new Map<string, string>();
  /** Bumped when the whole light raster is rebuilt (a new scene, or magical darkness changed). */
  private fullVersion = 0;
  /** Each light's lit area as last drawn into the raster, and the magical darkness it was drawn with. */
  private lits = new Map<string, VisPoly>();
  private darkKey = "";
  /** Bumped when lights change; `refreshed` holds the cells the latest change re-lit. */
  private lightVersion = 0;
  /** Bumped whenever a fog layer or explored memory changes; snapshots are cached against it. */
  private fogVersion = 0;
  private readonly snapshots = new Map<string, { version: number; sceneId: string; snap: FogSnapshot }>();
  private refreshed: CellRect[] = [];
  private readonly players = new Map<string, Player>();
  /** Painted layers of the active scene (loaded on demand), by layer name. */
  private readonly layers = new Map<string, Raster>();
  private readonly dirtyExplored = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private sensedSeq = 0;
  /** Layers written by fog ops in the commit under way (staged copies), and those ops. */
  private readonly pendingWrites = new Map<string, Raster>();
  private pendingOps: Extract<Op, { k: "fog" }>[] = [];
  /** Fog ops of the active scene committed, until their patches are delivered. */
  private pendingFog: Extract<Op, { k: "fog" }>[] = [];
  /** Recompute durations (ms), for the benchmark (AC-VIS-12). */
  readonly timings: number[] = [];

  private readonly model: CampaignModel;
  private readonly host: VisionHost;
  private readonly now: () => number;

  constructor(
    model: CampaignModel,
    db: ConstructorParameters<typeof FogStore>[0],
    host: VisionHost,
    now: () => number = Date.now,
  ) {
    this.model = model;
    this.host = host;
    this.now = now;
    this.store = new FogStore(db);
    this.flushTimer = setInterval(() => this.flush(), EXPLORED_FLUSH_MS);
    this.flushTimer.unref?.();
    this.activate();
  }

  dispose(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  get activeSceneId(): string {
    return this.sceneId;
  }

  // ── Perception (views.ts) ──────────────────────────────────────────────────────────────────────────────

  perceives(userId: string, t: TokenEntity): boolean {
    if (!this.scene || t.sceneId !== this.sceneId || this.scene.fogMode === "off") return true;
    return this.player(userId).perceived.has(t.id);
  }

  /**
   * Whether a player gets a carried light whose carrier they don't perceive: its light reaches their sight (they see
   * the glow round the corner, not who holds it). Free-standing lights are public.
   */
  seesLight(userId: string | null, lightId: string): boolean {
    if (!this.scene || this.scene.fogMode === "off") return true;
    if (userId === null) {
      for (const [u, p] of this.players) if (u !== SPECTATORS && p.lights.has(lightId)) return true;
      return false;
    }
    return this.player(userId).lights.has(lightId);
  }

  /**
   * The glows a user holds: carried lights whose carrier they don't perceive but whose light reaches what they see
   * (players: their own; spectators: the union) — each as an opaque stand-in id, never the light's own.
   */
  glowsFor(userId: string | null): { id: string; lightId: string }[] {
    if (!this.scene || this.scene.fogMode === "off") return [];
    const p = this.player(userId ?? SPECTATORS);
    return [...p.glows].map(([lightId, id]) => ({ id, lightId }));
  }

  /**
   * Whether a player's view holds an effect by its area (§13.4): it meets what they see now or have explored (fog off:
   * every effect). One held up by a creature they don't perceive comes, if at all, as a glimpse (`glimpsesFor`).
   */
  seesEffect(userId: string | null, effectId: string): boolean {
    if (!this.scene || this.scene.fogMode === "off") return true;
    return this.player(userId ?? SPECTATORS).effects.has(effectId);
  }

  /** The effects a user sees only by their area — each as an opaque stand-in id, never the effect's own. */
  glimpsesFor(userId: string | null): { id: string; effectId: string }[] {
    if (!this.scene || this.scene.fogMode === "off") return [];
    const p = this.player(userId ?? SPECTATORS);
    return [...p.glimpseIds].map(([effectId, id]) => ({ id, effectId }));
  }

  /** Every effect stand-in any user holds (the state carries exactly these). */
  allGlimpses(): { id: string; effectId: string }[] {
    if (!this.scene || this.scene.fogMode === "off") return [];
    const out: { id: string; effectId: string }[] = [];
    for (const p of this.players.values())
      for (const [effectId, id] of p.glimpseIds) out.push({ id, effectId });
    return out;
  }

  /** Every stand-in any user holds (the state carries exactly these). */
  allGlows(): { id: string; lightId: string }[] {
    if (!this.scene || this.scene.fogMode === "off") return [];
    const out: { id: string; lightId: string }[] = [];
    for (const p of this.players.values()) for (const [lightId, id] of p.glows) out.push({ id, lightId });
    return out;
  }

  /** The sensed markers a user holds (players: their own; spectators: the union). */
  sensedFor(userId: string | null): SensedMark[] {
    if (this.scene?.fogMode !== "dynamic") return [];
    return [...this.player(userId ?? SPECTATORS).sensed.values()];
  }

  /** The players whose vision is computed. */
  playerIds(): string[] {
    return [...this.players.keys()].filter((u) => u !== SPECTATORS);
  }

  /** Whether a user plays in this campaign (a player the table knows, or someone who owns or shares a token). */
  private playsHere(userId: string): boolean {
    return this.host.players().includes(userId) || this.viewerOwners().includes(userId);
  }

  /** Every sensed marker held by anyone (the state's `sensed` collection). */
  allSensed(): SensedMark[] {
    const out: SensedMark[] = [];
    for (const p of this.players.values()) for (const m of p.sensed.values()) out.push(m);
    return out;
  }

  // ── Recompute ─────────────────────────────────────────────────────────────────────────────────────────

  /** After a commit: rebuild what changed and recompute players. Returns whether any perception changed. */
  onCommitted(ops: readonly Op[]): boolean {
    const active = this.model.activeScene;
    const id = active && !active.deletedAt ? active.id : "";
    if (id !== this.sceneId) {
      this.flush();
      this.activate();
      return true;
    }
    if (!id) return false;
    let full = false;
    let geo = false;
    let any = false;
    for (const o of ops) {
      if (o.k === "fog") {
        // Painted reveals change painted perception; explored resets are already in the rasters.
        if (o.sceneId === id) any = true;
        continue;
      }
      if (o.k === "sheet") {
        any = true;
        continue;
      }
      if (o.e === "scene") {
        if (o.id === id) full = true;
        continue;
      }
      if (o.e === "wall" || o.e === "effect") {
        const sceneOf =
          o.k === "create"
            ? (o.value as { sceneId?: string }).sceneId
            : o.k === "delete"
              ? (o.prev as { sceneId?: string }).sceneId
              : (this.model.get(o.e, o.id) as { sceneId?: string } | undefined)?.sceneId;
        if (sceneOf === id) geo = true;
        continue;
      }
      if (o.e === "token" || o.e === "light" || o.e === "actor" || o.e === "campaign") any = true;
    }
    if (full) {
      this.activate();
      return true;
    }
    if (!geo && !any) return false;
    return this.recompute(geo);
  }

  /** Loads the active scene: geometry, lights, layers; recomputes every player. */
  private activate(): void {
    this.fogVersion++;
    const active = this.model.activeScene;
    const scene = active && !active.deletedAt ? active : null;
    this.sceneId = scene?.id ?? "";
    this.scene = scene;
    this.geo = null;
    this.world = null;
    this.light = null;
    this.lightKeys.clear();
    this.lits.clear();
    this.layers.clear();
    this.players.clear();
    if (!scene) return;
    this.recompute(true);
  }

  /** The raster shape of a scene's fog (its bounds at its fog cell size). */
  shape(sceneId: string): Raster | null {
    const s = sceneId === this.sceneId ? this.scene : this.model.get("scene", sceneId);
    return s ? Raster.over(s.bounds, s.fogCellFt) : null;
  }

  private recompute(geoChanged: boolean): boolean {
    const scene = this.scene;
    if (!scene) return false;
    const t0 = performance.now();
    // The scene entity may have been replaced by a commit; keep the live one.
    this.scene = this.model.get("scene", this.sceneId) ?? scene;
    // Fog off: everyone sees every token that isn't DM-hidden — nothing to compute (turning fog on is a scene change,
    // which rebuilds everything).
    if (this.scene.fogMode === "off") {
      this.geo = null;
      this.world = null;
      this.light = null;
      this.lightKeys.clear();
      this.lits.clear();
      return false;
    }
    const fx = sceneEffects(this.model, this.sceneId);
    if (geoChanged || !this.geo)
      this.geo = VisionGeometry.after(this.geo, sceneWalls(this.model, this.sceneId), fx.opaque, fx.solid);
    const lights = [...sceneLights(this.model, this.sceneId), ...fx.lights];
    const world = new VisionWorld(
      this.geo,
      lights,
      this.scene.ambient.level,
      this.scene.bounds,
      fx.obscurers,
    );
    // The light raster: around the lights that moved, changed or whose lit area a wall change reshaped; all of it for
    // a new scene or when magical darkness changed.
    const keys = new Map(world.lights.map((l) => [l.id, lightKey(l)] as const));
    const lits = new Map(world.lights.map((l) => [l.id, world.litOf(l)] as const));
    const darkKey = JSON.stringify(fx.obscurers);
    if (!this.light || !this.world || darkKey !== this.darkKey) {
      this.light = new LightRaster(this.scene.bounds, this.scene.fogCellFt);
      this.light.build(world);
      this.fullVersion++;
    } else {
      const areas: number[][] = [];
      for (const [id, k] of keys) {
        const was = this.lightKeys.get(id);
        if (was === k && this.lits.get(id) === lits.get(id)) continue;
        areas.push(areaOf(k));
        if (was !== undefined && was !== k) areas.push(areaOf(was));
      }
      for (const [id, k] of this.lightKeys) if (!keys.has(id)) areas.push(areaOf(k));
      for (const [x0, y0, x1, y1] of areas)
        this.light.refresh(world, x0 as number, y0 as number, x1 as number, y1 as number);
      if (areas.length) {
        this.lightVersion++;
        this.refreshed = areas.map(([x0, y0, x1, y1]) =>
          this.light!.raster.cellsIn(x0 as number, y0 as number, x1 as number, y1 as number),
        );
      }
    }
    this.lightKeys = keys;
    this.lits = lits;
    this.darkKey = darkKey;
    this.world = world;
    let changed = false;
    const ids = new Set([...this.host.players(), ...this.players.keys(), ...this.viewerOwners()]);
    ids.delete(SPECTATORS);
    for (const u of ids) if (this.update(u)) changed = true;
    if (this.updateSpectators()) changed = true;
    this.timings.push(performance.now() - t0);
    if (this.timings.length > 2000) this.timings.splice(0, 1000);
    return changed;
  }

  /** Users who can have viewers in the scene (owners and those shared with). */
  private viewerOwners(): string[] {
    const out = new Set<string>();
    for (const t of this.model.inScene("token", this.sceneId)) {
      for (const u of t.ownerIds) out.add(u);
      for (const u of t.overrides.shareVisionWith ?? []) out.add(u);
    }
    return [...out];
  }

  private player(userId: string): Player {
    let p = this.players.get(userId);
    if (!p) {
      p = newPlayer();
      this.players.set(userId, p);
      if (userId === SPECTATORS) this.updateSpectators();
      else this.update(userId);
    }
    return p;
  }

  /** The tokens a user sees through: their own, those shared with them, and the party's with party vision on. */
  private viewerTokens(userId: string): TokenEntity[] {
    const party = this.model.campaign.settings.partyVision === true;
    return this.model
      .inScene("token", this.sceneId)
      .filter(
        (t) =>
          !t.hidden &&
          (t.ownerIds.includes(userId) ||
            (t.overrides.shareVisionWith ?? []).includes(userId) ||
            (party && t.disposition === "party" && t.ownerIds.length > 0)),
      );
  }

  /** Recomputes one player; returns whether what they perceive changed. */
  private update(userId: string): boolean {
    const scene = this.scene;
    const world = this.world;
    if (!scene || !world) return false;
    let p = this.players.get(userId);
    if (!p) {
      p = newPlayer();
      this.players.set(userId, p);
    }
    const perceived = new Set<string>();
    const sensed = new Map<string, SensedMark>();
    if (scene.fogMode === "painted") {
      const revealed = this.revealedFor(userId);
      for (const t of this.model.inScene("token", this.sceneId)) {
        if (t.hidden) continue;
        if (creatureSamples(tokenCreature(this.model, t)).some((s) => revealed(s.x, s.y)))
          perceived.add(t.id);
      }
    } else if (scene.fogMode === "dynamic") {
      const tokens = this.viewerTokens(userId);
      const viewers = tokens.map((t) => prepareViewer(world, tokenViewer(this.model, t)));
      p.viewers = viewers;
      p.key = viewers.map((v) => viewerKey(v)).join("|");
      const mine = new Set(tokens.map((t) => t.id));
      for (const t of this.model.inScene("token", this.sceneId)) {
        if (t.hidden) continue;
        if (mine.has(t.id)) {
          perceived.add(t.id);
          continue;
        }
        const seen = perceiveCreature(world, viewers, tokenCreature(this.model, t), this.ownLight(t));
        if (seen === "seen") perceived.add(t.id);
        else if (seen === "sensed") {
          const prev = p.sensed.get(t.id);
          sensed.set(t.id, {
            id: prev?.id ?? `s${(++this.sensedSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            x: Math.round(t.pos.x),
            y: Math.round(t.pos.y),
          });
        }
      }
      this.markExplored(userId, p);
    }
    const lights = this.lightsReaching(userId, p, perceived);
    const fx = this.effectsFor(userId, p, perceived);
    const changed =
      !sameSet(perceived, p.perceived) ||
      !sameSensed(sensed, p.sensed) ||
      !sameSet(lights, p.lights) ||
      !sameSet(fx.seen, p.effects) ||
      !sameSet(fx.glimpses, p.glimpses);
    p.perceived = perceived;
    p.sensed = sensed;
    p.lights = lights;
    p.glows = rekey(lights, p.glows);
    p.effects = fx.seen;
    p.glimpses = fx.glimpses;
    p.glimpseIds = rekey(fx.glimpses, p.glimpseIds, "eff");
    return changed;
  }

  /**
   * The effects a player's view holds by their area (SPEC §13.4): one whose area meets what they see now (dynamic:
   * their viewers' sight; painted: the cells revealed to them) or have explored. One held up by a creature they don't
   * perceive — an emanation's source, a light's holder — only while its area meets what they see now, and then as a
   * glimpse: where it is, never whose (a DM-hidden or invisible creature's Spirit Guardians give no position, no id).
   * Its area is sampled on a grid (and along its edge); a result is kept while neither side of it changed, and an
   * area once seen stays seen until it moves (explored memory only grows; a reset bumps the fog version).
   */
  private effectsFor(
    userId: string,
    p: Player,
    perceived: ReadonlySet<string>,
  ): { seen: Set<string>; glimpses: Set<string> } {
    const seen = new Set<string>();
    const glimpses = new Set<string>();
    const scene = this.scene;
    if (!scene || scene.fogMode === "off") return { seen, glimpses };
    const revealed = scene.fogMode === "painted" ? this.revealedFor(userId) : null;
    const explored = scene.fogMode === "dynamic" ? this.exploredOf(userId, p) : null;
    const sights = revealed ? [] : p.viewers.map((v) => v.sight);
    const nowAt = (x: number, y: number) =>
      revealed ? revealed(x, y) : sights.some((s) => s !== null && visContains(s, x, y));
    const cache = new Map<string, FxSeen>();
    for (const e of this.model.inScene("effect", this.sceneId)) {
      if (e.visibility !== "everyone") continue;
      const area = resolveArea(e.shape, (id) => {
        const t = this.model.get("token", id);
        return t ? bodyOf(t) : null;
      });
      if (!area) continue;
      const key = JSON.stringify(area);
      const was = p.fxSeen.get(e.id);
      let r: FxSeen;
      if (was && was.key === key && was.fog === this.fogVersion && sameSights(was.sights, sights)) r = was;
      else {
        const pts = footprintSamples(footprint(area), Math.max(2.5, scene.fogCellFt));
        const now = pts.some((q) => nowAt(q.x, q.y));
        // Explored memory only grows: an area already seen stays seen while it stays where it is.
        const kept = was !== undefined && was.key === key && was.fog === this.fogVersion && was.seen;
        const seenNow = now || kept || (explored !== null && pts.some((q) => explored.at(q.x, q.y) !== 0));
        r = { key, sights, fog: this.fogVersion, now, seen: seenNow };
      }
      cache.set(e.id, r);
      const anchor = anchorOf(e);
      if (anchor && !this.anchorSeen(userId, anchor, perceived)) {
        if (r.now) glimpses.add(e.id);
      } else if (r.seen) seen.add(e.id);
    }
    p.fxSeen = cache;
    return { seen, glimpses };
  }

  /** Whether a player holds the creature an effect hangs on (as views.ts decides it: never a DM-hidden one). */
  private anchorSeen(userId: string, tokenId: string, perceived: ReadonlySet<string>): boolean {
    const t = this.model.get("token", tokenId);
    if (!t || t.hidden) return false;
    if (t.ownerIds.includes(userId)) return true;
    if (t.revealTo === "all" || (Array.isArray(t.revealTo) && t.revealTo.includes(userId))) return true;
    return perceived.has(tokenId);
  }

  /**
   * Carried lights whose carrier the player doesn't perceive but whose lit area reaches what they see (dynamic: their
   * viewers' sight; painted: the cells revealed to them) — the glow round the corner. Only these matter: a perceived
   * carrier's light comes with it. Exact — the lit area (cut to its cone) overlapping the sight in area, not merely
   * touching it along a wall — and remembered while neither region changes.
   */
  private lightsReaching(userId: string, p: Player, perceived: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    const world = this.world;
    const scene = this.scene;
    if (!world || !scene) return out;
    const revealed = scene.fogMode === "painted" ? this.revealedFor(userId) : null;
    const reach = new Map<string, Reach>();
    for (const l of world.lights) {
      if (l.id.startsWith("fx:")) continue;
      const tokenId = this.model.get("light", l.id)?.tokenId;
      if (!tokenId || perceived.has(tokenId)) continue;
      const lit = world.litOf(l);
      const cone = coneOf(l);
      const coneKey = cone ? `${cone.dir},${cone.half}` : "";
      const was = p.reach.get(l.id);
      let hit: boolean;
      if (revealed) {
        // Painted fog is cells: a revealed cell whose centre the light reaches (again only when the light's area or
        // the revealed cells changed).
        if (was && was.lit === lit && was.cone === coneKey && was.fog === this.fogVersion) hit = was.hit;
        else {
          let found = false;
          fillVis(this.light?.raster as Raster, lit, (_k, cx, cy) => {
            if (world.levelFrom(l, cx, cy) > DARK && revealed(cx, cy)) found = true;
            return found;
          });
          hit = found;
        }
        reach.set(l.id, { lit, cone: coneKey, sights: [], fog: this.fogVersion, hit });
        if (hit) out.add(l.id);
        continue;
      }
      const sights = p.viewers.map((v) => v.sight);
      if (
        was &&
        was.fog < 0 &&
        was.lit === lit &&
        was.cone === coneKey &&
        was.sights.length === sights.length &&
        was.sights.every((s, i) => s === sights[i])
      )
        hit = was.hit;
      else hit = sights.some((s) => s !== null && visOverlap(lit, s, cone));
      reach.set(l.id, { lit, cone: coneKey, sights, fog: -1, hit });
      if (hit) out.add(l.id);
    }
    p.reach = reach;
    return out;
  }

  /** Spectators: the union of the players' perceptions; sensed = sensed by someone and seen by nobody. */
  private updateSpectators(): boolean {
    const scene = this.scene;
    let p = this.players.get(SPECTATORS);
    if (!p) {
      p = newPlayer();
      this.players.set(SPECTATORS, p);
    }
    const seen = new Set<string>();
    const pos = new Map<string, { x: number; y: number }>();
    if (scene?.fogMode === "dynamic")
      for (const [u, q] of this.players) {
        if (u === SPECTATORS) continue;
        for (const id of q.perceived) seen.add(id);
      }
    for (const [u, q] of this.players) {
      if (u === SPECTATORS) continue;
      for (const [tokenId, m] of q.sensed) if (!seen.has(tokenId)) pos.set(tokenId, { x: m.x, y: m.y });
    }
    const sensed = new Map<string, SensedMark>();
    for (const [tokenId, xy] of pos) {
      const prev = p.sensed.get(tokenId);
      sensed.set(tokenId, { id: prev?.id ?? `s${(++this.sensedSeq).toString(36)}v`, ...xy });
    }
    // Glows: any player's, unless some player perceives the carrier (then spectators hold the light itself).
    const perceivedByAny = new Set<string>();
    for (const [u, q] of this.players)
      if (u !== SPECTATORS) for (const id of q.perceived) perceivedByAny.add(id);
    const lights = new Set<string>();
    for (const [u, q] of this.players) {
      if (u === SPECTATORS) continue;
      for (const id of q.lights) {
        const carrier = this.model.get("light", id)?.tokenId;
        if (carrier && !perceivedByAny.has(carrier)) lights.add(id);
      }
    }
    // Effects: any player's; a glimpse unless some player holds the effect itself (then spectators hold it too).
    const effects = new Set<string>();
    for (const [u, q] of this.players) if (u !== SPECTATORS) for (const id of q.effects) effects.add(id);
    const glimpses = new Set<string>();
    for (const [u, q] of this.players)
      if (u !== SPECTATORS) for (const id of q.glimpses) if (!effects.has(id)) glimpses.add(id);
    const changed =
      !sameSensed(sensed, p.sensed) ||
      !sameSet(lights, p.lights) ||
      !sameSet(effects, p.effects) ||
      !sameSet(glimpses, p.glimpses);
    p.sensed = sensed;
    p.lights = lights;
    p.glows = rekey(lights, p.glows);
    p.effects = effects;
    p.glimpses = glimpses;
    p.glimpseIds = rekey(glimpses, p.glimpseIds, "eff");
    return changed;
  }

  /** A creature carrying a lit light is lit at its own spot (its samples are well inside its own bright light). */
  private ownLight(t: TokenEntity): LightLevel | undefined {
    if (!t.lightId) return undefined;
    const l = this.model.get("light", t.lightId);
    if (!l?.enabled || l.dmOnly) return undefined;
    const bright = l.shuttered ? 0 : l.bright;
    const dim = l.shuttered ? 5 : l.dim;
    const r = 0.8 * (t.sizeFt / 2);
    return bright >= r ? 2 : bright + dim >= r ? 1 : undefined;
  }

  // ── Explored memory ───────────────────────────────────────────────────────────────────────────────────

  private exploredOf(userId: string, p: Player): Raster {
    if (!p.explored) {
      const shape = this.shape(this.sceneId) as Raster;
      p.explored = this.store.load(this.sceneId, `explored:${userId}`, shape);
    }
    return p.explored;
  }

  private markExplored(userId: string, p: Player): void {
    if (!this.world || !this.light || !p.viewers.length) return;
    const m = p.marked;
    const sights = p.viewers.map((v) => v.sight);
    // Marking only adds: with the same sight and viewers, only cells whose light changed can newly be seen.
    let clips: CellRect[] | undefined;
    if (
      m.full === this.fullVersion &&
      m.key === p.key &&
      m.sights.length === sights.length &&
      m.sights.every((s, i) => s === sights[i])
    ) {
      if (m.light === this.lightVersion) return;
      if (m.light === this.lightVersion - 1) clips = this.refreshed;
    }
    p.marked = { full: this.fullVersion, key: p.key, sights, light: this.lightVersion };
    const raster = this.exploredOf(userId, p);
    const before = raster.data.slice();
    const rect = markSeen(this.world, this.light, p.viewers, raster, clips);
    if (!rect) return;
    const cells = raster.read(rect);
    const old = new Raster(0, 0, 1, rect.w, rect.h, sliceRect(before, raster.w, rect));
    // Only the newly seen cells travel: clients OR them in (spectators and DMs get everyone's).
    for (let k = 0; k < cells.length; k++) if (old.data[k]) cells[k] = 0;
    this.fogVersion++;
    const payload = { sceneId: this.sceneId, ...rect, runs: rleEncode(cells) };
    this.host.toUser(userId, "explored.patch", payload);
    this.host.toOverseers("explored.patch", payload);
    this.dirtyExplored.add(userId);
  }

  /** Writes changed explored rasters (every 5 s, on scene change, table close and shutdown). */
  flush(): void {
    if (!this.sceneId) {
      this.dirtyExplored.clear();
      return;
    }
    const now = this.now();
    for (const u of this.dirtyExplored) {
      const r = this.players.get(u)?.explored;
      if (r) this.store.save(this.sceneId, `explored:${u}`, r, now);
    }
    this.dirtyExplored.clear();
  }

  // ── Painted fog ───────────────────────────────────────────────────────────────────────────────────────

  /** The current raster of a fog layer (a copy for inactive scenes). */
  layer(sceneId: string, layer: string): Raster {
    const shape = this.shape(sceneId);
    if (!shape) throw new Error(`no scene ${sceneId}`);
    if (sceneId !== this.sceneId) return this.store.load(sceneId, layer, shape);
    if (layer.startsWith("explored:")) {
      const u = layer.slice("explored:".length);
      return this.exploredOf(u, this.player(u));
    }
    let r = this.layers.get(layer);
    if (!r) {
      r = this.store.load(sceneId, layer, shape);
      this.layers.set(layer, r);
    }
    return r;
  }

  /** FogApplier: the layers a scene has with a prefix, stored or in memory (explored rasters not yet written too). */
  layerNames(sceneId: string, prefix: string): string[] {
    const names = new Set(this.store.layers(sceneId, prefix));
    if (sceneId === this.sceneId) {
      for (const n of this.layers.keys()) if (n.startsWith(prefix)) names.add(n);
      if ("explored:".startsWith(prefix) || prefix.startsWith("explored:"))
        for (const [u, p] of this.players)
          if (u !== SPECTATORS && p.explored?.any() && `explored:${u}`.startsWith(prefix))
            names.add(`explored:${u}`);
    }
    return [...names];
  }

  /** Every reveal layer stored for the active scene (plus `reveal:all`). */
  private revealLayers(): string[] {
    const names = new Set([
      "reveal:all",
      ...this.store.layers(this.sceneId, "reveal:"),
      ...this.layers.keys(),
    ]);
    return [...names].filter((n) => n.startsWith("reveal:"));
  }

  private revealedFor(userId: string): (x: number, y: number) => boolean {
    const all = this.layer(this.sceneId, "reveal:all");
    const own = this.layer(this.sceneId, `reveal:${userId}`);
    return (x, y) => all.at(x, y) === 1 || own.at(x, y) === 1;
  }

  /** FogApplier: stages a fog op's cells on a copy of the layer (committed with the command, §14.1). */
  apply(op: Extract<Op, { k: "fog" }>): void {
    const key = `${op.sceneId}|${op.layer}`;
    let r = this.pendingWrites.get(key);
    if (!r) {
      const live = this.layer(op.sceneId, op.layer);
      r = new Raster(live.x0, live.y0, live.cell, live.w, live.h, live.data.slice());
      this.pendingWrites.set(key, r);
    }
    r.write(op.rect, rleDecode(parseRuns(op.after), op.rect.w * op.rect.h));
    this.pendingOps.push(op);
  }

  persist(sceneId: string, layer: string): void {
    const r = this.pendingWrites.get(`${sceneId}|${layer}`);
    if (r) this.store.save(sceneId, layer, r, this.now());
  }

  commit(): void {
    if (this.pendingWrites.size) this.fogVersion++;
    for (const [key, staged] of this.pendingWrites) {
      const [sceneId, layer] = key.split("|") as [string, string];
      if (sceneId !== this.sceneId) continue; // stored; inactive scenes aren't kept in memory
      this.layer(sceneId, layer).data.set(staged.data);
      if (layer.startsWith("explored:")) {
        const u = layer.slice("explored:".length);
        const p = this.players.get(u);
        if (p) p.marked = UNMARKED; // marked again from where they stand
        this.dirtyExplored.delete(u);
      }
    }
    for (const op of this.pendingOps) if (op.sceneId === this.sceneId) this.pendingFog.push(op);
    this.discard();
  }

  discard(): void {
    this.pendingWrites.clear();
    this.pendingOps = [];
  }

  /** After a commit with fog ops: the layers' patches to the clients that hold them. */
  deliverFog(): void {
    const ops = this.pendingFog;
    this.pendingFog = [];
    for (const op of ops) {
      const r = this.layer(op.sceneId, op.layer);
      const payload = { sceneId: op.sceneId, layer: op.layer, ...op.rect, runs: rleEncode(r.read(op.rect)) };
      if (op.layer.startsWith("explored:")) {
        // Explored memory went back (a reset or an undo): the player and the overseers re-read it whole.
        const u = op.layer.slice("explored:".length);
        this.host.toUser(u, "fog.reload", { sceneId: op.sceneId });
        this.host.toOverseers("fog.reload", { sceneId: op.sceneId });
        continue;
      }
      if (op.layer === "reveal:all")
        for (const u of this.host.players()) this.host.toUser(u, "fog.patch", payload);
      else this.host.toUser(op.layer.slice("reveal:".length), "fog.patch", payload);
      this.host.toOverseers("fog.patch", payload);
    }
  }

  /** `fog.snapshot` for one client (§15.8). */
  snapshot(userId: string, overseer: boolean): FogSnapshot | null {
    const scene = this.scene;
    const shape = this.shape(this.sceneId);
    if (!scene || !shape) return null;
    // Nothing changed since the last ask: the same answer (the work is proportional to the scene's cells).
    const cacheKey = overseer ? "" : userId;
    const hit = this.snapshots.get(cacheKey);
    if (hit && hit.version === this.fogVersion && hit.sceneId === this.sceneId) return hit.snap;
    const snap = this.buildSnapshot(userId, overseer, scene, shape);
    if (this.snapshots.size > 64) this.snapshots.clear();
    this.snapshots.set(cacheKey, { version: this.fogVersion, sceneId: this.sceneId, snap });
    return snap;
  }

  private buildSnapshot(userId: string, overseer: boolean, scene: SceneEntity, shape: Raster): FogSnapshot {
    const names = overseer ? this.revealLayers() : ["reveal:all", `reveal:${userId}`];
    const layers = names.map((layer) => ({ layer, runs: rleEncode(this.layer(this.sceneId, layer).data) }));
    let explored: number[] | null = null;
    if (scene.fogMode === "dynamic") {
      if (overseer) {
        const union = new Uint8Array(shape.w * shape.h);
        const users = new Set([
          ...this.host.players(),
          ...this.viewerOwners(),
          ...this.store.layers(this.sceneId, "explored:").map((l) => l.slice(9)),
        ]);
        for (const u of users) {
          // Someone not in play is read from the store, not made a player (who'd be recomputed on every commit).
          const live = this.players.get(u)?.explored;
          const r = live ?? this.store.load(this.sceneId, `explored:${u}`, shape);
          for (let k = 0; k < union.length; k++) if (r.data[k]) union[k] = 1;
        }
        explored = rleEncode(union);
      } else explored = rleEncode(this.layer(this.sceneId, `explored:${userId}`).data);
    }
    return {
      sceneId: this.sceneId,
      mode: scene.fogMode,
      x0: shape.x0,
      y0: shape.y0,
      cell: shape.cell,
      w: shape.w,
      h: shape.h,
      layers,
      explored,
    };
  }

  /** What a player would hold (View as, §8.8): their tokens, sensed markers and fog. */
  viewAs(userId: string): {
    tokens: string[];
    sensed: SensedMark[];
    viewers: string[];
    fog: FogSnapshot | null;
  } {
    // Only someone who plays here: an arbitrary id would become a player recomputed on every commit.
    if (!this.playsHere(userId)) throw new GloamError("NOT_FOUND", "No such player.");
    const scene = this.scene;
    const tokens: string[] = [];
    for (const t of this.model.inScene("token", this.sceneId)) {
      if (t.hidden) continue;
      const shown =
        t.ownerIds.includes(userId) ||
        t.revealTo === "all" ||
        (Array.isArray(t.revealTo) && t.revealTo.includes(userId)) ||
        this.perceives(userId, t);
      if (shown) tokens.push(t.id);
    }
    return {
      tokens,
      sensed: this.sensedFor(userId),
      viewers: scene?.fogMode === "dynamic" ? this.viewerTokens(userId).map((t) => t.id) : [],
      fog: this.snapshot(userId, false),
    };
  }

  // ── Moves seen partially (§15.6) ──────────────────────────────────────────────────────────────────────

  /**
   * How a user sees a move: the whole path, the part between where it came into and went out of their perception
   * (with the destination left out when they can't perceive it there), or nothing. Null = nothing.
   */
  clipMove(userId: string, tokenId: string, path: P[], durationMs: number): MoveSeen | null {
    const t = this.model.get("token", tokenId);
    const full = { id: tokenId, path, durationMs, delayMs: 0, appear: false, disappear: false };
    const sees = this.sighting(userId, t);
    if (sees === null) return null;
    if (sees === true) return full;
    const L = pathLength(path);
    // Every foot of the way (§15.6); a route is at most MAX_MOVE_FT long (move.commit), so this is bounded.
    const n = Math.max(1, Math.ceil(L / MOVE_SAMPLE_FT));
    const samples = samplePath(path, n);
    let first = -1;
    let last = -1;
    for (let k = 0; k < samples.length; k++) {
      if (sees(samples[k] as P)) {
        if (first < 0) first = k;
        last = k;
      }
    }
    if (first < 0) return null;
    if (first === 0 && last === samples.length - 1) return full;
    const s0 = (first * L) / n;
    const s1 = (last * L) / n;
    const seen = subPath(path, s0, s1);
    // Timed from what's seen alone: the unseen part's length (before it appears, after it vanishes, or in all) isn't
    // told by a delay or a pace.
    return {
      id: tokenId,
      path: seen,
      delayMs: 0,
      durationMs: moveDurationMs(pathLength(seen)),
      appear: first > 0,
      disappear: last < samples.length - 1,
    };
  }

  /**
   * What a viewer may see of a drag preview (§15.6 applied to planning): the route up to where they'd lose sight of
   * the token — never where it's heading beyond that — or null when they don't perceive it where it stands.
   */
  clipPreview(userId: string, tokenId: string, points: P[]): { points: P[]; full: boolean } | null {
    const t = this.model.get("token", tokenId);
    const sees = this.sighting(userId, t);
    if (sees === null) return null;
    if (sees === true || points.length < 2) return { points, full: true };
    const L = Math.min(pathLength(points), this.scene ? maxMoveLength(this.scene.bounds) : 0);
    const n = Math.max(1, Math.ceil(L / MOVE_SAMPLE_FT));
    const samples = samplePath(points, n);
    let last = -1;
    for (let k = 0; k < samples.length && sees(samples[k] as P); k++) last = k;
    if (last < 0) return null;
    if (last === samples.length - 1 && L >= pathLength(points) - 1e-6) return { points, full: true };
    return { points: subPath(points, 0, (last * L) / n), full: false };
  }

  /**
   * Whether a viewer perceives a token standing at a point: `true` (everywhere: fog off, their own, revealed to
   * them), `null` (never: DM-hidden, another scene) or a test per point.
   */
  private sighting(userId: string, t: TokenEntity | undefined): ((at: P) => boolean) | true | null {
    // DM-hidden tokens never reach players, moving or not (AC-TOK-08).
    if (!t || t.hidden) return null;
    if (!this.scene || this.scene.fogMode === "off" || t.sceneId !== this.sceneId) return true;
    if (
      t.ownerIds.includes(userId) ||
      t.revealTo === "all" ||
      (Array.isArray(t.revealTo) && t.revealTo.includes(userId))
    )
      return true;
    const creature = tokenCreature(this.model, t);
    const lit = this.ownLight(t);
    const p = this.player(userId);
    // The mover's own light travels with it: lights at its destination don't light the path behind.
    const world = this.world && t.lightId ? this.worldWithout(t.lightId) : this.world;
    const revealed = this.scene.fogMode === "painted" ? this.revealedFor(userId) : null;
    return (at: P) => {
      const c = { ...creature, x: at.x, y: at.y };
      if (revealed) return creatureSamples(c).some((q) => revealed(q.x, q.y));
      return world !== null && perceiveCreature(world, p.viewers, c, lit) === "seen";
    };
  }

  private worldWithout(lightId: string): VisionWorld | null {
    const w = this.world;
    if (!w) return null;
    return new VisionWorld(
      w.geo,
      w.lights.filter((l) => l.id !== lightId),
      w.ambient,
      w.bounds,
      w.obscurers,
    );
  }
}

function lightKey(l: VisionLight): string {
  return `${l.x},${l.y},${l.bright},${l.dim},${l.coneDeg},${l.directionDeg},${l.magical},${l.pierceDarkness},${l.z ?? 0}`;
}
function areaOf(key: string): number[] {
  const [x, y, b, d] = key.split(",").map(Number) as [number, number, number, number];
  const r = b + d + 1;
  return [x - r, y - r, x + r, y + r];
}
function viewerKey(v: ViewerSight): string {
  const s = v.v.senses;
  return `${v.v.x},${v.v.y},${v.v.elevation},${s.darkvision},${s.blindsight},${s.truesight},${s.tremorsense},${v.v.blinded ? 1 : 0}${v.v.unconscious ? 1 : 0}${v.v.flying ? 1 : 0},${v.v.sizeFt ?? ""}`;
}
function sameSights(a: readonly (VisPoly | null)[], b: readonly (VisPoly | null)[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** The creature an effect hangs on: an emanation's source, or the creature (or holder) it's attached to. */
export function anchorOf(e: EffectEntity): string | null {
  if (e.shape.kind === "emanation") return e.shape.sourceTokenId;
  return e.attachedTokenId;
}

/**
 * Points spread over a footprint, to meet a sight or a raster: a grid `step` ft apart (coarser for a huge area, at
 * most ~2000), its middle, and its edge (a wall: along its line) every `step` ft.
 */
function footprintSamples(f: Footprint, step0: number): P[] {
  const out: P[] = [];
  if (f.kind === "strip") {
    const pts = f.closed && f.points.length > 2 ? [...f.points, f.points[0] as P] : f.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as P;
      const b = pts[i] as P;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step0));
      for (let k = 0; k <= n; k++)
        out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
    return out;
  }
  const edge = f.kind === "circle" ? circleEdge(f.c, f.r * 0.98, step0) : polyEdge(f.points, step0);
  out.push(...edge);
  const xs = edge.map((q) => q.x);
  const ys = edge.map((q) => q.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  out.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  const step = Math.max(step0, Math.sqrt(((x1 - x0) * (y1 - y0)) / 2000));
  for (let x = x0 + step / 2; x < x1; x += step)
    for (let y = y0 + step / 2; y < y1; y += step) if (contains(f, { x, y })) out.push({ x, y });
  return out;
}
function circleEdge(c: P, r: number, step: number): P[] {
  const n = Math.max(12, Math.ceil((2 * Math.PI * r) / step));
  return Array.from({ length: n }, (_, i) => ({
    x: c.x + Math.cos((i / n) * 2 * Math.PI) * r,
    y: c.y + Math.sin((i / n) * 2 * Math.PI) * r,
  }));
}
function polyEdge(pts: readonly P[], step: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as P;
    const b = pts[(i + 1) % pts.length] as P;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function sameSensed(a: Map<string, SensedMark>, b: Map<string, SensedMark>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, m] of a) {
    const o = b.get(k);
    if (!o || o.x !== m.x || o.y !== m.y || o.id !== m.id) return false;
  }
  return true;
}
function sliceRect(data: Uint8Array, w: number, r: Rect): Uint8Array {
  const out = new Uint8Array(r.w * r.h);
  for (let j = 0; j < r.h; j++)
    out.set(data.subarray((r.y + j) * w + r.x, (r.y + j) * w + r.x + r.w), j * r.w);
  return out;
}
export function parseRuns(s: string): number[] {
  return s ? s.split(",").map(Number) : [];
}
export function formatRuns(runs: readonly number[]): string {
  return runs.join(",");
}
/** The part of a polyline between arc lengths s0 and s1. */
function subPath(path: P[], s0: number, s1: number): P[] {
  const a = pointAtLength(path, s0);
  const b = pointAtLength(path, s1);
  const out: P[] = [a.point];
  for (let i = a.index; i < b.index; i++) out.push(path[i] as P);
  out.push(b.point);
  return out.filter(
    (q, i) => i === 0 || Math.hypot(q.x - (out[i - 1] as P).x, q.y - (out[i - 1] as P).y) > 1e-6,
  );
}
