/**
 * Areas of effect and targeting (SPEC §17): the 2024 shapes (SRD 5.2.1) as footprints on the map plane, who an area
 * affects (§17.3: the base circle against the footprint, the vertical extent, line of effect from the origin), range
 * and line of effect for placing one (§17.3), the areas' growth with the slot (§33), and the cover hint (§17.5).
 * Feet throughout; the map plane is (x, y), elevation is z.
 */
import { cross, dist, type P, pointSegDist, segIntersect, sub } from "../geometry/index.ts";

export type AreaShape =
  | { kind: "sphere"; origin: P; z?: number; radius: number }
  | { kind: "cylinder"; origin: P; z?: number; radius: number; height: number }
  | { kind: "cone"; origin: P; z?: number; dirDeg: number; length: number }
  | { kind: "cube"; origin: P; z?: number; dirDeg: number; size: number; originOnFace: boolean }
  | { kind: "line"; origin: P; z?: number; dirDeg: number; length: number; width: number }
  | {
      kind: "emanation";
      source: P;
      sourceRadius: number;
      /** The source's base elevation and height: the area reaches `distance` past its space every way. */
      z?: number;
      sourceHeight?: number;
      distance: number;
    }
  | { kind: "wall"; points: P[]; closed: boolean; z?: number; height: number; thickness: number };

/** A footprint on the map plane: a disc, a polygon, or a thick polyline (a wall). */
export type Footprint =
  | { kind: "circle"; c: P; r: number }
  | { kind: "poly"; points: P[] }
  | { kind: "strip"; points: P[]; closed: boolean; halfWidth: number };

/** A cone's half-angle: its width at distance x equals x (SRD 5.2.1), atan(½) ≈ 26.565°. */
export const CONE_HALF_ANGLE = Math.atan(0.5);

/** A direction as a facing (`rotationDeg`, the vision engine's facingAngle): 0° looks south (+y), 90° west. */
export const dirOf = (deg: number): P => ({
  x: Math.cos(((deg + 90) * Math.PI) / 180),
  y: Math.sin(((deg + 90) * Math.PI) / 180),
});
/** The facing (as `dirDeg`) that looks from `a` towards `b`. */
export const facingTo = (a: P, b: P): number => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI - 90;
const along = (o: P, d: P, k: number): P => ({ x: o.x + d.x * k, y: o.y + d.y * k });
const perpOf = (d: P): P => ({ x: -d.y, y: d.x });

/** An area's footprint (§17.1). */
export function footprint(a: AreaShape): Footprint {
  switch (a.kind) {
    case "sphere":
    case "cylinder":
      return { kind: "circle", c: a.origin, r: a.radius };
    case "emanation":
      return { kind: "circle", c: a.source, r: a.distance + a.sourceRadius };
    case "cone": {
      const d = dirOf(a.dirDeg);
      const n = perpOf(d);
      const far = along(a.origin, d, a.length);
      return { kind: "poly", points: [a.origin, along(far, n, a.length / 2), along(far, n, -a.length / 2)] };
    }
    case "line": {
      const d = dirOf(a.dirDeg);
      const n = perpOf(d);
      const far = along(a.origin, d, a.length);
      const w = a.width / 2;
      return {
        kind: "poly",
        points: [along(a.origin, n, w), along(far, n, w), along(far, n, -w), along(a.origin, n, -w)],
      };
    }
    case "cube": {
      const d = dirOf(a.dirDeg);
      const n = perpOf(d);
      const h = a.size / 2;
      // On a face: the origin is the middle of the face nearest the creator; placed at range, the square's centre.
      const near = a.originOnFace ? a.origin : along(a.origin, d, -h);
      const far = along(near, d, a.size);
      return {
        kind: "poly",
        points: [along(near, n, h), along(far, n, h), along(far, n, -h), along(near, n, -h)],
      };
    }
    case "wall":
      return { kind: "strip", points: a.points, closed: a.closed, halfWidth: a.thickness / 2 };
  }
}

/** The vertical extent an area covers (§17.1 "Vertical extent"), for flying creatures; at the footprint's point `p`. */
export function verticalExtent(a: AreaShape, p: P): [number, number] {
  const z = a.z ?? 0;
  switch (a.kind) {
    case "sphere":
      return [z - a.radius, z + a.radius];
    case "cylinder":
      return [z, z + a.height];
    case "emanation":
      return [z - a.distance, z + (a.sourceHeight ?? 0) + a.distance];
    case "cube":
      return [z, z + a.size];
    case "wall":
      return [z, z + a.height];
    case "cone": {
      // Its width at that distance along the axis, centred on the origin's height.
      const d = dirOf(a.dirDeg);
      const x = Math.max(0, (p.x - a.origin.x) * d.x + (p.y - a.origin.y) * d.y);
      return [z - x / 2, z + x / 2];
    }
    case "line":
      return [z - a.width / 2, z + a.width / 2];
  }
}

