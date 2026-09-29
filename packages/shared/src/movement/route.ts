import { dist, lerp, type P, pointSegDist2, segSegDist2 } from "../geometry/index.ts";
import { BEND, type Nav, navFor, pointClearAt } from "./nav.ts";
import type { MoveWorld } from "./world.ts";

/** Options for one creature's move (§16.2–16.4). */
export interface MoveOptions {
  /** Clearance radius (squeeze × space): the path's centre line stays this far from walls. */
  rc: number;
  /** Crawling (prone, not standing up) or another +1 multiplier everywhere. */
  crawl?: boolean;
  /**
   * The remaining movement budget, when one applies: the search only considers nodes within budget + 10 ft of the
   * start (§16.3), which bounds it in combat however large the map.
   */
  budgetFt?: number;
}

export interface SegmentCost {
  from: P;
  to: P;
  cost: number;
  /** Feet of this segment inside difficult terrain. */
  difficultFt: number;
}

export interface RouteResult {
  points: P[];
  cost: number;
  difficultFt: number;
  segments: SegmentCost[];
}

/**
 * Cost of a straight segment (§16.4): its length split at every region boundary, each piece × its multiplier —
 * 1, +1 inside difficult terrain (never cumulative), +1 in water without a swimming speed (stacking with difficult
 * terrain), +1 when crawling.
 */
export function segmentCost(world: MoveWorld, a: P, b: P, opts: Partial<MoveOptions>): SegmentCost {
  const len = dist(a, b);
  const extra = opts.crawl ? 1 : 0;
  if (len < 1e-12) return { from: a, to: b, cost: 0, difficultFt: 0 };
  if (!world.regions.length) return { from: a, to: b, cost: len * (1 + extra), difficultFt: 0 };
  const ts = [0, ...world.regionCrossings(a, b), 1];
  let cost = 0;
  let difficultFt = 0;
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1] as number;
    const t1 = ts[i] as number;
    if (t1 - t0 < 1e-12) continue;
    const piece = len * (t1 - t0);
    const at = world.regionsAt(lerp(a, b, (t0 + t1) / 2));
    if (at.difficult) difficultFt += piece;
    // Halved Speed (Spirit Guardians) doubles what each foot costs there, whatever else it costs (§8.13).
    cost += piece * (1 + (at.difficult ? 1 : 0) + (at.swim ? 1 : 0) + extra) * (at.halved ? 2 : 1);
  }
  return { from: a, to: b, cost, difficultFt };
}

/**
 * A flight's cost (§16.4: "flying movement uses 3D segment length"): each segment's length with its climb or dive —
 * the ground's difficult terrain and water don't slow a creature above them.
 */
export function flightCost(points: P[], elevations: readonly number[]): number {
  let cost = 0;
  for (let i = 1; i < points.length; i++)
    cost += Math.hypot(
      dist(points[i - 1] as P, points[i] as P),
      (elevations[i] ?? 0) - (elevations[i - 1] ?? 0),
    );
  return cost;
}

/** Cost of a polyline. */
export function pathCost(world: MoveWorld, points: P[], opts: Partial<MoveOptions>): RouteResult {
  const segments: SegmentCost[] = [];
  let cost = 0;
  let difficultFt = 0;
  for (let i = 1; i < points.length; i++) {
    const s = segmentCost(world, points[i - 1] as P, points[i] as P, opts);
    segments.push(s);
    cost += s.cost;
    difficultFt += s.difficultFt;
  }
  return { points, cost, difficultFt, segments };
}

/** Does a centre at p keep clearance rc from every wall and solid, inside the bounds? */
export function pointClear(world: MoveWorld, p: P, rc: number): boolean {
  return pointClearAt(world, p.x, p.y, rc);
}

/**
 * Where a creature that already stands too close to something (placed against a wall, or overlapping a base) may
 * still go: it must not get any closer to what it's too close to. Per wall and solid index, the clearance its moves
 * must keep there instead of rc (its current distance). Empty maps when the start is clear.
 */
