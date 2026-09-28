/**
 * Visibility polygons (SPEC §15.2): the region seen from an eye within a radius, bounded by blocking segments — by
 * rotational sweep. Blocking segments are prepared once per wall set (`SegmentSet`: crossings, T-junctions and
 * collinear overlaps split, endpoints within 1e-6 ft welded, a 10-ft spatial hash), so that no two segments cross
 * inside: along any ray the order of the segments it meets is then the same all through an angular interval between
 * two endpoints, and the sweep only has to find the nearest segment once per interval.
 *
 * Angles are atan2(dy, dx) in (−π, π] on the table plane (x east, y south); the polygon runs in increasing angle.
 */
import type { P, Seg } from "./index.ts";

/** Endpoints closer than this are one point (§15.2). */
export const WELD_FT = 1e-6;
/** How far an eye on a wall line is moved off it (§15.2). */
export const EYE_NUDGE_FT = 0.01;
/** The radius bound is a regular polygon with this many sides (vertices on the radius circle). */
export const BOUND_SIDES = 64;
const HASH_CELL_FT = 10;
const TAU = Math.PI * 2;

/** Blocking segments prepared for visibility queries (build once per wall set; cheap to query many times). */
export class SegmentSet {
  /** Segment i runs from (ax[i], ay[i]) to (bx[i], by[i]). */
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly bx: Float64Array;
  readonly by: Float64Array;
  readonly n: number;
  private readonly grid = new Map<number, number[]>();
  private readonly seen: Uint32Array;
  private tick = 0;

  /** From flat [ax, ay, bx, by, …] (or segment objects). */
  constructor(input: ArrayLike<number> | readonly Seg[]) {
    const flat = isSegArray(input) ? flatten(input) : input;
    const out = prepare(flat);
    this.n = out.length / 4;
    this.ax = new Float64Array(this.n);
    this.ay = new Float64Array(this.n);
    this.bx = new Float64Array(this.n);
    this.by = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.ax[i] = out[i * 4] as number;
      this.ay[i] = out[i * 4 + 1] as number;
      this.bx[i] = out[i * 4 + 2] as number;
      this.by[i] = out[i * 4 + 3] as number;
      forCells(
        this.ax[i] as number,
        this.ay[i] as number,
        this.bx[i] as number,
        this.by[i] as number,
        (k) => {
          const list = this.grid.get(k);
          if (list) list.push(i);
          else this.grid.set(k, [i]);
        },
      );
    }
    this.seen = new Uint32Array(this.n);
  }

  /** Calls fn once for every segment that may come within r of (cx, cy) (its hash cells meet the square). */
  forNear(cx: number, cy: number, r: number, fn: (i: number) => void): void {
    if (++this.tick === 0xffffffff) {
      this.seen.fill(0);
      this.tick = 1;
    }
    const t = this.tick;
    const x0 = Math.floor((cx - r) / HASH_CELL_FT);
    const x1 = Math.floor((cx + r) / HASH_CELL_FT);
    const y0 = Math.floor((cy - r) / HASH_CELL_FT);
    const y1 = Math.floor((cy + r) / HASH_CELL_FT);
    // A radius wider than the whole set: every segment, without walking empty cells.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.grid.size * 4) {
      for (let i = 0; i < this.n; i++) fn(i);
      return;
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const list = this.grid.get(cellKey(x, y));
        if (!list) continue;
        for (const i of list) {
          if (this.seen[i] === t) continue;
          this.seen[i] = t;
          fn(i);
        }
      }
  }
}

