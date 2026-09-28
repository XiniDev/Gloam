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

/** The region's outline as a closed ring [x0, y0, x1, y1, …] in increasing angle (for drawing as a fan). */
export function visRing(v: VisPoly): Float64Array {
  const out: number[] = [];
  const e = v.edge;
  for (let k = 0; k * 4 < e.length; k++) {
    for (const [x, y] of [
      [e[k * 4] as number, e[k * 4 + 1] as number],
      [e[k * 4 + 2] as number, e[k * 4 + 3] as number],
    ] as const) {
      const n = out.length;
      if (
        n >= 2 &&
        Math.abs((out[n - 2] as number) - x) < 1e-9 &&
        Math.abs((out[n - 1] as number) - y) < 1e-9
      )
        continue;
      out.push(x, y);
    }
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