export interface Relax {
  walls: Map<number, number>;
  solids: Map<number, number>;
}
export function relaxFrom(world: MoveWorld, p: P, rc: number): Relax {
  const walls = new Map<number, number>();
  const solids = new Map<number, number>();
  world.forWallsNear(p.x, p.y, p.x, p.y, rc, (i) => {
    const d = Math.sqrt(
      pointSegDist2(
        p.x,
        p.y,
        world.wx0[i] as number,
        world.wy0[i] as number,
        world.wx1[i] as number,
        world.wy1[i] as number,
      ),
    );
    if (d < rc) walls.set(i, d);
    return true;
  });
  world.solids.forEach((s, i) => {
    const d = Math.hypot(p.x - s.c.x, p.y - s.c.y) - s.r;
    if (d < rc) solids.set(i, Math.max(0, d));
  });
  return { walls, solids };
}

/** Does the straight move a→b keep clearance rc all the way (or, from a cramped start, not get any closer)? */
export function segmentClear(world: MoveWorld, a: P, b: P, rc: number, relax?: Relax): boolean {
  return segClear(world, a.x, a.y, b.x, b.y, rc, relax);
}

function segClear(
  world: MoveWorld,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rc: number,
  relax?: Relax,
): boolean {
  const bd = world.bounds;
  if (ax < bd.minX - 1e-9 || ax > bd.maxX + 1e-9 || ay < bd.minY - 1e-9 || ay > bd.maxY + 1e-9) return false;
  if (bx < bd.minX - 1e-9 || bx > bd.maxX + 1e-9 || by < bd.minY - 1e-9 || by > bd.maxY + 1e-9) return false;
  const full = (rc - 1e-6) * (rc - 1e-6);
  const ok = world.forWallsNear(ax, ay, bx, by, rc, (i) => {
    const r = relax?.walls.get(i);
    const need = r === undefined ? full : Math.max(0, r - 1e-6) ** 2;
    return (
      segSegDist2(
        ax,
        ay,
        bx,
        by,
        world.wx0[i] as number,
        world.wy0[i] as number,
        world.wx1[i] as number,
        world.wy1[i] as number,
      ) >= need
    );
  });
  if (!ok) return false;
  for (let i = 0; i < world.solids.length; i++) {
    const s = world.solids[i] as { c: P; r: number };
    const r = relax?.solids.get(i);
    const R = (r === undefined ? rc : r) + s.r - 1e-6;
    if (pointSegDist2(s.c.x, s.c.y, ax, ay, bx, by) < R * R) return false;
  }
  return true;
}

/**
 * A* over the visibility graph (§16.3) between a and b through the given nav nodes; null when there's no way
 * through. Edges between nav nodes are cached on the nav (per world and radius), so repeated queries — a drag
 * preview asks every frame — reuse them. Paths are taut: at a node wrapping an obstacle the path only turns toward
 * the obstacle (turning away is never shorter), which prunes most candidate edges before any clearance test.
 */