function isSegArray(v: ArrayLike<number> | readonly Seg[]): v is readonly Seg[] {
  return v.length > 0 && typeof (v as readonly Seg[])[0] === "object";
}
function flatten(segs: readonly Seg[]): number[] {
  const out: number[] = [];
  for (const s of segs) out.push(s.a.x, s.a.y, s.b.x, s.b.y);
  return out;
}
const cellKey = (x: number, y: number) => (x + 1e6) * 4e6 + (y + 1e6);
function forCells(ax: number, ay: number, bx: number, by: number, fn: (k: number) => void) {
  const x0 = Math.floor(Math.min(ax, bx) / HASH_CELL_FT);
  const x1 = Math.floor(Math.max(ax, bx) / HASH_CELL_FT);
  const y0 = Math.floor(Math.min(ay, by) / HASH_CELL_FT);
  const y1 = Math.floor(Math.max(ay, by) / HASH_CELL_FT);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(cellKey(x, y));
}

/** Welds endpoints, splits segments where they cross or touch, drops duplicates: no two results cross inside. */
function prepare(flat: ArrayLike<number>): number[] {
  // Vertices, welded through a fine hash (a point is looked up in its cell and the 8 around it).
  const vx: number[] = [];
  const vy: number[] = [];
  const vHash = new Map<number, number[]>();
  const W = WELD_FT * 4;
  const vertex = (x: number, y: number): number => {
    const cx = Math.floor(x / W);
    const cy = Math.floor(y / W);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const list = vHash.get(cellKey(cx + i, cy + j));
        if (!list) continue;
        for (const v of list)
          if (Math.abs((vx[v] as number) - x) <= WELD_FT && Math.abs((vy[v] as number) - y) <= WELD_FT)
            return v;
      }
    const v = vx.length;
    vx.push(x);
    vy.push(y);
    const k = cellKey(cx, cy);
    const list = vHash.get(k);
    if (list) list.push(v);
    else vHash.set(k, [v]);
    return v;
  };

  const sa: number[] = [];
  const sb: number[] = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const a = vertex(flat[i] as number, flat[i + 1] as number);
    const b = vertex(flat[i + 2] as number, flat[i + 3] as number);
    if (a !== b) {
      sa.push(a);
      sb.push(b);
    }
  }
  const n = sa.length;
  // Split points per segment (vertex ids with their parameter along it).
  const splits: { t: number; v: number }[][] = Array.from({ length: n }, () => []);
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const a = sa[i] as number;
    const b = sb[i] as number;
    forCells(vx[a] as number, vy[a] as number, vx[b] as number, vy[b] as number, (k) => {
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    });
  }
  const tested = new Set<number>();
  /** v lies inside segment s (not at its ends, within the weld distance): split s there. */
  const touch = (s: number, v: number) => {
    const a = sa[s] as number;
    const b = sb[s] as number;
    if (v === a || v === b) return;
    const ex = (vx[b] as number) - (vx[a] as number);
    const ey = (vy[b] as number) - (vy[a] as number);
    const px = (vx[v] as number) - (vx[a] as number);
    const py = (vy[v] as number) - (vy[a] as number);
    const L2 = ex * ex + ey * ey;
    const t = (px * ex + py * ey) / L2;
    if (t <= 0 || t >= 1) return;
    const qx = px - t * ex;
    const qy = py - t * ey;
    if (qx * qx + qy * qy <= WELD_FT * WELD_FT) (splits[s] as { t: number; v: number }[]).push({ t, v });
  };
  for (const list of grid.values())
    for (let p = 0; p < list.length; p++)
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p] as number;
        const j = list[q] as number;
        const key = i < j ? i * n + j : j * n + i;
        if (tested.has(key)) continue;
        tested.add(key);
        const a = sa[i] as number;
        const b = sb[i] as number;
        const c = sa[j] as number;
        const d = sb[j] as number;
        // Endpoints on the other's inside (T-junctions, collinear overlaps).
        touch(i, c);
        touch(i, d);
        touch(j, a);
        touch(j, b);
        if (a === c || a === d || b === c || b === d) continue;
        // A proper crossing.
        const rx = (vx[b] as number) - (vx[a] as number);
        const ry = (vy[b] as number) - (vy[a] as number);
        const sx = (vx[d] as number) - (vx[c] as number);
        const sy = (vy[d] as number) - (vy[c] as number);
        const den = rx * sy - ry * sx;
        if (den === 0) continue;
        const qx = (vx[c] as number) - (vx[a] as number);
        const qy = (vy[c] as number) - (vy[a] as number);
        const t = (qx * sy - qy * sx) / den;
        const u = (qx * ry - qy * rx) / den;
        if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
        const v = vertex((vx[a] as number) + t * rx, (vy[a] as number) + t * ry);
        if (v !== a && v !== b) (splits[i] as { t: number; v: number }[]).push({ t, v });
        if (v !== c && v !== d) (splits[j] as { t: number; v: number }[]).push({ t: u, v });
      }
  const out: number[] = [];
  const done = new Set<number>();
  const V = vx.length;
  for (let i = 0; i < n; i++) {
    const pts = (splits[i] as { t: number; v: number }[]).sort((p, q) => p.t - q.t);
    let prev = sa[i] as number;
    for (const v of [...pts.map((p) => p.v), sb[i] as number]) {
      if (v === prev) continue;
      const key = prev < v ? prev * V + v : v * V + prev;
      if (!done.has(key)) {
        done.add(key);
        out.push(vx[prev] as number, vy[prev] as number, vx[v] as number, vy[v] as number);
      }
      prev = v;
    }
  }
  return out;
}

