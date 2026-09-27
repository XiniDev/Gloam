import type { ArraySchema } from "@colyseus/schema";
import { effectiveTokenState, HP_BAND_HIDDEN, hpBand } from "@gloam/shared/rules";
import type {
  EffectEntity,
  LightEntity,
  SceneEntity,
  TokenEntity,
  WallEntity,
  ZoneEntity,
} from "@gloam/shared/schemas";
import {
  COLLECTIONS,
  type CollectionName,
  EffectS,
  type EffectView,
  LightS,
  type LightView,
  type PrepPatch,
  type PrepSnapshot,
  type SceneView,
  type TableState,
  Token,
  type TokenOwnerView,
  type TokenView,
  V2,
  Wall,
  type WallView,
  ZoneS,
  type ZoneView,
} from "@gloam/shared/state";
import type { CampaignModel } from "../engine/model.ts";
import type { EntityKind, Op } from "../engine/ops.ts";

/**
 * The state projector (SPEC §13.3): turns model entities into the plain view shapes and keeps the Colyseus state's
 * scene collections equal to the ACTIVE scene. The same view functions build DM prep snapshots and patches (§13.7),
 * so the client renders one shape whatever the source. Field assignment is diffed, so an unchanged field never
 * produces a patch.
 */

export interface ProjectionCtx {
  model: CampaignModel;
  /** A user's player colour (party token rings). */
  colorOf(userId: string): string | undefined;
  /** Movement/turn numbers for a token's controller view (movement and combat fill these from Phase 3). */
  movementOf?(tokenId: string): Partial<TokenOwnerView> | undefined;
  /** The current combat round on the token's scene (effect durations). */
  roundOf?(sceneId: string): number;
}

// ── views ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The full token view (every tag). The per-client StateView decides which tags each viewer receives. */
export function tokenView(t: TokenEntity, ctx: ProjectionCtx): TokenView {
  const actor = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
  const { stats, status } = effectiveTokenState(t, actor);
  const conditions = status.conditions.map((c) => c.id as string);
  const shown = t.hpDisplay === "exact" || t.hpDisplay === "bar";
  const max = Math.max(1, stats.hpMax);
  const light = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
  const owner = t.ownerIds[0];
  const pinned: string[] = [];
  const custom = actor && Array.isArray(actor.sheet.custom) ? (actor.sheet.custom as unknown[]) : [];
  for (const b of custom) {
    const c = b as { type?: string; title?: string; value?: number; max?: number; pinToToken?: boolean };
    if (c.type === "counter" && c.pinToToken) pinned.push(`${c.title ?? ""}|${c.value ?? 0}|${c.max ?? 0}`);
  }
  const mv = ctx.movementOf?.(t.id) ?? {};
  const speeds = stats.speeds;
  return {
    id: t.id,
    actorId: t.actorId ?? "",
    kind: actor ? actor.kind : "unit",
    name: t.name,
    pos: { x: t.pos.x, y: t.pos.y },
    elevation: t.elevation,
    rotation: t.rotationDeg,
    size: stats.size,
    sizeFt: t.sizeFt,
    mode: t.appearance.mode,
    assetId: t.appearance.assetId ?? "",
    portraitAssetId: t.appearance.portraitAssetId ?? "",
    scale: t.appearance.scale,
    offsetY: t.appearance.offsetY,
    rotOffset: t.appearance.rotationOffsetDeg,
    tint: t.appearance.tint ?? "",
    ringColor: t.disposition === "party" && owner ? (ctx.colorOf(owner) ?? "") : "",
    disposition: t.disposition,
    ownerIds: [...t.ownerIds],
    hpDisplay: t.hpDisplay,
    hpBand: t.hpDisplay === "hidden" ? HP_BAND_HIDDEN : hpBand(stats.hp, max),
    hpFrac: shown ? Math.min(1, Math.max(0, stats.hp / max)) : -1,
    tempFrac: shown ? Math.min(1, Math.max(0, stats.hpTemp / max)) : -1,
    conditions,
    markers: status.markers.map((m) => m.id as string),
    exhaustion: status.exhaustion,
    concentrating: Boolean(status.concentration),
    prone: conditions.includes("prone"),
    dead: status.deathSaves?.dead === true || (!stats.isPC && stats.hp <= 0),
    invisibleFx: conditions.includes("invisible"),
    outlined: status.outlined,
    lightOn: light ? light.enabled : false,
    reachFt: stats.reachFt,
    locked: t.locked,
    moveSeq: mv.segments ?? 0,
    pinnedBars: pinned,
    hp: { hp: stats.hp, hpMax: stats.hpMax, hpTemp: stats.hpTemp },
    own: {
      ac: stats.ac,
      budgetFt: t.overrides.speedOverride ?? speeds.walk,
      usedFt: 0,
      turnStart: { x: t.pos.x, y: t.pos.y },
      mode: t.moveMode,
      pips: 0,
      dashes: 0,
      bonusMoveFt: t.overrides.bonusMove?.ft ?? 0,
      speedWalk: speeds.walk,
      speedFly: speeds.fly,
      speedSwim: speeds.swim,
      speedClimb: speeds.climb,
      speedBurrow: speeds.burrow,
      hover: speeds.hover,
      segments: 0,
      freeMovement: t.overrides.freeMovement === true,
      lockMovement: t.overrides.lockMovement === true,
      ...mv,
    },
    vis: {
      ...stats.senses,
      blinded: conditions.includes("blinded"),
      unconscious: conditions.includes("unconscious"),
      seeInvisible: status.seeInvisible,
    },
    dm: {
      secretNote: t.dmNote,
      dmHidden: t.hidden,
      link: t.link,
      overridesJson: JSON.stringify(t.overrides),
      revealJson: JSON.stringify(t.revealTo),
    },
  };
}