/** The polygon's edges. */
function edges(points: P[], closed: boolean): [P, P][] {
  const out: [P, P][] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push([points[i] as P, points[i + 1] as P]);
  if (closed && points.length > 2) out.push([points[points.length - 1] as P, points[0] as P]);
  return out;
}

function inside(p: P, poly: P[]): boolean {
  let s = 0;
  for (const [a, b] of edges(poly, true)) {
    const c = cross(sub(b, a), sub(p, a));
    if (c !== 0) {
      if (s === 0) s = Math.sign(c);
      else if (Math.sign(c) !== s) return false;
    }
  }
  return true;
}

/** Whether a footprint contains a point. */
export function contains(f: Footprint, p: P): boolean {
  if (f.kind === "circle") return dist(p, f.c) <= f.r + 1e-9;
  if (f.kind === "poly") return inside(p, f.points);
  return edges(f.points, f.closed).some(([a, b]) => pointSegDist(p, a, b) <= f.halfWidth + 1e-9);
}

/** Whether a creature's base circle (centre `c`, radius `r`) overlaps a footprint at all. */
export function overlaps(f: Footprint, c: P, r: number): boolean {
  if (f.kind === "circle") return dist(c, f.c) < f.r + r;
  if (f.kind === "poly")
    return inside(c, f.points) || edges(f.points, true).some(([a, b]) => pointSegDist(c, a, b) < r);
  return edges(f.points, f.closed).some(([a, b]) => pointSegDist(c, a, b) < f.halfWidth + r);
}

/** Whether two footprints overlap at all (spells undoing each other: Daylight over Darkness). */
export function footprintsOverlap(f: Footprint, g: Footprint): boolean {
  if (f.kind === "circle") return overlaps(g, f.c, f.r);
  if (g.kind === "circle") return overlaps(f, g.c, g.r);
  const a = f.points;
  const b = g.points;
  if (f.kind === "poly" && b.some((p) => inside(p, f.points))) return true;
  if (g.kind === "poly" && a.some((p) => inside(p, g.points))) return true;
  const ea = edges(a, f.kind === "poly" || (f.kind === "strip" && f.closed));
  const eb = edges(b, g.kind === "poly" || (g.kind === "strip" && g.closed));
  const pad = (f.kind === "strip" ? f.halfWidth : 0) + (g.kind === "strip" ? g.halfWidth : 0);
  for (const [p, q] of ea)
    for (const [r, s] of eb) {
      if (segIntersect(p, q, r, s)) return true;
      if (
        pad > 0 &&
        Math.min(pointSegDist(p, r, s), pointSegDist(q, r, s), pointSegDist(r, p, q), pointSegDist(s, p, q)) <
          pad
      )
        return true;
    }
  return false;
}

/** A wall segment and what it stops (a closed door stops both; an open one neither). */
export interface Barrier {
  a: P;
  b: P;
  blocksMove: boolean;
  blocksSight: boolean;
}

/** Whether a straight line from `p` to `q` crosses a barrier the filter counts. */
function blocked(p: P, q: P, barriers: readonly Barrier[], counts: (w: Barrier) => boolean): boolean {
  for (const w of barriers) {
    if (!counts(w)) continue;
    const hit = segIntersect(p, q, w.a, w.b);
    if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6) return true;
  }
  return false;
}

/** The 9 points a creature's line of effect is sampled at (§17.3): its centre and 8 round its base at 0.9 radius. */
export function samplePoints(c: P, r: number): P[] {
  const out: P[] = [c];
  for (let k = 0; k < 8; k++) {
    const t = (k / 8) * 2 * Math.PI;
    out.push({ x: c.x + Math.cos(t) * r * 0.9, y: c.y + Math.sin(t) * r * 0.9 });
  }
  return out;
}

/** The point an area's effect spreads from (§17.2): its origin, or an emanation's source. */
export function originOf(a: AreaShape): P {
  if (a.kind === "emanation") return a.source;
  if (a.kind === "wall") return a.points[0] ?? { x: 0, y: 0 };
  return a.origin;
}

export interface AreaCreature {
  id: string;
  pos: P;
  /** Base radius (ft). */
  r: number;
  /** Elevation of its base, and how tall it stands (ft). */
  z: number;
  height: number;
}

export type Affected = { id: string; affected: true } | { id: string; affected: false; blocked: boolean };