/**
 * The region seen from an eye: interval k spans angles [ang[k], ang[k+1]] (ang[0] = −π, the last = π), inside which
 * the visible region is the triangle (eye, edge start, edge end) — edge k runs from (edge[4k], edge[4k+1]) to
 * (edge[4k+2], edge[4k+3]).
 */
export interface VisPoly {
  /** The eye actually used (moved off a wall line, if it was on one). */
  eye: P;
  radius: number;
  ang: Float64Array;
  edge: Float64Array;
}

interface Piece {
  lo: number;
  hi: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The region visible from `eye` within `radius` (bounded by a 64-gon with its vertices on the radius), blocked by the
 * set's segments. An eye on a segment is moved 0.01 ft toward `towards` (the token centre) or, without one (or when
 * that's the eye itself), off the segment's left side.
 */
export function visibilityPolygon(eye: P, set: SegmentSet, radius: number, towards?: P): VisPoly {
  let ex = eye.x;
  let ey = eye.y;
  for (let tries = 0; tries < 4; tries++) {
    let hit = -1;
    set.forNear(ex, ey, WELD_FT * 2, (i) => {
      if (hit < 0 && pointSegD2(ex, ey, set, i) <= WELD_FT * WELD_FT) hit = i;
    });
    if (hit < 0) break;
    let dx = 0;
    let dy = 0;
    if (towards) {
      dx = towards.x - ex;
      dy = towards.y - ey;
    }
    let L = Math.hypot(dx, dy);
    if (L < 1e-9 || tries > 0) {
      // Off the segment's side (alternating, should the first side sit on another segment).
      dx = -((set.by[hit] as number) - (set.ay[hit] as number));
      dy = (set.bx[hit] as number) - (set.ax[hit] as number);
      if (tries % 2 === 1) {
        dx = -dx;
        dy = -dy;
      }
      L = Math.hypot(dx, dy);
    }
    ex += (dx / L) * EYE_NUDGE_FT;
    ey += (dy / L) * EYE_NUDGE_FT;
  }

  const R = radius;
  const pieces: Piece[] = [];
  // The bound: vertices at φk = −π + k·2π/64 (vertex 0 on the −x ray; the last piece ends there again at +π).
  const bx: number[] = [];
  const by: number[] = [];
  for (let k = 0; k <= BOUND_SIDES; k++) {
    const a = -Math.PI + ((k % BOUND_SIDES) * TAU) / BOUND_SIDES;
    bx.push(ex + R * Math.cos(a));
    by.push(ey + R * Math.sin(a));
  }
  for (let k = 1; k <= BOUND_SIDES; k++)
    pieces.push({
      lo: -Math.PI + ((k - 1) * TAU) / BOUND_SIDES,
      hi: k === BOUND_SIDES ? Math.PI : -Math.PI + (k * TAU) / BOUND_SIDES,
      x0: bx[k - 1] as number,
      y0: by[k - 1] as number,
      x1: bx[k] as number,
      y1: by[k] as number,
    });
  // Inside this distance no clipping to the bound is needed (the bound's inscribed circle).
  const inner2 = (R * Math.cos(Math.PI / BOUND_SIDES)) ** 2;
  set.forNear(ex, ey, R, (i) => {
    let x0 = set.ax[i] as number;
    let y0 = set.ay[i] as number;
    let x1 = set.bx[i] as number;
    let y1 = set.by[i] as number;
    if ((x0 - ex) ** 2 + (y0 - ey) ** 2 > inner2 || (x1 - ex) ** 2 + (y1 - ey) ** 2 > inner2) {
      const c = clipToBound(x0, y0, x1, y1, bx, by);
      if (!c) return;
      [x0, y0, x1, y1] = c;
    }
    addPiece(pieces, ex, ey, x0, y0, x1, y1);
  });

  // Every endpoint angle, sorted and unique.
  const evAll = new Float64Array(pieces.length * 2);
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i] as Piece;
    evAll[i * 2] = p.lo;
    evAll[i * 2 + 1] = p.hi;
  }
  evAll.sort();
  let m = 0;
  for (let i = 0; i < evAll.length; i++)
    if (i === 0 || evAll[i] !== evAll[m - 1]) evAll[m++] = evAll[i] as number;
  const ev = evAll.subarray(0, m);
  pieces.sort((p, q) => p.lo - q.lo);

  const ang: number[] = [];
  const edge: number[] = [];
  let active: Piece[] = [];
  let next = 0;
  let last: Piece | null = null;
  for (let k = 0; k + 1 < ev.length; k++) {
    const t0 = ev[k] as number;
    const t1 = ev[k + 1] as number;
    while (next < pieces.length && (pieces[next] as Piece).lo <= t0) active.push(pieces[next++] as Piece);
    if (active.some((p) => p.hi <= t0)) active = active.filter((p) => p.hi > t0);
    // The nearest piece along the interval's middle ray is the nearest all through it (no two cross inside).
    const tm = (t0 + t1) / 2;
    const dx = Math.cos(tm);
    const dy = Math.sin(tm);
    let best: Piece | null = null;
    let bestT = Number.POSITIVE_INFINITY;
    for (const p of active) {
      const t = rayHit(ex, ey, dx, dy, p);
      if (t < bestT) {
        bestT = t;
        best = p;
      }
    }
    if (!best) continue; // (the bound covers every direction; only a degenerate interval gets here)
    const s0x =
      best.lo === t0 ? best.x0 : ex + Math.cos(t0) * rayHit(ex, ey, Math.cos(t0), Math.sin(t0), best);
    const s0y =
      best.lo === t0 ? best.y0 : ey + Math.sin(t0) * rayHit(ex, ey, Math.cos(t0), Math.sin(t0), best);
    const s1x =
      best.hi === t1 ? best.x1 : ex + Math.cos(t1) * rayHit(ex, ey, Math.cos(t1), Math.sin(t1), best);
    const s1y =
      best.hi === t1 ? best.y1 : ey + Math.sin(t1) * rayHit(ex, ey, Math.cos(t1), Math.sin(t1), best);
    if (best === last) {
      // The same segment goes on: extend the last edge.
      edge[edge.length - 2] = s1x;
      edge[edge.length - 1] = s1y;
    } else {
      ang.push(t0);
      edge.push(s0x, s0y, s1x, s1y);
      last = best;
    }
  }
  ang.push(Math.PI);
  return { eye: { x: ex, y: ey }, radius: R, ang: Float64Array.from(ang), edge: Float64Array.from(edge) };
}

