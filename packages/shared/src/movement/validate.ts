import { FT_EPSILON } from "../constants.ts";
import {
  dist,
  lerp,
  type P,
  pointAtLength,
  segSegDist2,
  sweepCircleCircle,
  sweepCircleSeg,
} from "../geometry/index.ts";
import { type MoveOptions, pathCost, type RouteResult, relaxFrom, segmentCost } from "./route.ts";
import type { MoveWorld } from "./world.ts";

export interface Validated extends RouteResult {
  /** The move was cut short at an obstacle (players get "You bump into something unseen" for a hidden wall). */
  bumped: boolean;
  /** Index into world.walls of the wall it hit, if a wall. */
  hitWall: number | null;
  /** The move was cut to the budget (house rule: clamp). */
  clamped: boolean;
}

/** Server grazing tolerance: a client path that keeps rc exactly must not be truncated by float noise. */
const GRAZE = 0.01;

/**
 * Walks a proposed path against the true obstacles (§16.5 step 4): at the first contact the path is truncated where
 * the creature's clearance circle touches the obstacle. A creature that starts too close to something (relaxFrom)
 * only bumps into it by getting closer still.
 */
export function truncateAtCollision(
  world: MoveWorld,
  points: P[],
  opts: MoveOptions,
): { points: P[]; bumped: boolean; hitWall: number | null } {
  const r = Math.max(0, opts.rc - GRAZE);
  const start = points[0] as P;
  const relax = relaxFrom(world, start, opts.rc);
  const out: P[] = [start];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as P;
    const b = points[i] as P;
    let first = Number.POSITIVE_INFINITY;
    let hitWall: number | null = null;
    world.forWallsNear(a.x, a.y, b.x, b.y, r, (w) => {
      const near = relax.walls.get(w);
      const rw = near === undefined ? r : Math.max(0, near - GRAZE);
      const ax = world.wx0[w] as number;
      const ay = world.wy0[w] as number;
      const bx = world.wx1[w] as number;
      const by = world.wy1[w] as number;
      // Most nearby walls are never touched: skip the sweep unless the segments come within reach.
      if (segSegDist2(a.x, a.y, b.x, b.y, ax, ay, bx, by) > rw * rw) return true;
      const t = sweepCircleSeg(a, b, rw, { x: ax, y: ay }, { x: bx, y: by });
      if (t !== null && t < first) {
        first = t;
        hitWall = w;
      }
      return true;
    });
    for (const [k, s] of world.solids.entries()) {
      const near = relax.solids.get(k);
      const t = sweepCircleCircle(a, b, near === undefined ? r : Math.max(0, near - GRAZE), s.c, s.r);
      if (t !== null && t < first) {
        first = t;
        hitWall = null;
      }
    }
    // The scene bounds.
    const bb = world.bounds;
    for (const [lo, hi, pa, pb] of [
      [bb.minX, bb.maxX, a.x, b.x],
      [bb.minY, bb.maxY, a.y, b.y],
    ] as const) {
      if (pb < lo) first = Math.min(first, (lo - pa) / (pb - pa));
      if (pb > hi) first = Math.min(first, (hi - pa) / (pb - pa));
    }
    if (first <= 1) {
      const stop = lerp(a, b, Math.max(0, first));
      if (dist(stop, a) > 1e-9) out.push(stop);
      return { points: out, bumped: true, hitWall };
    }
    out.push(b);
  }
  return { points: out, bumped: false, hitWall: null };
}

/** Cuts a path at the arc length where its cumulative cost reaches `budget` (§16.5 step 5, clamp). */
export function clampToBudget(
  world: MoveWorld,
  points: P[],
  opts: Partial<MoveOptions>,
  budget: number,
): P[] {
  const out: P[] = [points[0] as P];
  let spent = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as P;
    const b = points[i] as P;
    const c = segmentCost(world, a, b, opts).cost;
    if (spent + c <= budget + FT_EPSILON) {
      out.push(b);
      spent += c;
      continue;
    }
    // Bisect along this segment for the point where the cost reaches the remaining budget.
    const left = budget - spent;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (segmentCost(world, a, lerp(a, b, mid), opts).cost <= left) lo = mid;
      else hi = mid;
    }
    const stop = lerp(a, b, lo);
    if (dist(stop, a) > 1e-9) out.push(stop);
    break;
  }
  return out;
}

/**
 * The authoritative move (§16.5 steps 4–5): truncate at the first true collision, cost it, and apply the budget —
 * clamp to the max-reach point, or report over budget for `reject`.
 */
export function validateMove(
  world: MoveWorld,
  points: P[],
  opts: MoveOptions,
  budget: number | null,
  overlong: "clamp" | "reject" = "clamp",
): Validated | { error: "OVER_BUDGET"; cost: number } {
  const cut = truncateAtCollision(world, points, opts);
  let pts = cut.points;
  let result = pathCost(world, pts, opts);
  let clamped = false;
  if (budget !== null && result.cost > budget + FT_EPSILON) {
    if (overlong === "reject") return { error: "OVER_BUDGET", cost: result.cost };
    pts = clampToBudget(world, pts, opts, budget);
    result = pathCost(world, pts, opts);
    clamped = true;
  }
  return { ...result, bumped: cut.bumped, hitWall: cut.hitWall, clamped };
}

/** The max-reach point of a previewed path for a budget (the hollow marker on the path line, AC-MOV-01). */
export function maxReachPoint(
  world: MoveWorld,
  points: P[],
  opts: Partial<MoveOptions>,
  budget: number,
): P | null {
  const all = pathCost(world, points, opts);
  if (all.cost <= budget + FT_EPSILON) return null;
  const cut = clampToBudget(world, points, opts, budget);
  return cut[cut.length - 1] ?? null;
}

export { pointAtLength };