/** Whether a wall blocks sight right now (open doors and windows don't; §8.7). */
export function wallBlocksSight(w: WallEntity): boolean {
  switch (w.kind) {
    case "window":
    case "invisible":
      return false;
    case "door":
    case "secret":
      return w.doorState !== "open";
    default:
      return true;
  }
}

/**
 * Wall view. The public `kind`/`door` fields are player-safe (§13.4): a shut secret door reads as a plain wall, a
 * hidden sight-blocking wall as an anonymous "occluder"; the truth is in the DM-tagged fields. A secret door the DM
 * has opened is revealed — an open door to everyone — because the gap is really there: players walk and (P4) see
 * through it, so their state must say so. Shut again, it reads as a wall again.
 */
export function wallView(w: WallEntity): WallView {
  const shown = w.kind === "secret" && w.doorState === "open";
  return {
    id: w.id,
    ax: w.a.x,
    ay: w.a.y,
    bx: w.b.x,
    by: w.b.y,
    kind: w.hidden ? "occluder" : w.kind === "secret" ? (shown ? "door" : "wall") : w.kind,
    door: w.hidden || (w.kind === "secret" && !shown) ? "" : (w.doorState ?? ""),
    dmKind: w.kind,
    dmHidden: w.hidden,
    dmDoor: w.doorState ?? "",
  };
}

export function lightView(l: LightEntity, ctx: ProjectionCtx): LightView {
  const carrier = l.tokenId ? ctx.model.get("token", l.tokenId) : undefined;
  const pos = carrier ? carrier.pos : l.pos;
  const v: LightView = {
    id: l.id,
    x: pos.x,
    y: pos.y,
    elevation: carrier ? carrier.elevation + 3 : l.elevation,
    bright: l.shuttered ? 0 : l.bright,
    dim: l.shuttered ? 5 : l.dim,
    color: l.color,
    intensity: l.intensity,
    anim: l.animation,
    coneDeg: l.coneDeg ?? 360,
    dirDeg: carrier ? carrier.rotationDeg : l.directionDeg,
    magical: l.magical,
    pierceDarkness: l.pierceDarkness,
    on: l.enabled,
    preset: l.preset ?? "",
  };
  if (l.tokenId) v.link = { tokenId: l.tokenId, casterId: "" };
  return v;
}

/** A zone's outline as points (circles as 48-gons) plus its exact shape as JSON. */
export function zoneView(z: ZoneEntity): ZoneView {
  const sh = z.shape;
  let points: { x: number; y: number }[];
  if (sh.kind === "polygon") points = sh.points.map((p) => ({ x: p.x, y: p.y }));
  else if (sh.kind === "rect")
    points = [
      { x: sh.x, y: sh.y },
      { x: sh.x + sh.w, y: sh.y },
      { x: sh.x + sh.w, y: sh.y + sh.h },
      { x: sh.x, y: sh.y + sh.h },
    ];
  else
    points = Array.from({ length: 48 }, (_, i) => ({
      x: sh.x + Math.cos((i / 48) * Math.PI * 2) * sh.r,
      y: sh.y + Math.sin((i / 48) * Math.PI * 2) * sh.r,
    }));
  return {
    id: z.id,
    kind: z.kind,
    points,
    label: z.label,
    color: z.color,
    shapeJson: JSON.stringify(sh),
    dmHidden: !z.visible,
    dmJson: JSON.stringify({ note: z.note, triggers: z.triggers }),
  };
}