function pointSegD2(px: number, py: number, s: SegmentSet, i: number): number {
  const ax = s.ax[i] as number;
  const ay = s.ay[i] as number;
  const dx = (s.bx[i] as number) - ax;
  const dy = (s.by[i] as number) - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
}

/** Distance along the ray (unit direction) to the piece's line; +∞ when parallel or behind. */
function rayHit(ex: number, ey: number, dx: number, dy: number, p: Piece): number {
  const sx = p.x1 - p.x0;
  const sy = p.y1 - p.y0;
  const den = dx * sy - dy * sx;
  if (den === 0) return Number.POSITIVE_INFINITY;
  const t = ((p.x0 - ex) * sy - (p.y0 - ey) * sx) / den;
  return t > 0 ? t : Number.POSITIVE_INFINITY;
}

/** Adds a segment as one or two pieces running in increasing angle (split where it crosses the −x ray). */
function addPiece(out: Piece[], ex: number, ey: number, x0: number, y0: number, x1: number, y1: number) {
  let ux = x0 - ex;
  let uy = y0 - ey;
  let vx = x1 - ex;
  let vy = y1 - ey;
  const cr = ux * vy - uy * vx;
  // Edge-on to the eye: it hides nothing.
  if (Math.abs(cr) <= 1e-12 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) return;
  if (cr < 0) {
    [x0, y0, x1, y1] = [x1, y1, x0, y0];
    [ux, uy, vx, vy] = [vx, vy, ux, uy];
  }
  let a0 = angleOf(ux, uy);
  const a1 = angleOf(vx, vy);
  if (a1 >= a0) {
    out.push({ lo: a0, hi: a1, x0, y0, x1, y1 });
    return;
  }
  // It wraps past ±π: the start on the −x ray is −π; otherwise split at the ray.
  if (uy === 0 && ux < 0) {
    a0 = -Math.PI;
    out.push({ lo: a0, hi: a1, x0, y0, x1, y1 });
    return;
  }
  const t = uy / (uy - vy);
  const cx = x0 + (x1 - x0) * t;
  out.push({ lo: a0, hi: Math.PI, x0, y0, x1: cx, y1: ey });
  out.push({ lo: -Math.PI, hi: a1, x0: cx, y0: ey, x1, y1 });
}