function astar(
  world: MoveWorld,
  nav: Nav,
  a: P,
  b: P,
  opts: MoveOptions,
  nodes: number[],
  relax: Relax | undefined,
  ends: { a: Map<number, number>; b: Map<number, number> },
  limit: number,
): { path: P[] | null; capped: boolean } {
  const n = nodes.length + 2;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  X[0] = a.x;
  Y[0] = a.y;
  X[1] = b.x;
  Y[1] = b.y;
  nodes.forEach((id, k) => {
    X[k + 2] = nav.x[id] as number;
    Y[k + 2] = nav.y[id] as number;
  });
  const G = 1;
  const g = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const crawl = opts.crawl ? 1 : 0;
  const hasRegions = world.regions.length > 0;
  /**
   * Base cost (no crawl) of edge i–j, or −1 when blocked. Cached: between nodes on the nav (for the world's
   * lifetime), from a and b per node in `ends` (the caller keeps them across passes, and a drag's fixed start
   * across queries).
   */
  const baseCost = (i: number, j: number): number => {
    let key: number;
    let cache: Map<number, number>;
    const lo = i < j ? i : j;
    const hi = i < j ? j : i;
    if (lo >= 2) {
      const p = nodes[lo - 2] as number;
      const q = nodes[hi - 2] as number;
      key = p < q ? p * nav.n + q : q * nav.n + p;
      cache = nav.edges;
    } else if (hi >= 2) {
      key = nodes[hi - 2] as number;
      cache = lo === 0 ? ends.a : ends.b;
    } else {
      // The direct a–b edge belongs with this goal: `ends.a` outlives the query (a drag keeps its start's edges),
      // and a start→goal answer kept there was handed to the next goal — a clear line to the first spot of a drag
      // then ran straight through the wall behind it.
      key = -1;
      cache = ends.b;
    }
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const ax = X[i] as number;
    const ay = Y[i] as number;
    const bx = X[j] as number;
    const by = Y[j] as number;
    // Edges leaving the start may use its cramped-start allowance.
    const r = i === 0 || j === 0 ? relax : undefined;
    let c = -1;
    if (segClear(world, ax, ay, bx, by, opts.rc, r))
      c = hasRegions
        ? segmentCost(world, { x: ax, y: ay }, { x: bx, y: by }, {}).cost
        : Math.hypot(bx - ax, by - ay);
    cache.set(key, c);
    return c;
  };
  let capped = false;
  const taut = !hasRegions;
  const heap = new MinHeap();
  g[0] = 0;
  heap.push(Math.hypot(b.x - a.x, b.y - a.y), 0);
  while (heap.size) {
    const u = heap.pop();
    if (closed[u]) continue;
    if (u === G) break;
    closed[u] = 1;
    const ux = X[u] as number;
    const uy = Y[u] as number;
    const gu = g[u] as number;
    // Taut paths: at a node wrapping an obstacle, continue only toward the obstacle's side of the way in.
    let side = 0;
    let dx = 0;
    let dy = 0;
    const p = from[u] as number;
    // Not after a cramped start's first step (that step backs away from what's too close, not around it), and not
    // with cost regions: there a bend away from an obstacle can be cheapest (skirting difficult terrain).
    if (taut && u >= 2 && p >= 0 && !(p === 0 && relax) && nav.kind[nodes[u - 2] as number] !== BEND) {
      const id = nodes[u - 2] as number;
      dx = ux - (X[p] as number);
      dy = uy - (Y[p] as number);
      side = Math.sign(dx * ((nav.cy[id] as number) - uy) - dy * ((nav.cx[id] as number) - ux));
    }
    const best = g[G] as number;
    for (let v = 1; v < n; v++) {
      if (closed[v] || v === u) continue;
      const vx = X[v] as number;
      const vy = Y[v] as number;
      const len = Math.hypot(vx - ux, vy - uy);
      // Lower bounds first: an edge costs at least its length (every multiplier is ≥ 1).
      const lower = gu + len * (1 + crawl);
      if (lower >= (g[v] as number) - 1e-9) continue;
      const f = lower + Math.hypot(b.x - vx, b.y - vy);
      if (f >= best) continue;
      // Beyond this pass's cost limit: the caller widens if nothing cheaper turns up.
      if (f > limit) {
        capped = true;
        continue;
      }
      if (side !== 0 && side * (dx * (vy - uy) - dy * (vx - ux)) < -1e-9 * Math.hypot(dx, dy) * len) continue;
      const c = baseCost(u, v);
      if (c < 0) continue;
      const cand = gu + c + crawl * len;
      if (cand < (g[v] as number) - 1e-9) {
        g[v] = cand;
        from[v] = u;
        heap.push(cand + Math.hypot(b.x - vx, b.y - vy), v);
      }
    }
  }
  if (!Number.isFinite(g[G] as number)) return { path: null, capped };
  const path: P[] = [];
  for (let i = G; i !== -1; i = from[i] as number) path.push({ x: X[i] as number, y: Y[i] as number });
  return { path: path.reverse(), capped };
}

/** A binary min-heap of (key, value) pairs in typed arrays. */
class MinHeap {
  private keys = new Float64Array(64);
  private vals = new Int32Array(64);
  size = 0;
  push(k: number, v: number): void {
    if (this.size === this.keys.length) {
      const k2 = new Float64Array(this.size * 2);
      k2.set(this.keys);
      this.keys = k2;
      const v2 = new Int32Array(this.size * 2);
      v2.set(this.vals);
      this.vals = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.keys[p] as number) <= k) break;
      this.keys[i] = this.keys[p] as number;
      this.vals[i] = this.vals[p] as number;
      i = p;
    }
    this.keys[i] = k;
    this.vals[i] = v;
  }
  pop(): number {
    const top = this.vals[0] as number;
    this.size--;
    const k = this.keys[this.size] as number;
    const v = this.vals[this.size] as number;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const m = r < this.size && (this.keys[r] as number) < (this.keys[l] as number) ? r : l;
      if ((this.keys[m] as number) >= k) break;
      this.keys[i] = this.keys[m] as number;
      this.vals[i] = this.vals[m] as number;
      i = m;
    }
    this.keys[i] = k;
    this.vals[i] = v;
    return top;
  }
}

