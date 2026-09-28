/**
 * The vision world (SPEC §15.1): the blocking sets for each purpose, the lights, the obscuring volumes and the
 * scene's ambient light. Used by the server (authoritative perception) and by clients (rendering), from the data each
 * legitimately has.
 */
import {
  inCone,
  inPolygon,
  type P,
  polygonCrossings,
  type Seg,
  SegmentSet,
  type VisPoly,
  visContains,
  visibilityPolygon,
  visNear,
  type Wedge,
} from "../geometry/index.ts";
import { blocksLight, blocksMove, blocksSight, type DoorState } from "../movement/blocking.ts";
import type { AmbientLevel, Bounds } from "../schemas/entities.ts";

/** Light levels, ordered (max is brighter). */
export const DARK = 0;
export const DIM = 1;
export const BRIGHT = 2;
export type LightLevel = 0 | 1 | 2;

export const ambientLevel = (a: AmbientLevel): LightLevel =>
  a === "bright" ? BRIGHT : a === "dim" ? DIM : DARK;

export interface VisionWall {
  a: P;
  b: P;
  kind: string;
  door?: DoorState;
}

/** A token's facing (degrees, as `rotationDeg`) as an angle on the table: models face +z (south) at 0. */
export const facingAngle = (deg: number): number => ((deg + 90) * Math.PI) / 180;

/** A cone light's cone (null when it shines all round). */
export function coneOf(l: { coneDeg: number | null; directionDeg: number }): Wedge | null {
  return l.coneDeg !== null && l.coneDeg < 360
    ? { dir: facingAngle(l.directionDeg), half: (l.coneDeg * Math.PI) / 360 }
    : null;
}

const LOS_CACHE_MAX = 4096;
/** How many of the most recently used polygons a wall change tries to keep, and the most changed segments to try. */
const KEEP_RECENT = 256;
const KEEP_MAX_CHANGED = 32;
/** A changed segment this far (ft) from a region — well over the weld tolerance — can't have changed it. */
const KEEP_MARGIN = 1e-3;

/**
 * The blocking segments per purpose (§15.2's table) with caches of the polygons computed from them. Build a new one
 * when walls or doors change; lights and tokens moving reuse it.
 */
export class VisionGeometry {
  /** `LOS_sight`: sight-blocking walls and opaque effect walls. */
  readonly sight: SegmentSet;
  /** `LOS_blind` and `REACH`: physical barriers (movement-blocking walls). */
  readonly blind: SegmentSet;
  /** `LIT`: light-blocking walls and opaque effect walls. */
  readonly light: SegmentSet;
  private readonly cache = new Map<string, VisPoly>();
  /** Each input segment with what it blocks, as a key (to tell what a change touched). */
  private readonly inputs: Map<string, Seg>;

  constructor(walls: readonly VisionWall[], opaque: readonly Seg[] = []) {
    const sight: Seg[] = [...opaque];
    const blind: Seg[] = [];
    const light: Seg[] = [...opaque];
    this.inputs = new Map();
    let dup = 0;
    const input = (s: Seg, what: string) => {
      const k = `${s.a.x},${s.a.y},${s.b.x},${s.b.y}|${what}`;
      this.inputs.set(this.inputs.has(k) ? `${k}#${++dup}` : k, s);
    };
    for (const s of opaque) input(s, "sl");
    for (const w of walls) {
      const bs = blocksSight(w.kind, w.door);
      const bm = blocksMove(w.kind, w.door);
      const bl = blocksLight(w.kind, w.door);
      if (bs) sight.push(w);
      if (bm) blind.push(w);
      if (bl) light.push(w);
      if (bs || bm || bl) input(w, `${bs ? "s" : ""}${bm ? "b" : ""}${bl ? "l" : ""}`);
    }
    this.sight = new SegmentSet(sight);
    this.blind = new SegmentSet(blind);
    this.light = sameSegs(light, sight) ? this.sight : new SegmentSet(light);
  }