/** atan2 in (−π, π], with the −x ray at +π. */
function angleOf(x: number, y: number): number {
  return y === 0 && x < 0 ? Math.PI : Math.atan2(y, x);
}

/** A segment clipped to the (convex) bound polygon, or null when outside it. */
function clipToBound(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bx: number[],
  by: number[],
): [number, number, number, number] | null {
  let tIn = 0;
  let tOut = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  for (let k = 0; k < BOUND_SIDES; k++) {
    const px = bx[k] as number;
    const py = by[k] as number;
    const ex = (bx[k + 1] as number) - px;
    const ey = (by[k + 1] as number) - py;
    // Inside is to the left of each edge (the bound runs in increasing angle).
    const num = ex * (y0 - py) - ey * (x0 - px);
    const den = ex * dy - ey * dx;
    if (den === 0) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) tIn = Math.max(tIn, t);
    else tOut = Math.min(tOut, t);
    if (tIn >= tOut) return null;
  }
  return [x0 + dx * tIn, y0 + dy * tIn, x0 + dx * tOut, y0 + dy * tOut];
}

/** Whether (x, y) lies in the visible region (O(log n)). */
export function visContains(v: VisPoly, x: number, y: number): boolean {
  const dx = x - v.eye.x;
  const dy = y - v.eye.y;
  if (dx === 0 && dy === 0) return true;
  if (dx * dx + dy * dy > v.radius * v.radius) return false;
  const a = angleOf(dx, dy);
  // The interval holding a: the last k with ang[k] ≤ a.
  let lo = 0;
  let hi = v.ang.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((v.ang[mid] as number) <= a) lo = mid;
    else hi = mid - 1;
  }
  const e = v.edge;
  const x0 = e[lo * 4] as number;
  const y0 = e[lo * 4 + 1] as number;
  const x1 = e[lo * 4 + 2] as number;
  const y1 = e[lo * 4 + 3] as number;
  // On the eye's side of the edge (the edge runs in increasing angle: the eye is on its left).
  return (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0) >= 0;
}