/**
 * Who an area affects (§17.3): a creature whose base overlaps the footprint (house rule *Area coverage*: `touches`,
 * any overlap — or `centre`, its centre inside), whose height range meets the area's vertical extent, and to at least
 * one of whose 9 sample points a straight line from the area's origin crosses no wall giving total cover (one that
 * blocks movement). One every line of which is blocked is "blocked" (the DM may add it back). An emanation leaves
 * out its source unless `includeSource`.
 */
export function affected(
  a: AreaShape,
  creatures: readonly AreaCreature[],
  barriers: readonly Barrier[],
  opts: { coverage?: "touches" | "centre"; sourceId?: string | null; includeSource?: boolean } = {},
): Affected[] {
  const f = footprint(a);
  const origin = originOf(a);
  const out: Affected[] = [];
  for (const c of creatures) {
    if (opts.sourceId && c.id === opts.sourceId && !opts.includeSource) {
      out.push({ id: c.id, affected: false, blocked: false });
      continue;
    }
    const inArea = opts.coverage === "centre" ? contains(f, c.pos) : overlaps(f, c.pos, c.r);
    const [lo, hi] = verticalExtent(a, c.pos);
    const inHeight = c.z <= hi && c.z + c.height >= lo;
    if (!inArea || !inHeight) {
      out.push({ id: c.id, affected: false, blocked: false });
      continue;
    }
    // A wall's own area reaches both its sides: no line of effect to check.
    const reached =
      a.kind === "wall" ||
      samplePoints(c.pos, c.r).some((s) => !blocked(origin, s, barriers, (w) => w.blocksMove));
    out.push(reached ? { id: c.id, affected: true } : { id: c.id, affected: false, blocked: true });
  }
  return out;
}

/**
 * Whether a caster can place an area's origin there (§17.3 Range): within range of its base edge (Touch: its reach;
 * Self: at the caster) and with an unblocked line of effect from it. Returns why not, for the template's red.
 */
export function canPlace(
  caster: { pos: P; r: number },
  origin: P,
  range: { kind: "self" } | { kind: "touch"; reach?: number } | { kind: "ft"; ft: number },
  barriers: readonly Barrier[],
): { ok: true } | { ok: false; why: "range" | "line" } {
  if (range.kind === "self") return { ok: true };
  const reach = range.kind === "touch" ? (range.reach ?? 5) : range.ft;
  if (dist(caster.pos, origin) - caster.r > reach + 1e-6) return { ok: false, why: "range" };
  if (blocked(caster.pos, origin, barriers, (w) => w.blocksMove)) return { ok: false, why: "line" };
  return { ok: true };
}

/** An area's primary dimension grown with the slot (SpellArea.scaling: feet per slot level above the spell's). */
export function scaledDimension(
  base: number,
  perSlot: number | undefined,
  spellLevel: number,
  slot: number,
): number {
  return base + Math.max(0, slot - spellLevel) * (perSlot ?? 0);
}

export type Cover = "none" | "half" | "threeQuarters" | "total";
/** The AC (and Dex save) bonus a cover grants (SRD 5.2.1). */
export const COVER_BONUS: Record<Cover, number | null> = { none: 0, half: 2, threeQuarters: 5, total: null };

/**
 * The cover hint (§17.5): five rays from the attacker's centre (or the area's origin) to the target — its centre and
 * four points at 0.9 × its base radius, two across the line of attack and two along it — counted blocked when a wall
 * stops movement or sight: none, 1–2 half, 3–4 three-quarters, all 5 total. The centre ray through another
 * creature's base gives at least half. A hint; the DM decides.
 */
export function coverHint(
  from: P,
  target: { pos: P; r: number },
  barriers: readonly Barrier[],
  others: readonly { pos: P; r: number }[] = [],
): { cover: Cover; blocked: number } {
  const v = sub(target.pos, from);
  const len = Math.hypot(v.x, v.y) || 1;
  const d = { x: v.x / len, y: v.y / len };
  const n = perpOf(d);
  const k = 0.9 * target.r;
  const points = [
    target.pos,
    along(target.pos, n, k),
    along(target.pos, n, -k),
    along(target.pos, d, k),
    along(target.pos, d, -k),
  ];
  let count = 0;
  for (const p of points) if (blocked(from, p, barriers, (w) => w.blocksMove || w.blocksSight)) count++;
  let cover: Cover = count === 0 ? "none" : count <= 2 ? "half" : count <= 4 ? "threeQuarters" : "total";
  if (cover === "none") {
    // A creature standing in the way of the centre ray.
    const inWay = others.some((o) => {
      const t = ((o.pos.x - from.x) * v.x + (o.pos.y - from.y) * v.y) / (len * len);
      if (t <= 0 || t >= 1) return false;
      return pointSegDist(o.pos, from, target.pos) < o.r;
    });
    if (inWay) cover = "half";
  }
  return { cover, blocked: count };
}

export * from "./effects.ts";
export * from "./place.ts";