export function effectView(e: EffectEntity, ctx: ProjectionCtx): EffectView {
  const round = ctx.roundOf?.(e.sceneId) ?? 0;
  const v: EffectView = {
    id: e.id,
    shapeJson: JSON.stringify(e.shape),
    propsJson: JSON.stringify(e.props),
    vfx: e.vfx,
    roundsLeft: "never" in e.expires ? -1 : Math.max(0, e.expires.round - round),
    name: e.name,
  };
  const tokenId = e.attachedTokenId ?? "";
  const casterId = e.source.casterTokenId ?? "";
  if (tokenId || casterId) v.link = { tokenId, casterId };
  return v;
}

export function sceneView(s: SceneEntity, seq: number): SceneView {
  return {
    id: s.id,
    name: s.name,
    mapKind: s.mapKind,
    mapAssetId: s.mapAssetId ?? "",
    calibJson: JSON.stringify(s.calibration),
    floorJson: JSON.stringify(s.floor),
    ambient: s.ambient.level,
    ambientTint: s.ambient.tint,
    fogMode: s.fogMode,
    fogCellFt: s.fogCellFt,
    boundsJson: JSON.stringify(s.bounds),
    walls3d: s.walls3d,
    seq,
  };
}

const EMPTY_SCENE: SceneView = {
  id: "",
  name: "",
  mapKind: "",
  mapAssetId: "",
  calibJson: "{}",
  floorJson: "{}",
  ambient: "bright",
  ambientTint: "",
  fogMode: "off",
  fogCellFt: 1,
  boundsJson: "{}",
  walls3d: false,
  seq: 0,
};

function sceneMeta(s: SceneEntity): PrepSnapshot["sceneMeta"] {
  return {
    spawn: { x: s.spawn.x, y: s.spawn.y },
    dmNotes: s.dmNotes,
    sort: s.sort,
    archived: s.archivedAt !== null,
  };
}

/** Every view in a scene (a prep snapshot, or the active scene's desired state). */
export function sceneCollections(sceneId: string, ctx: ProjectionCtx) {
  const m = ctx.model;
  return {
    tokens: m.inScene("token", sceneId).map((t) => tokenView(t, ctx)),
    walls: m.inScene("wall", sceneId).map(wallView),
    lights: m.inScene("light", sceneId).map((l) => lightView(l, ctx)),
    zones: m.inScene("zone", sceneId).map(zoneView),
    effects: m.inScene("effect", sceneId).map((e) => effectView(e, ctx)),
  };
}

export function prepSnapshot(scene: SceneEntity, ctx: ProjectionCtx): PrepSnapshot {
  return { scene: sceneView(scene, 0), sceneMeta: sceneMeta(scene), ...sceneCollections(scene.id, ctx) };
}

// ── schema assignment (diffed) ────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

/** Copies a view into a schema instance, touching only fields whose value changed. */
export function assign(target: Obj, view: object): void {
  for (const [k, v] of Object.entries(view)) {
    if (v === undefined) continue;
    const cur = target[k];
    if (Array.isArray(v)) {
      const arr = cur as ArraySchema<unknown>;
      if (v.length > 0 && typeof v[0] === "object") {
        // Arrays of points: rebuild when any coordinate differs.
        const same =
          arr.length === v.length &&
          v.every((p, i) => {
            const q = arr[i] as Obj | undefined;
            return q && (p as Obj).x === q.x && (p as Obj).y === q.y;
          });
        if (!same) {
          arr.clear();
          for (const p of v) {
            const pt = new V2();
            pt.x = (p as Obj).x as number;
            pt.y = (p as Obj).y as number;
            arr.push(pt);
          }
        }
      } else if (arr.length !== v.length || v.some((x, i) => arr[i] !== x)) {
        arr.clear();
        arr.push(...v);
      }
    } else if (v !== null && typeof v === "object") {
      assign(cur as Obj, v as Obj);
    } else if (cur !== v) {
      target[k] = v;
    }
  }
}