interface Outline {
  ring: Float64Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
/** Outlines by region (a region never changes once made). */
const outlines = new WeakMap<VisPoly, Outline>();

function outlineOf(v: VisPoly): Outline {
  let o = outlines.get(v);
  if (!o) {
    const ring = makeRing(v);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < ring.length; k += 2) {
      const x = ring[k] as number;
      const y = ring[k + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    o = { ring, minX, minY, maxX, maxY };
    outlines.set(v, o);
  }
  return o;
}

/**
 * The region's outline as a closed ring [x0, y0, x1, y1, …] in increasing angle (for drawing as a fan). Made once per
 * region and shared: read it, never write to it.
 */
export function visRing(v: VisPoly): Float64Array {
  return outlineOf(v).ring;
}

/** The region's bounding box. */
export function visBox(v: VisPoly): { minX: number; minY: number; maxX: number; maxY: number } {
  return outlineOf(v);
}

/**
 * Whether the segment ab comes within `margin` of the (closed) region: an end inside it, or the segment within margin
 * of its outline.
 */
export function visNear(v: VisPoly, ax: number, ay: number, bx: number, by: number, margin: number): boolean {
  const o = outlineOf(v);
  if (Math.max(ax, bx) + margin < o.minX || Math.min(ax, bx) - margin > o.maxX) return false;
  if (Math.max(ay, by) + margin < o.minY || Math.min(ay, by) - margin > o.maxY) return false;
  if (visContains(v, ax, ay) || visContains(v, bx, by)) return true;
  const r = o.ring;
  const n = r.length / 2;
  const m2 = margin * margin;
  for (let k = 0; k < n; k++) {
    const cx = r[k * 2] as number;
    const cy = r[k * 2 + 1] as number;
    const dx = r[((k + 1) % n) * 2] as number;
    const dy = r[((k + 1) % n) * 2 + 1] as number;
    if (Math.max(cx, dx) + margin < Math.min(ax, bx) || Math.min(cx, dx) - margin > Math.max(ax, bx))
      continue;
    if (Math.max(cy, dy) + margin < Math.min(ay, by) || Math.min(cy, dy) - margin > Math.max(ay, by))
      continue;
    if (segSegD2(ax, ay, bx, by, cx, cy, dx, dy) <= m2) return true;
  }
  return false;
}

/** Squared distance between segments ab and cd (0 when they cross). */
function segSegD2(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay);
  const d2 = o(cx, cy, dx, dy, bx, by);
  const d3 = o(ax, ay, bx, by, cx, cy);
  const d4 = o(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    ptSegD2(ax, ay, cx, cy, dx, dy),
    ptSegD2(bx, by, cx, cy, dx, dy),
    ptSegD2(cx, cy, ax, ay, bx, by),
    ptSegD2(dx, dy, ax, ay, bx, by),
  );
}

function ptSegD2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ux = bx - ax;
  const uy = by - ay;
  const L = ux * ux + uy * uy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * ux + (py - ay) * uy) / L));
  const qx = ax + ux * t - px;
  const qy = ay + uy * t - py;
  return qx * qx + qy * qy;
}

/** A cone from a region's eye: its facing (radians, as atan2 measures) and half-angle. */
export interface Wedge {
  dir: number;
  half: number;
}

/** Overlaps thinner than this (ft) are touching, not overlapping (two regions ending on one wall line from its sides). */
const OVERLAP_EPS = 1e-6;

