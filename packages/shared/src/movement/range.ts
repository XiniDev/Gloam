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
  /**
   * On ground that halves its Speed (Spirit Guardians), what it may have spent there: half the turn's budget less what
   * it had used (rules audit Q1; `Budget.halvedLeft`). Absent: the same as `budget`.
   */
  halvedBudget?: number;
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
  // Ground that halves its Speed: there only while what it has spent is within the halved cap (rules audit Q1).
  const halvedCap = Math.min(budget, opts.halvedBudget ?? budget);
  const halving = halvedCap < budget && world.regions.some((r) => r.kind === "halved");
  const halvedAt = (k: number) => world.regionsAt(centre(k)).halved;
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
    // Past the halved cap on halving ground: it can't be here, nor go on from here.
    if (halving && t > halvedCap + 1e-9 && halvedAt(k)) continue;
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
  // Shown against the one limit (`budget`): halving ground's costs raised by what its cap lacks, so the limit line
  // falls where the halved cap is reached there.
  const shown = Float32Array.from(cost);
  if (halving)
    for (let k = 0; k < N; k++)
      if (Number.isFinite(cost[k] as number) && halvedAt(k))
        shown[k] = (cost[k] as number) + (budget - halvedCap);
  return { h, x0, y0, cols, rows, cost: shown, budget };
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

/** What the overlay draws (the field as seen): each cell's cost and how much of it is reachable ground (0–1). */
export interface RangeDisplay {
  cost: Float32Array;
  reach: Float32Array;
}

/**
 * The field as the overlay draws it (critic P8 r1 #21). The field is where the creature's *centre* can go, so it stops
 * a clearance radius short of a wall or another creature's base — drawn as it is, its limit line would end in open
 * floor. Here each unreachable cell within that band (a wall, or a base's rim, closer than the radius) takes the cost
 * of the nearest reachable centre it can see, so the reachable floor and its limit line run flush to the wall face
 * and round a base's edge; cells inside a base, past a wall, or beyond the budget stay out. Then the cost and the reach
 * mask are each smoothed by a cell (edges come out smooth, not stepped or wriggling), and the cost carried two cells on
 * past the reachable ground (no false limit along its edge). Drawing only: a move's cost is its path's.
 */
export function rangeDisplay(world: MoveWorld, f: RangeField, rc: number): RangeDisplay {
  const { cols, rows, h, x0, y0, cost } = f;
  const out = new Float32Array(cost);
  const hard = new Uint8Array(cols * rows);
  for (let k = 0; k < cost.length; k++) hard[k] = Number.isFinite(cost[k] as number) ? 1 : 0;
  const R = Math.ceil((rc + h) / h);
  const reach2 = (rc + h * 0.5) * (rc + h * 0.5);
  const centre = (c: number, r: number): P => ({ x: x0 + (c + 0.5) * h, y: y0 + (r + 0.5) * h });
  const seen = (a: P, b: P) =>
    world.forWallsNear(a.x, a.y, b.x, b.y, 0, (i) => {
      const ax = world.wx0[i] as number;
      const ay = world.wy0[i] as number;
      const bx = world.wx1[i] as number;
      const by = world.wy1[i] as number;
      const d1x = b.x - a.x;
      const d1y = b.y - a.y;
      const d2x = bx - ax;
      const d2y = by - ay;
      const den = d1x * d2y - d1y * d2x;
      if (Math.abs(den) < 1e-12) return true;
      const t = ((ax - a.x) * d2y - (ay - a.y) * d2x) / den;
      const u = ((ax - a.x) * d1y - (ay - a.y) * d1x) / den;
      return !(t > 1e-6 && t < 1 - 1e-6 && u >= -1e-9 && u <= 1 + 1e-9);
    });
  const inBase = (p: P) => world.solids.some((s) => Math.hypot(p.x - s.c.x, p.y - s.c.y) < s.r);
  const nearObstacle = (p: P) => {
    if (world.solids.some((s) => Math.hypot(p.x - s.c.x, p.y - s.c.y) < s.r + rc)) return true;
    return !world.forWallsNear(p.x, p.y, p.x, p.y, rc, (i) => {
      const ax = world.wx0[i] as number;
      const ay = world.wy0[i] as number;
      const bx = world.wx1[i] as number;
      const by = world.wy1[i] as number;
      return segSegDist2(p.x, p.y, p.x, p.y, ax, ay, bx, by) >= rc * rc;
    });
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (hard[k]) continue;
      const p = centre(c, r);
      if (inBase(p) || !nearObstacle(p)) continue;
      let best = Number.POSITIVE_INFINITY;
      for (let dr = -R; dr <= R; dr++)
        for (let dc = -R; dc <= R; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const j = rr * cols + cc;
          if (!hard[j]) continue;
          const v = cost[j] as number;
          if (v >= best || (dr * dr + dc * dc) * h * h > reach2) continue;
          if (seen(p, centre(cc, rr))) best = v;
        }
      if (Number.isFinite(best)) out[k] = best;
    }
  // The cost itself smoothed by a cell (a 3 × 3 tent over the reachable cells): where the front straight from the
  // creature meets the one bent round a wall's end, the cells take their costs from either side a cell at a time —
  // drawn raw, the limit line wriggled along that seam (critic P8 r2 I4). In open ground a tent leaves a cone's cost
  // as it was (to a few hundredths of a foot).
  const W = [1, 2, 1];
  const smooth = new Float32Array(out);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (!Number.isFinite(out[k] as number)) continue;
      let sum = 0;
      let wsum = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const v = out[rr * cols + cc] as number;
          if (!Number.isFinite(v)) continue;
          const wt = (W[dr + 1] as number) * (W[dc + 1] as number);
          sum += v * wt;
          wsum += wt;
        }
      smooth[k] = sum / wsum;
    }
  // Reach, blurred by a cell (a 3 × 3 tent): the edge interpolates smoothly instead of stepping cell by cell.
  const on = new Float32Array(cols * rows);
  for (let k = 0; k < out.length; k++) on[k] = Number.isFinite(out[k] as number) ? 1 : 0;
  const reach = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let s = 0;
      let w = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const wt = (W[dr + 1] as number) * (W[dc + 1] as number);
          s += (on[rr * cols + cc] as number) * wt;
          w += wt;
        }
      reach[r * cols + c] = s / w;
    }
  // Past the reachable ground (a wall's far side, off the scene), two rings of cells carry on the cost at its edge
  // (the mean of their reached neighbours): drawn from a texture, the cost never climbs to "unreachable" within a
  // cell of the edge — which traced a false limit along it, a spur where the true one meets a wall or the scene's
  // edge (critic P8 r2 I4).
  for (let ring = 0; ring < 2; ring++) {
    const next = new Float32Array(smooth);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c;
        if (Number.isFinite(smooth[k] as number)) continue;
        let sum = 0;
        let n = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            const v = smooth[rr * cols + cc] as number;
            if (!Number.isFinite(v)) continue;
            sum += v;
            n++;
          }
        if (n) next[k] = sum / n;
      }
    smooth.set(next);
  }
  return { cost: smooth, reach };
}
