import { type P, segSegDist2 } from "../geometry/index.ts";
import { navFor, pointClearAt } from "./nav.ts";
import { type MoveOptions, segmentCost } from "./route.ts";
import type { MoveWorld } from "./world.ts";

/**
 * The movement range field (SPEC §8.6 "Movement range overlay", §16.6; AC-MOV-10): for a creature at `origin`, the
 * cost to reach every cell of a grid around it (cell 0.5 ft for a budget ≤ 30 ft, else 1 ft; covering budget + 5 ft)
 * around walls (a step is blocked where the creature's clearance circle would touch one) and through difficult
 * terrain and water (their costs, §16.4).
 *
 * The wavefront advances cell by cell as fast marching does (nearest first), but each cell remembers the point its
 * cost was measured from — the origin, or a cell by a corner — and a neighbour first tries a straight line from that
 * same point: in open ground the cost is the exact straight-line cost, around corners it bends at cells beside them
 * (within about a cell of the true corner). First-order fast marching is off by a few per cent along diagonals — more
 * than a foot at 60 ft — which the overlay's limit line may not be (within 1 ft of the true geodesic limit).
 */
export interface RangeField {
  /** Cell size (ft) and the grid's corner (the lower-x, lower-y edge) in scene feet. */
  h: number;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** Cost (ft) to each cell's centre; +Infinity where it can't be reached within the field. */
  cost: Float32Array;
  budget: number;
}

export interface RangeOptions extends Partial<MoveOptions> {
  /** The creature's clearance radius (§16.2). */
  rc: number;
  /** Movement left (combat) or its speed (exploration), ft. */
  budget: number;
}

/** Is the straight step a→b clear of walls (by the clearance radius) and solids? */
function stepClear(world: MoveWorld, a: P, b: P, rc: number): boolean {
  const r2 = (rc - 1e-6) * (rc - 1e-6);
  const clear = world.forWallsNear(
    a.x,
    a.y,
    b.x,
    b.y,
    rc,
    (i) =>
      segSegDist2(
        a.x,
        a.y,
        b.x,
        b.y,
        world.wx0[i] as number,
        world.wy0[i] as number,
        world.wx1[i] as number,
        world.wy1[i] as number,
      ) >= r2,
  );
  if (!clear) return false;
  for (const s of world.solids) {
    const R = rc + s.r - 1e-6;
    if (segSegDist2(a.x, a.y, b.x, b.y, s.c.x, s.c.y, s.c.x, s.c.y) < R * R) return false;
  }
  return true;
}

/** A binary min-heap of cell indices by cost. */
class Heap {
  private readonly idx: number[] = [];
  private readonly key: number[] = [];
  get size(): number {
    return this.idx.length;
  }
  push(i: number, k: number): void {
    this.idx.push(i);
    this.key.push(k);
    let c = this.idx.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if ((this.key[p] as number) <= k) break;
      this.swap(c, p);
      c = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.idx[0] as number, this.key[0] as number];
    const li = this.idx.pop() as number;
    const lk = this.key.pop() as number;
    if (this.idx.length) {
      this.idx[0] = li;
      this.key[0] = lk;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < this.idx.length && (this.key[l] as number) < (this.key[m] as number)) m = l;
        if (r < this.idx.length && (this.key[r] as number) < (this.key[m] as number)) m = r;
        if (m === c) break;
        this.swap(c, m);
        c = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const i = this.idx[a] as number;
    this.idx[a] = this.idx[b] as number;
    this.idx[b] = i;
    const k = this.key[a] as number;
    this.key[a] = this.key[b] as number;
    this.key[b] = k;
  }
}