  /**
   * The geometry after walls, doors or opaque effects changed, keeping the recently used polygons the change can't
   * have touched. Exact: a segment nowhere near a region leaves it as it was, added or taken away — every point seen
   * is seen along a line inside the region, which the segment doesn't meet; and a point hidden only by the segment
   * would have its line enter the segment's shadow where the segment touches the region.
   */
  static after(
    prev: VisionGeometry | null,
    walls: readonly VisionWall[],
    opaque: readonly Seg[] = [],
  ): VisionGeometry {
    const next = new VisionGeometry(walls, opaque);
    if (!prev) return next;
    const changed: Seg[] = [];
    for (const [k, s] of prev.inputs) if (!next.inputs.has(k)) changed.push(s);
    for (const [k, s] of next.inputs) if (!prev.inputs.has(k)) changed.push(s);
    if (changed.length > KEEP_MAX_CHANGED) return next;
    const recent = [...prev.cache].slice(-KEEP_RECENT);
    for (const [k, v] of recent)
      if (!changed.some((s) => visNear(v, s.a.x, s.a.y, s.b.x, s.b.y, KEEP_MARGIN))) next.cache.set(k, v);
    return next;
  }

  private get(kind: "s" | "b" | "l", set: SegmentSet, x: number, y: number, r: number): VisPoly {
    const key = `${kind}${x},${y},${r}`;
    let v = this.cache.get(key);
    if (v) {
      // Most recently used last (what a wall change keeps).
      this.cache.delete(key);
      this.cache.set(key, v);
      return v;
    }
    if (this.cache.size >= LOS_CACHE_MAX) this.cache.clear();
    v = visibilityPolygon({ x, y }, set, r);
    this.cache.set(key, v);
    return v;
  }
  losSight(x: number, y: number, r: number): VisPoly {
    return this.get("s", this.sight, x, y, r);
  }
  losBlind(x: number, y: number, r: number): VisPoly {
    return this.get("b", this.blind, x, y, r);
  }
  lit(x: number, y: number, r: number): VisPoly {
    return this.get(this.light === this.sight ? "s" : "l", this.light, x, y, r);
  }
}

