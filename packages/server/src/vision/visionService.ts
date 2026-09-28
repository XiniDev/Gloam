import {
  type P,
  pathLength,
  pointAtLength,
  type VisPoly,
  visContains,
  visRing,
} from "@gloam/shared/geometry";
import type { SceneEntity, TokenEntity } from "@gloam/shared/schemas";
import {
  creatureSamples,
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
import type { CampaignModel } from "../engine/model.ts";
import type { Op, Rect } from "../engine/ops.ts";
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
  /** World version and viewer key the explored raster was last marked with. */
  markedAt: string;
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
  private worldVersion = 0;
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

  /** The sensed markers a user holds (players: their own; spectators: the union). */
  sensedFor(userId: string | null): SensedMark[] {
    if (this.scene?.fogMode !== "dynamic") return [];
    return [...this.player(userId ?? SPECTATORS).sensed.values()];
  }

  /** The players whose vision is computed. */
  playerIds(): string[] {
    return [...this.players.keys()].filter((u) => u !== SPECTATORS);
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
    const active = this.model.activeScene;
    const scene = active && !active.deletedAt ? active : null;
    this.sceneId = scene?.id ?? "";
    this.scene = scene;
    this.geo = null;
    this.world = null;
    this.light = null;
    this.lightKeys.clear();
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
    const fx = sceneEffects(this.model, this.sceneId);
    if (geoChanged || !this.geo)
      this.geo = new VisionGeometry(sceneWalls(this.model, this.sceneId), fx.opaque);
    const lights = [...sceneLights(this.model, this.sceneId), ...fx.lights];
    const world = new VisionWorld(
      this.geo,
      lights,
      this.scene.ambient.level,
      this.scene.bounds,
      fx.obscurers,
    );
    // The light raster: all of it after a geometry change, else around the lights that changed.
    const keys = new Map(world.lights.map((l) => [l.id, lightKey(l)] as const));
    if (geoChanged || !this.light || !this.world) {
      this.light = new LightRaster(this.scene.bounds, this.scene.fogCellFt);
      this.light.build(world);
      this.worldVersion++;
    } else {
      const areas: number[][] = [];
      for (const [id, k] of keys) if (this.lightKeys.get(id) !== k) areas.push(areaOf(k));
      for (const [id, k] of this.lightKeys) if (keys.get(id) !== k) areas.push(areaOf(k));
      for (const [x0, y0, x1, y1] of areas)
        this.light.refresh(world, x0 as number, y0 as number, x1 as number, y1 as number);
      if (areas.length) this.worldVersion++;
    }
    this.lightKeys = keys;
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
      p = {
        viewers: [],
        key: "",
        perceived: new Set(),
        lights: new Set(),
        sensed: new Map(),
        explored: null,
        markedAt: "",
      };
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
      p = {
        viewers: [],
        key: "",
        perceived: new Set(),
        lights: new Set(),
        sensed: new Map(),
        explored: null,
        markedAt: "",
      };
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
    const lights = this.lightsReaching(userId, p);
    const changed =
      !sameSet(perceived, p.perceived) || !sameSensed(sensed, p.sensed) || !sameSet(lights, p.lights);
    p.perceived = perceived;
    p.sensed = sensed;
    p.lights = lights;
    return changed;
  }

  /** Carried lights whose lit area reaches what the player sees (dynamic) or what's revealed to them (painted). */
  private lightsReaching(userId: string, p: Player): Set<string> {
    const out = new Set<string>();
    const world = this.world;
    if (!world || !this.scene) return out;
    const revealed = this.scene.fogMode === "painted" ? this.revealedFor(userId) : null;
    for (const l of world.lights) {
      if (l.id.startsWith("fx:")) continue;
      const lit = world.litOf(l);
      const ring = visRing(lit);
      const pts: { x: number; y: number }[] = [{ x: l.x, y: l.y }];
      // The lit area's outline pulled 5 % toward the light (off the walls it ends on).
      for (let k = 0; k < ring.length; k += 2)
        pts.push({
          x: l.x + ((ring[k] as number) - l.x) * 0.95,
          y: l.y + ((ring[k + 1] as number) - l.y) * 0.95,
        });
      const hit = revealed
        ? pts.some((q) => revealed(q.x, q.y))
        : p.viewers.some(
            (v) => v.sight !== null && pts.some((q) => visContains(v.sight as VisPoly, q.x, q.y)),
          );
      if (hit) out.add(l.id);
    }
    return out;
  }

  /** Spectators: the union of the players' perceptions; sensed = sensed by someone and seen by nobody. */
  private updateSpectators(): boolean {
    const scene = this.scene;
    let p = this.players.get(SPECTATORS);
    if (!p) {
      p = {
        viewers: [],
        key: "",
        perceived: new Set(),
        lights: new Set(),
        sensed: new Map(),
        explored: null,
        markedAt: "",
      };
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
    const changed = !sameSensed(sensed, p.sensed);
    p.sensed = sensed;
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
    const at = `${this.worldVersion}#${p.key}`;
    if (p.markedAt === at) return;
    p.markedAt = at;
    const raster = this.exploredOf(userId, p);
    const before = raster.data.slice();
    const rect = markSeen(this.world, this.light, p.viewers, raster);
    if (!rect) return;
    const cells = raster.read(rect);
    const old = new Raster(0, 0, 1, rect.w, rect.h, sliceRect(before, raster.w, rect));
    // Only the newly seen cells travel: clients OR them in (spectators and DMs get everyone's).
    for (let k = 0; k < cells.length; k++) if (old.data[k]) cells[k] = 0;
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
    for (const [key, staged] of this.pendingWrites) {
      const [sceneId, layer] = key.split("|") as [string, string];
      if (sceneId !== this.sceneId) continue; // stored; inactive scenes aren't kept in memory
      this.layer(sceneId, layer).data.set(staged.data);
      if (layer.startsWith("explored:")) {
        const u = layer.slice("explored:".length);
        const p = this.players.get(u);
        if (p) p.markedAt = ""; // marked again from where they stand
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
          const r = this.layer(this.sceneId, `explored:${u}`);
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
    // DM-hidden tokens never reach players, moving or not (AC-TOK-08).
    if (!t || t.hidden) return null;
    if (!this.scene || this.scene.fogMode === "off" || t.sceneId !== this.sceneId) return full;
    if (
      t.ownerIds.includes(userId) ||
      t.revealTo === "all" ||
      (Array.isArray(t.revealTo) && t.revealTo.includes(userId))
    )
      return full;
    const L = pathLength(path);
    const n = Math.max(1, Math.ceil(L / MOVE_SAMPLE_FT));
    const creature = tokenCreature(this.model, t);
    const lit = this.ownLight(t);
    const p = this.player(userId);
    // The mover's own light travels with it: lights at its destination don't light the path behind.
    const world = this.world && t.lightId ? this.worldWithout(t.lightId) : this.world;
    const revealed = this.scene.fogMode === "painted" ? this.revealedFor(userId) : null;
    const sees = (s: number): boolean => {
      const at = pointAtLength(path, s).point;
      const c = { ...creature, x: at.x, y: at.y };
      if (revealed) return creatureSamples(c).some((q) => revealed(q.x, q.y));
      return world !== null && perceiveCreature(world, p.viewers, c, lit) === "seen";
    };
    let first = -1;
    let last = -1;
    for (let k = 0; k <= n; k++) {
      const s = Math.min(L, (k * L) / n);
      if (sees(s)) {
        if (first < 0) first = k;
        last = k;
      }
    }
    if (first < 0) return null;
    if (first === 0 && last === n) return full;
    const s0 = (first * L) / n;
    const s1 = (last * L) / n;
    return {
      id: tokenId,
      path: subPath(path, s0, s1),
      delayMs: L > 0 ? Math.round((durationMs * s0) / L) : 0,
      durationMs: L > 0 ? Math.max(1, Math.round((durationMs * (s1 - s0)) / L)) : durationMs,
      appear: first > 0,
      disappear: last < n,
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
  return `${l.x},${l.y},${l.bright},${l.dim},${l.coneDeg},${l.directionDeg},${l.magical},${l.pierceDarkness}`;
}
function areaOf(key: string): number[] {
  const [x, y, b, d] = key.split(",").map(Number) as [number, number, number, number];
  const r = b + d + 1;
  return [x - r, y - r, x + r, y + r];
}
function viewerKey(v: ViewerSight): string {
  const s = v.v.senses;
  return `${v.v.x},${v.v.y},${v.v.elevation},${s.darkvision},${s.blindsight},${s.truesight},${s.tremorsense},${v.v.blinded ? 1 : 0}${v.v.unconscious ? 1 : 0}`;
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