/**
 * Whether two regions overlap in area — more than touching: two regions ending on the same wall line from its two
 * sides don't. `wedge` first cuts `a` to a cone from its eye (a cone light's lit area). Exact (to 1e-6 ft): each region
 * is a fan of triangles about its eye, and two triangles overlap unless one of their edge normals separates them.
 */
export function visOverlap(a: VisPoly, b: VisPoly, wedge?: Wedge | null): boolean {
  const A = outlineOf(a);
  const B = outlineOf(b);
  if (A.maxX <= B.minX || B.maxX <= A.minX || A.maxY <= B.minY || B.maxY <= A.minY) return false;
  const cut = wedge && wedge.half < Math.PI ? wedge : null;
  // Quick yeses: an eye (which has room round it in its own region) inside the other region.
  if (!cut && visContains(b, a.eye.x, a.eye.y)) return true;
  if (
    visContains(a, b.eye.x, b.eye.y) &&
    (!cut || inCone(b.eye.x - a.eye.x, b.eye.y - a.eye.y, cut.dir, cut.half))
  )
    return true;
  const ta = cut ? fan(a, cut) : fanOf(a);
  const tb = fanOf(b);
  // B's triangles that reach A's box; then each of A's against those.
  const near: number[] = [];
  for (let j = 0; j < tb.length; j += TRI)
    if (
      !(
        (tb[j + 8] as number) <= A.minX ||
        (tb[j + 6] as number) >= A.maxX ||
        (tb[j + 9] as number) <= A.minY ||
        (tb[j + 7] as number) >= A.maxY
      )
    )
      near.push(j);
  if (!near.length) return false;
  for (let i = 0; i < ta.length; i += TRI) {
    const x0 = ta[i + 6] as number;
    const y0 = ta[i + 7] as number;
    const x1 = ta[i + 8] as number;
    const y1 = ta[i + 9] as number;
    if (x1 <= B.minX || x0 >= B.maxX || y1 <= B.minY || y0 >= B.maxY) continue;
    for (const j of near) {
      if (x1 <= (tb[j + 6] as number) || x0 >= (tb[j + 8] as number)) continue;
      if (y1 <= (tb[j + 7] as number) || y0 >= (tb[j + 9] as number)) continue;
      if (!separates(ta, i, tb, j) && !separates(tb, j, ta, i)) return true;
    }
  }
  return false;
}

/** Floats per fan triangle: three corners, then its box (minX, minY, maxX, maxY). */
const TRI = 10;
const fans = new WeakMap<VisPoly, Float64Array>();

function fanOf(v: VisPoly): Float64Array {
  let f = fans.get(v);
  if (!f) {
    f = fan(v, null);
    fans.set(v, f);
  }
  return f;
}

/** The region's triangles about its eye (cut to a cone when given), without the empty ones. */
function fan(v: VisPoly, cut: Wedge | null): Float64Array {
  const out: number[] = [];
  const ex = v.eye.x;
  const ey = v.eye.y;
  // The cone as one or two angle ranges within [−π, π].
  const ranges: [number, number][] = [];
  if (!cut) ranges.push([-Math.PI, Math.PI]);
  else {
    const lo = wrapAngle(cut.dir - cut.half);
    const hi = lo + 2 * cut.half;
    if (hi <= Math.PI) ranges.push([lo, hi]);
    else ranges.push([lo, Math.PI], [-Math.PI, hi - 2 * Math.PI]);
  }
  const e = v.edge;
  const ang = v.ang;
  for (let k = 0; k + 1 < ang.length; k++) {
    const lo = ang[k] as number;
    const hi = ang[k + 1] as number;
    const x0 = e[k * 4] as number;
    const y0 = e[k * 4 + 1] as number;
    const x1 = e[k * 4 + 2] as number;
    const y1 = e[k * 4 + 3] as number;
    for (const [rl, rh] of ranges) {
      const cl = Math.max(lo, rl);
      const ch = Math.min(hi, rh);
      if (ch <= cl) continue;
      const [px, py] = cl === lo ? [x0, y0] : rayOnEdge(ex, ey, cl, x0, y0, x1, y1);
      const [qx, qy] = ch === hi ? [x1, y1] : rayOnEdge(ex, ey, ch, x0, y0, x1, y1);
      if (Math.abs((px - ex) * (qy - ey) - (py - ey) * (qx - ex)) < 1e-12) continue;
      out.push(
        ex,
        ey,
        px,
        py,
        qx,
        qy,
        Math.min(ex, px, qx),
        Math.min(ey, py, qy),
        Math.max(ex, px, qx),
        Math.max(ey, py, qy),
      );
    }
  }
  return Float64Array.from(out);
}