// ── the active-scene projector ────────────────────────────────────────────────────────────────────────────

const KIND_TO_COLLECTION: Partial<Record<EntityKind, CollectionName>> = {
  token: "tokens",
  wall: "walls",
  light: "lights",
  zone: "zones",
  effect: "effects",
};

const COLLECTION_KIND: Record<CollectionName, "token" | "wall" | "light" | "zone" | "effect"> = {
  tokens: "token",
  walls: "wall",
  lights: "light",
  zones: "zone",
  effects: "effect",
};

const SCHEMA_FOR: Record<CollectionName, new () => Obj> = {
  tokens: Token as unknown as new () => Obj,
  walls: Wall as unknown as new () => Obj,
  lights: LightS as unknown as new () => Obj,
  zones: ZoneS as unknown as new () => Obj,
  effects: EffectS as unknown as new () => Obj,
};

/** Appends to a per-collection list in a prep patch, creating the list on first use. */
function addTo(lists: Partial<Record<CollectionName, unknown[]>>, c: CollectionName, item: unknown): void {
  const list = lists[c] ?? [];
  list.push(item);
  lists[c] = list;
}

/** The scene an entity was in before `op` (deletes and whole-entity or `sceneId` sets carry it in `prev`). */
function sceneBefore(op: Op): string | undefined {
  if (op.k === "delete") return (op.prev as { sceneId?: string }).sceneId;
  if (op.k === "set") {
    if (op.path.length === 0) return (op.prev as { sceneId?: string } | null)?.sceneId;
    if (op.path.length === 1 && op.path[0] === "sceneId") return op.prev as string;
  }
  return undefined;
}

export interface ProjectionResult {
  /** The active scene changed identity (activation): every client needs its view rebuilt and a transition. */
  switched: boolean;
  /** Something in the active scene changed (views may need recomputing). */
  activeChanged: boolean;
  /** Changes to non-active scenes, for DMs viewing them in prep (§13.7). */
  prep: Map<string, PrepPatch>;
}

export class StateProjector {
  private readonly state: TableState;
  private readonly ctx: ProjectionCtx;
  private activeId = "";
  private seq = 0;

  constructor(state: TableState, ctx: ProjectionCtx) {
    this.state = state;
    this.ctx = ctx;
  }

  get activeSceneId(): string {
    return this.activeId;
  }

  /** Clears the scene collections and fills them from the active scene (join, activation, reload). */
  loadActive(): void {
    const scene = this.ctx.model.activeScene;
    const usable = scene && !scene.deletedAt ? scene : undefined;
    if ((usable?.id ?? "") !== this.activeId) this.seq++;
    this.activeId = usable?.id ?? "";
    assign(
      this.state.scene as unknown as Obj,
      usable ? sceneView(usable, this.seq) : { ...EMPTY_SCENE, seq: this.seq },
    );
    const st = this.state as unknown as Record<CollectionName, Map<string, Obj> & { clear(): void }>;
    for (const c of COLLECTIONS) st[c].clear();
    if (!usable) return;
    const all = sceneCollections(usable.id, this.ctx);
    for (const c of COLLECTIONS) for (const v of all[c]) this.upsert(c, v as unknown as Obj);
  }

  private upsert(c: CollectionName, view: Obj): void {
    const map = (this.state as unknown as Record<CollectionName, Map<string, Obj>>)[c];
    const id = view.id as string;
    let item = map.get(id);
    if (!item) {
      item = new SCHEMA_FOR[c]();
      assign(item, view);
      map.set(id, item);
    } else assign(item, view);
  }

  private viewOf(c: CollectionName, id: string): Obj | null {
    const m = this.ctx.model;
    switch (c) {
      case "tokens": {
        const t = m.get("token", id);
        return t ? (tokenView(t, this.ctx) as unknown as Obj) : null;
      }
      case "walls": {
        const w = m.get("wall", id);
        return w ? (wallView(w) as unknown as Obj) : null;
      }
      case "lights": {
        const l = m.get("light", id);
        return l ? (lightView(l, this.ctx) as unknown as Obj) : null;
      }
      case "zones": {
        const z = m.get("zone", id);
        return z ? (zoneView(z) as unknown as Obj) : null;
      }
      case "effects": {
        const e = m.get("effect", id);
        return e ? (effectView(e, this.ctx) as unknown as Obj) : null;
      }
    }
  }