function sameSegs(a: Seg[], b: Seg[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

export interface VisionLight {
  id: string;
  x: number;
  y: number;
  bright: number;
  /** Dim light beyond the bright radius (ft). */
  dim: number;
  /** A cone light's full angle; null (or 360) for all around. */
  coneDeg: number | null;
  /** Facing, as `rotationDeg` (see facingAngle). */
  directionDeg: number;
  magical: boolean;
  pierceDarkness: boolean;
  enabled?: boolean;
  dmOnly?: boolean;
}

/** An obscuring volume (§15.1): a footprint with a vertical extent. */
export interface Obscurer {
  kind: "heavy" | "light" | "magicalDarkness";
  poly: P[];
  zMin: number;
  zMax: number;
}

const LIGHT_CELL = 10;

/** Everything perception needs for one scene at one moment. Cheap to build: the geometry carries the caches. */
export class VisionWorld {
  readonly lights: readonly VisionLight[];
  readonly ambient: LightLevel;
  /** Normal sight's reach: the scene's diagonal (§8.8). */
  readonly sightRadius: number;
  private grid: Map<number, number[]> | null = null;

  readonly geo: VisionGeometry;
  readonly bounds: Bounds;
  readonly obscurers: readonly Obscurer[];

  constructor(
    geo: VisionGeometry,
    lights: readonly VisionLight[],
    ambient: AmbientLevel | LightLevel,
    bounds: Bounds,
    obscurers: readonly Obscurer[] = [],
  ) {
    this.geo = geo;
    this.bounds = bounds;
    this.obscurers = obscurers;
    this.lights = lights.filter((l) => l.enabled !== false && l.dmOnly !== true && l.bright + l.dim > 0);
    this.ambient = typeof ambient === "number" ? ambient : ambientLevel(ambient);
    this.sightRadius = Math.max(1, Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
  }

  /** The area a light reaches (`LIT`), all around; cones are applied by `lights at`. */
  litOf(l: VisionLight): VisPoly {
    return this.geo.lit(l.x, l.y, l.bright + l.dim);
  }

  /** Whether point p is inside some magical darkness volume. */
  inMagicalDarkness(x: number, y: number, z = 0): boolean {
    for (const o of this.obscurers)
      if (o.kind === "magicalDarkness" && z >= o.zMin && z <= o.zMax && inPolygon({ x, y }, o.poly))
        return true;
    return false;
  }

  private readonly levels = new Map<string, LightLevel>();

  /**
   * `lightLevel(p)`, remembered for this world (it never changes): perception asks for the same creature's sample
   * points once per player.
   */
  lightLevelCached(x: number, y: number, z = 0): LightLevel {
    const k = `${x},${y},${z}`;
    let v = this.levels.get(k);
    if (v === undefined) {
      if (this.levels.size > 50_000) this.levels.clear();
      v = this.lightLevel(x, y, z);
      this.levels.set(k, v);
    }
    return v;
  }

  /** The level a light gives at a point it reaches (by distance and cone; LIT is the caller's). */
  levelFrom(l: VisionLight, x: number, y: number): LightLevel {
    const dx = x - l.x;
    const dy = y - l.y;
    const r = Math.hypot(dx, dy);
    const lv: LightLevel =
      l.bright > 0 && r <= l.bright ? BRIGHT : l.dim > 0 && r <= l.bright + l.dim ? DIM : DARK;
    if (lv === DARK) return DARK;
    if (
      l.coneDeg !== null &&
      l.coneDeg < 360 &&
      r > 0 &&
      !inCone(dx, dy, facingAngle(l.directionDeg), (l.coneDeg * Math.PI) / 360)
    )
      return DARK;
    return lv;
  }

  /** The lights by 10-ft cell (made on first use: a world made only to fill the light raster never needs it). */
  private lightGrid(): Map<number, number[]> {
    if (this.grid) return this.grid;
    const grid = new Map<number, number[]>();
    this.lights.forEach((l, i) => {
      const r = l.bright + l.dim;
      for (let x = Math.floor((l.x - r) / LIGHT_CELL); x <= Math.floor((l.x + r) / LIGHT_CELL); x++)
        for (let y = Math.floor((l.y - r) / LIGHT_CELL); y <= Math.floor((l.y + r) / LIGHT_CELL); y++) {
          const k = key(x, y);
          const list = grid.get(k);
          if (list) list.push(i);
          else grid.set(k, [i]);
        }
    });
    this.grid = grid;
    return grid;
  }

  /** `lightLevel(p)` (§15.3). */
  lightLevel(x: number, y: number, z = 0): LightLevel {
    const darkness = this.obscurers.length > 0 && this.inMagicalDarkness(x, y, z);
    let level: LightLevel = darkness ? DARK : this.ambient;
    if (level === BRIGHT) return level;
    const list = this.lightGrid().get(key(Math.floor(x / LIGHT_CELL), Math.floor(y / LIGHT_CELL)));
    if (!list) return level;
    for (const i of list) {
      const l = this.lights[i] as VisionLight;
      if (darkness && !(l.magical && l.pierceDarkness)) continue;
      const dx = x - l.x;
      const dy = y - l.y;
      const r = Math.hypot(dx, dy);
      // A radius of 0 lights nothing (a lowered hood: bright 0), not even the light's own spot.
      const lv: LightLevel =
        l.bright > 0 && r <= l.bright ? BRIGHT : l.dim > 0 && r <= l.bright + l.dim ? DIM : DARK;
      if (lv <= level) continue;
      if (
        l.coneDeg !== null &&
        l.coneDeg < 360 &&
        r > 0 &&
        !inCone(dx, dy, facingAngle(l.directionDeg), (l.coneDeg * Math.PI) / 360)
      )
        continue;
      if (!visContains(this.litOf(l), x, y)) continue;
      level = lv;
      if (level === BRIGHT) break;
    }
    return level;
  }

  /** The obscuring volumes met by the sight line v→p (crossing it, or holding either end), vertically overlapping. */
  obscurersOn(v: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }): Obscurer[] {
    const out: Obscurer[] = [];
    for (const o of this.obscurers) {
      if (Math.max(v.z, p.z) < o.zMin || Math.min(v.z, p.z) > o.zMax) continue;
      if (inPolygon(v, o.poly) || inPolygon(p, o.poly) || polygonCrossings(v, p, o.poly).length > 0)
        out.push(o);
    }
    return out;
  }
}

const key = (x: number, y: number) => (x + 1e6) * 4e6 + (y + 1e6);