/**
 * The cheapest route start → waypoints → goal (§16.3) around walls and solids, through cost regions; null when a
 * stop can't be reached. The search starts within an ellipse around the straight line and widens only if needed.
 * A start already too close to something (a token dropped against a wall) may move as long as it doesn't get any
 * closer to it (relaxFrom); every stop must be clear.
 */
export function route(
  world: MoveWorld,
  start: P,
  goal: P,
  waypoints: P[],
  opts: MoveOptions,
): RouteResult | null {
  const stops = [start, ...waypoints, goal];
  for (const p of stops.slice(1)) if (!pointClear(world, p, opts.rc)) return null;
  const nav = navFor(world, opts.rc);
  const cramped = !pointClear(world, start, opts.rc);
  const relax = cramped ? relaxFrom(world, start, opts.rc) : undefined;
  // Unreachable stops are proved so by the connectivity grid at once, not by exhausting the search.
  const home = nav.reach.at(cramped ? (stops[1] as P).x : start.x, cramped ? (stops[1] as P).y : start.y);
  for (const p of stops.slice(cramped ? 2 : 1)) if (nav.reach.at(p.x, p.y) !== home) return null;
  const reach = opts.budgetFt === undefined ? Number.POSITIVE_INFINITY : opts.budgetFt + 10;
  const points: P[] = [start];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1] as P;
    const b = stops[i] as P;
    const legRelax = i === 1 ? relax : undefined;
    let leg: P[] | null = null;
    if (!world.regions.length && segmentClear(world, a, b, opts.rc, legRelax)) leg = [a, b];
    else {
      // Every route that leaves the ellipse {dist(a,p) + dist(p,b) ≤ limit} is longer than `limit`, and costs at
      // least its length: a route found inside with cost ≤ limit is optimal; otherwise widen (keeping the best).
      const d = dist(a, b);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // Only nodes in the goal's free-space component can lead there (b is clear, so it has one).
      const zone = nav.reach.at(b.x, b.y);
      // Edges from this leg's ends, kept across passes; a drag previews from one start many times (nav.lastStart).
      const fromA =
        i === 1 && nav.lastStart && nav.lastStart.x === a.x && nav.lastStart.y === a.y
          ? nav.lastStart.edges
          : new Map<number, number>();
      if (i === 1) nav.lastStart = { x: a.x, y: a.y, edges: fromA };
      const ends = { a: fromA, b: new Map<number, number>() };
      // Each pass searches for routes costing at most `limit`, through the nodes of the ellipse
      // {dist(a,p) + dist(p,b) ≤ limit} (every route of that cost stays inside it). The first found is optimal;
      // none: widen. Once the ellipse holds the whole scene and nothing was cut by the limit, there's no route.
      let far = 0;
      const bb = world.bounds;
      for (const [cx, cy] of [
        [bb.minX, bb.minY],
        [bb.maxX, bb.minY],
        [bb.minX, bb.maxY],
        [bb.maxX, bb.maxY],
      ] as const)
        far = Math.max(far, Math.hypot(cx - a.x, cy - a.y) + Math.hypot(cx - b.x, cy - b.y));
      for (let slack = Math.max(20, d * 0.5); ; slack *= 2.5) {
        const limit = d + slack;
        const nodes: number[] = [];
        // Every point of the ellipse lies within limit / 2 of the midpoint.
        nav.forNodesIn(mx - limit / 2, my - limit / 2, mx + limit / 2, my + limit / 2, (id) => {
          if (nav.comp[id] !== zone) return;
          const px = nav.x[id] as number;
          const py = nav.y[id] as number;
          if (Math.hypot(px - a.x, py - a.y) + Math.hypot(px - b.x, py - b.y) > limit) return;
          if (Math.hypot(px - start.x, py - start.y) > reach) return;
          nodes.push(id);
        });
        const found = astar(world, nav, a, b, opts, nodes, legRelax, ends, limit);
        if (found.path) {
          leg = found.path;
          break;
        }
        if (!found.capped && limit >= far) break;
      }
    }
    if (!leg) return null;
    points.push(...leg.slice(1));
  }
  return pathCost(world, points, opts);
}