const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export function rangeField(world: MoveWorld, origin: P, opts: RangeOptions): RangeField {
  const budget = Math.max(0, opts.budget);
  const h = budget <= 30 ? 0.5 : 1;
  const half = budget + 5;
  const cols = Math.max(1, Math.ceil((2 * half) / h));
  const rows = cols;
  const x0 = origin.x - half;
  const y0 = origin.y - half;
  const N = cols * rows;
  // Worked in doubles (the heap's keys are exact: a float32 copy made a valid entry look stale), handed back in floats.
  const cost = new Float64Array(N).fill(Number.POSITIVE_INFINITY);
  const srcX = new Float64Array(N);
  const srcY = new Float64Array(N);
  const srcC = new Float64Array(N);
  const known = new Uint8Array(N);
  // Open: a centre where the creature could stand (clear of walls and solids, in bounds); tested once, lazily.
  const open = new Int8Array(N); // 0 untested, 1 open, −1 closed
  const centre = (k: number): P => ({
    x: x0 + ((k % cols) + 0.5) * h,
    y: y0 + (Math.floor(k / cols) + 0.5) * h,
  });
  const isOpen = (k: number) => {
    if (open[k] === 0) {
      const c = centre(k);
      open[k] = pointClearAt(world, c.x, c.y, opts.rc) ? 1 : -1;
    }
    return open[k] === 1;
  };
  const stepCost = (a: P, b: P) => segmentCost(world, a, b, opts).cost;
  // The corners a taut path turns at (§16.3's nodes: rings just outside each wall end's clearance circle, round
  // solids, at difficult ground's corners), bucketed by field cell: bending there, not at a cell centre up to a cell
  // away, keeps the field exact round corners (bending at cell centres added feet round a wall's end).
  const nav = navFor(world, opts.rc);
  const nodesAt = new Map<number, number[]>();
  nav.forNodesIn(x0, y0, x0 + cols * h, y0 + rows * h, (i) => {
    const c = Math.floor(((nav.x[i] as number) - x0) / h);
    const r = Math.floor(((nav.y[i] as number) - y0) / h);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const k = r * cols + c;
    nodesAt.set(k, [...(nodesAt.get(k) ?? []), i]);
  });
  const nodeCost = new Float64Array(nav.n).fill(Number.POSITIVE_INFINITY);
  const nodeP = (i: number): P => ({ x: nav.x[i] as number, y: nav.y[i] as number });
  const near = (c: number, r: number, fn: (i: number) => void) => {
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        for (const i of nodesAt.get(rr * cols + cc) ?? []) fn(i);
      }
  };
  const heap = new Heap();
  const limit = budget + 2 * h;
  // Seed: the cells round the origin that it sees, their cost straight from it.
  const oc = Math.floor((origin.x - x0) / h);
  const or = Math.floor((origin.y - y0) / h);
  for (let dr = -1; dr <= 2; dr++)
    for (let dc = -1; dc <= 2; dc++) {
      const c = oc + dc;
      const r = or + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const k = r * cols + c;
      const p = centre(k);
      if (!isOpen(k) || !stepClear(world, origin, p, opts.rc)) continue;
      const t = stepCost(origin, p);
      if (t < (cost[k] as number)) {
        cost[k] = t;
        srcX[k] = origin.x;
        srcY[k] = origin.y;
        srcC[k] = 0;
        heap.push(k, t);
      }
    }
  while (heap.size) {
    const [k, t] = heap.pop();
    if (known[k] || t > (cost[k] as number) + 1e-9) continue;
    known[k] = 1;
    if (t > limit) break;
    const c = k % cols;
    const r = Math.floor(k / cols);
    const here = centre(k);
    const s = { x: srcX[k] as number, y: srcY[k] as number };
    const sc = srcC[k] as number;
    const fromSelf = Math.abs(s.x - here.x) < 1e-9 && Math.abs(s.y - here.y) < 1e-9;
    // The corner nodes beside this cell: their cost through it (straight from its source where that's clear).
    const corners: { p: P; c: number }[] = [];
    near(c, r, (i) => {
      const v = nodeP(i);
      let best = nodeCost[i] as number;
      if (!fromSelf && stepClear(world, s, v, opts.rc)) best = Math.min(best, sc + stepCost(s, v));
      if (stepClear(world, here, v, opts.rc)) best = Math.min(best, t + stepCost(here, v));
      nodeCost[i] = best;
      if (Number.isFinite(best)) corners.push({ p: v, c: best });
    });
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const n = nr * cols + nc;
      if (known[n] || !isOpen(n)) continue;
      const p = centre(n);
      if (!stepClear(world, here, p, opts.rc)) continue;
      // Straight on from the same point (exact in open ground), else bending here.
      let best = Number.POSITIVE_INFINITY;
      let bx = here.x;
      let by = here.y;
      let bc = t;
      if (!fromSelf && stepClear(world, s, p, opts.rc)) {
        best = sc + stepCost(s, p);
        bx = s.x;
        by = s.y;
        bc = sc;
      }
      const bend = t + stepCost(here, p);
      if (bend < best - 1e-9) {
        best = bend;
        bx = here.x;
        by = here.y;
        bc = t;
      }
      // …or bending at a corner node beside it.
      for (const q of corners) {
        if (q.c >= best) continue;
        const via = q.c + stepCost(q.p, p);
        if (via < best - 1e-9 && stepClear(world, q.p, p, opts.rc)) {
          best = via;
          bx = q.p.x;
          by = q.p.y;
          bc = q.c;
        }
      }
      if (best < (cost[n] as number) - 1e-9) {
        cost[n] = best;
        srcX[n] = bx;
        srcY[n] = by;
        srcC[n] = bc;
        heap.push(n, best);
      }
    }
  }
  return { h, x0, y0, cols, rows, cost: Float32Array.from(cost), budget };
}

/** The field's cost at a point (bilinear between cell centres; +Infinity next to an unreachable cell). */
export function rangeAt(f: RangeField, p: P): number {
  const fx = (p.x - f.x0) / f.h - 0.5;
  const fy = (p.y - f.y0) / f.h - 0.5;
  const c = Math.floor(fx);
  const r = Math.floor(fy);
  if (c < 0 || r < 0 || c + 1 >= f.cols || r + 1 >= f.rows) return Number.POSITIVE_INFINITY;
  const tx = fx - c;
  const ty = fy - r;
  const v = (cc: number, rr: number) => f.cost[rr * f.cols + cc] as number;
  const a = v(c, r);
  const b = v(c + 1, r);
  const d = v(c, r + 1);
  const e = v(c + 1, r + 1);
  if (![a, b, d, e].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
}

/**
 * The limit line: where the field crosses the budget, as points on the grid's cell edges (marching squares' crossing
 * points, interpolated). What the overlay draws bright, and what the tests measure against the true limit.
 */
export function rangeLimit(f: RangeField, at = f.budget): P[] {
  const out: P[] = [];
  const v = (c: number, r: number) => f.cost[r * f.cols + c] as number;
  const px = (c: number) => f.x0 + (c + 0.5) * f.h;
  const py = (r: number) => f.y0 + (r + 0.5) * f.h;
  for (let r = 0; r < f.rows; r++)
    for (let c = 0; c < f.cols; c++) {
      const a = v(c, r);
      if (!Number.isFinite(a)) continue;
      if (c + 1 < f.cols) {
        const b = v(c + 1, r);
        if (Number.isFinite(b) && (a - at) * (b - at) < 0) {
          const t = (at - a) / (b - a);
          out.push({ x: px(c) + t * f.h, y: py(r) });
        }
      }
      if (r + 1 < f.rows) {
        const b = v(c, r + 1);
        if (Number.isFinite(b) && (a - at) * (b - at) < 0) {
          const t = (at - a) / (b - a);
          out.push({ x: px(c), y: py(r) + t * f.h });
        }
      }
    }
  return out;
}