/** Where the ray from (ex, ey) at angle a meets the line through an edge. */
function rayOnEdge(
  ex: number,
  ey: number,
  a: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number] {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const sx = x1 - x0;
  const sy = y1 - y0;
  const den = dx * sy - dy * sx;
  if (Math.abs(den) < 1e-15) return [x0, y0];
  const t = ((x0 - ex) * sy - (y0 - ey) * sx) / den;
  return [ex + dx * t, ey + dy * t];
}

function wrapAngle(a: number): number {
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Whether an edge of triangle t (at i) separates it from triangle u (at j), touching counting as separate. */
function separates(t: Float64Array, i: number, u: Float64Array, j: number): boolean {
  for (let k = 0; k < 3; k++) {
    const ax = t[i + k * 2] as number;
    const ay = t[i + k * 2 + 1] as number;
    const bx = t[i + ((k + 1) % 3) * 2] as number;
    const by = t[i + ((k + 1) % 3) * 2 + 1] as number;
    const nx = by - ay;
    const ny = ax - bx;
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) continue;
    let tMin = Number.POSITIVE_INFINITY;
    let tMax = Number.NEGATIVE_INFINITY;
    let uMin = Number.POSITIVE_INFINITY;
    let uMax = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < 3; c++) {
      const pt = (nx * (t[i + c * 2] as number) + ny * (t[i + c * 2 + 1] as number)) / len;
      const pu = (nx * (u[j + c * 2] as number) + ny * (u[j + c * 2 + 1] as number)) / len;
      if (pt < tMin) tMin = pt;
      if (pt > tMax) tMax = pt;
      if (pu < uMin) uMin = pu;
      if (pu > uMax) uMax = pu;
    }
    if (tMax - uMin <= OVERLAP_EPS || uMax - tMin <= OVERLAP_EPS) return true;
  }
  return false;
}

function makeRing(v: VisPoly): Float64Array {
  const out: number[] = [];
  const e = v.edge;
  const push = (x: number, y: number) => {
    const n = out.length;
    if (n >= 2 && Math.abs((out[n - 2] as number) - x) < 1e-9 && Math.abs((out[n - 1] as number) - y) < 1e-9)
      return;
    out.push(x, y);
  };
  for (let k = 0; k * 4 < e.length; k++) {
    push(e[k * 4] as number, e[k * 4 + 1] as number);
    push(e[k * 4 + 2] as number, e[k * 4 + 3] as number);
  }
  // Closed: the last point is the first again (the ±π ray).
  const n = out.length;
  if (
    n >= 4 &&
    Math.abs((out[0] as number) - (out[n - 2] as number)) < 1e-9 &&
    Math.abs((out[1] as number) - (out[n - 1] as number)) < 1e-9
  )
    out.length = n - 2;
  return Float64Array.from(out);
}

/** Every point tested against a union of regions: visible from any of them. */
export function visAny(vs: readonly VisPoly[], x: number, y: number): boolean {
  for (const v of vs) if (visContains(v, x, y)) return true;
  return false;
}

/** Angle helper for cones: whether direction (dx, dy) lies within `half` of direction `dir` (radians). */
export function inCone(dx: number, dy: number, dir: number, half: number): boolean {
  let d = Math.atan2(dy, dx) - dir;
  d = ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return Math.abs(d) <= half;
}