  /**
   * Applies a commit's ops. Entities are re-projected from the (already updated) model, including dependents:
   * tokens of a changed actor, the carrier of a changed light, lights carried by a moved token.
   */
  apply(ops: Op[]): ProjectionResult {
    const m = this.ctx.model;
    const result: ProjectionResult = { switched: false, activeChanged: false, prep: new Map() };
    if (m.campaign.activeSceneId !== (this.activeId || null) || (this.activeId && m.activeScene?.deletedAt)) {
      this.loadActive();
      result.switched = true;
      result.activeChanged = true;
    }
    // (collection, id, sceneId-before, sceneId-after) for every touched scene-scoped entity.
    const touched = new Map<string, { c: CollectionName; id: string; scenes: Set<string> }>();
    const touch = (c: CollectionName, id: string, ...scenes: (string | undefined)[]) => {
      const key = `${c}:${id}`;
      const t = touched.get(key) ?? { c, id, scenes: new Set<string>() };
      for (const s of scenes) if (s) t.scenes.add(s);
      touched.set(key, t);
    };
    const sceneChanged = new Set<string>();
    for (const op of ops) {
      if (op.k === "fog") continue;
      if (op.k === "sheet") {
        for (const t of m.all("token")) if (t.actorId === op.actorId) touch("tokens", t.id, t.sceneId);
        continue;
      }
      if (op.e === "scene") {
        sceneChanged.add(op.id);
        continue;
      }
      if (op.e === "actor") {
        for (const t of m.all("token")) if (t.actorId === op.id) touch("tokens", t.id, t.sceneId);
        continue;
      }
      const c = KIND_TO_COLLECTION[op.e];
      if (!c) continue;
      const now = m.get(op.e, op.id) as { sceneId?: string } | undefined;
      touch(c, op.id, sceneBefore(op), now?.sceneId);
      if (op.e === "light") {
        const l = m.get("light", op.id) ?? (op.k === "delete" ? (op.prev as LightEntity) : undefined);
        if (l?.tokenId) touch("tokens", l.tokenId, l.sceneId);
      }
      if (op.e === "token") {
        const t = m.get("token", op.id);
        if (t?.lightId) touch("lights", t.lightId, t.sceneId);
      }
    }
    for (const { c, id, scenes } of touched.values()) {
      const view = this.viewOf(c, id);
      for (const sceneId of scenes) {
        if (sceneId === this.activeId) {
          if (result.switched) continue; // already rebuilt
          result.activeChanged = true;
          const map = (this.state as unknown as Record<CollectionName, Map<string, Obj>>)[c];
          const stillHere = this.sceneOf(c, id) === sceneId;
          if (stillHere && view) this.upsert(c, view);
          else map.delete(id);
        } else {
          const patch = this.prepPatch(result.prep, sceneId);
          if (view && this.sceneOf(c, id) === sceneId)
            addTo(patch.upsert as Partial<Record<CollectionName, unknown[]>>, c, view);
          else addTo(patch.remove, c, id);
        }
      }
    }
    for (const sceneId of sceneChanged) {
      const s = m.get("scene", sceneId);
      if (sceneId === this.activeId && !result.switched) {
        if (s) assign(this.state.scene as unknown as Obj, sceneView(s, this.seq));
        result.activeChanged = true;
      } else if (sceneId !== this.activeId) {
        const patch = this.prepPatch(result.prep, sceneId);
        patch.scene = s && !s.deletedAt ? sceneView(s, 0) : null;
        if (s) patch.sceneMeta = sceneMeta(s);
      }
    }
    return result;
  }

  private sceneOf(c: CollectionName, id: string): string | undefined {
    return (this.ctx.model.get(COLLECTION_KIND[c], id) as { sceneId?: string } | undefined)?.sceneId;
  }

  private prepPatch(map: Map<string, PrepPatch>, sceneId: string): PrepPatch {
    let p = map.get(sceneId);
    if (!p) {
      p = { sceneId, upsert: {}, remove: {} };
      map.set(sceneId, p);
    }
    return p;
  }

  /** Re-projects every token (a user's colour changed, a house rule changed…). */
  refreshTokens(): void {
    if (!this.activeId) return;
    for (const t of this.ctx.model.inScene("token", this.activeId))
      this.upsert("tokens", tokenView(t, this.ctx) as unknown as Obj);
  }
}
