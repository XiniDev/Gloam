import { pointSegDist2 } from "../geometry/index.ts";
import type { MoveWorld } from "./world.ts";

/**
 * The search structures for one clearance radius in one world (SPEC §16.3), built on first use and kept for the
 * world's lifetime (a world is one scene version): the candidate corner nodes, a spatial index over them, the
 * cache of edge results between them, and a free-space connectivity grid.
 */

export const RING = 12;
/**
 * Ring radius factor: 12 points on a circle of radius R make a polygon whose edges come within R·cos(15°) of the
 * centre — so R is (clearance + 0.05) / cos(15°) for the chords between neighbouring points to keep clearance too
 * (with the spec's literal radius, rc + 0.05, no path could wrap around a corner; DECISIONS).
 */
export const RING_FACTOR = 1 / Math.cos(Math.PI / RING);

/** A node on a ring around an obstacle: taut paths only ever turn toward its centre there. */
export const WRAP = 0;
/** A node at a cost-region vertex: paths may bend either way there (entering or leaving difficult terrain). */
export const BEND = 1;

const NODE_CELL = 8;

export class Nav {
  readonly rc: number;
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Centre of the obstacle a WRAP node goes around. */
  readonly cx: Float64Array;
  readonly cy: Float64Array;
  readonly kind: Uint8Array;
  /** Edge results between nodes i < j (key i·n + j): the edge's cost without crawling, or −1 when blocked. */
  readonly edges = new Map<number, number>();
  /** Edge results from the last route's start (a drag previews from one start every frame). */
  lastStart: { x: number; y: number; edges: Map<number, number> } | null = null;
  readonly reach: ReachGrid;
  /** Each node's free-space component (a route through a node stays in its component). */
  readonly comp: Int32Array;
  private readonly gx0: number;
  private readonly gy0: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellStart: Int32Array;
  private readonly cellNodes: Int32Array;

  constructor(world: MoveWorld, rc: number) {
    this.rc = rc;
    const xs: number[] = [];
    const ys: number[] = [];
    const cxs: number[] = [];
    const cys: number[] = [];
    const kinds: number[] = [];
    const seen = new Set<string>();
    const ring = (cx: number, cy: number, r: number, kind: number) => {
      for (let k = 0; k < RING; k++) {
        const ang = (k / RING) * Math.PI * 2;
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        const key = `${Math.round(x * 100)},${Math.round(y * 100)}`;
        if (seen.has(key) || !pointClear(world, x, y, rc)) continue;
        seen.add(key);
        xs.push(x);
        ys.push(y);
        cxs.push(cx);
        cys.push(cy);
        kinds.push(kind);
      }
    };
    const ends = new Set<string>();
    for (let i = 0; i < world.walls.length; i++)
      for (const [ex, ey] of [
        [world.wx0[i] as number, world.wy0[i] as number],
        [world.wx1[i] as number, world.wy1[i] as number],
      ] as const) {
        const key = `${Math.round(ex * 100)},${Math.round(ey * 100)}`;
        if (ends.has(key)) continue;
        ends.add(key);
        ring(ex, ey, (rc + 0.05) * RING_FACTOR, WRAP);
      }
    for (const s of world.solids) ring(s.c.x, s.c.y, (s.r + rc + 0.05) * RING_FACTOR, WRAP);
    for (const r of world.regions) {
      if (r.poly) for (const v of r.poly) ring(v.x, v.y, 0.05, BEND);
      // Going around a creature's space (difficult terrain) rather than through it.
      if (r.circle) ring(r.circle.c.x, r.circle.c.y, (r.circle.r + 0.05) * RING_FACTOR, WRAP);
    }
    this.n = xs.length;
    this.x = Float64Array.from(xs);
    this.y = Float64Array.from(ys);
    this.cx = Float64Array.from(cxs);
    this.cy = Float64Array.from(cys);
    this.kind = Uint8Array.from(kinds);
    // Spatial index over the nodes (CSR), for picking the ones inside a search area.
    const b = world.bounds;
    this.gx0 = b.minX - NODE_CELL;
    this.gy0 = b.minY - NODE_CELL;
    this.cols = Math.max(1, Math.ceil((b.maxX - b.minX) / NODE_CELL) + 2);
    this.rows = Math.max(1, Math.ceil((b.maxY - b.minY) / NODE_CELL) + 2);
    const cellOf = (i: number) => this.cell(this.x[i] as number, this.y[i] as number);
    const counts = new Int32Array(this.cols * this.rows + 1);
    for (let i = 0; i < this.n; i++) counts[cellOf(i) + 1] = (counts[cellOf(i) + 1] as number) + 1;
    for (let c = 0; c < this.cols * this.rows; c++)
      counts[c + 1] = (counts[c + 1] as number) + (counts[c] as number);
    this.cellStart = counts;
    this.cellNodes = new Int32Array(this.n);
    const fill = counts.slice(0, this.cols * this.rows);
    for (let i = 0; i < this.n; i++) {
      const c = cellOf(i);
      this.cellNodes[fill[c] as number] = i;
      fill[c] = (fill[c] as number) + 1;
    }
    this.reach = new ReachGrid(world, rc);
    this.comp = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) this.comp[i] = this.reach.at(this.x[i] as number, this.y[i] as number);
  }

  private cell(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.gx0) / NODE_CELL)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.gy0) / NODE_CELL)));
    return r * this.cols + c;
  }

  /** Nodes in the box [x0, x1] × [y0, y1] (whole cells: callers filter exactly). */
  forNodesIn(x0: number, y0: number, x1: number, y1: number, fn: (i: number) => void): void {
    const c0 = Math.max(0, Math.floor((x0 - this.gx0) / NODE_CELL));
    const c1 = Math.min(this.cols - 1, Math.floor((x1 - this.gx0) / NODE_CELL));
    const r0 = Math.max(0, Math.floor((y0 - this.gy0) / NODE_CELL));
    const r1 = Math.min(this.rows - 1, Math.floor((y1 - this.gy0) / NODE_CELL));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.cols + c;
        for (let k = this.cellStart[cell] as number; k < (this.cellStart[cell + 1] as number); k++)
          fn(this.cellNodes[k] as number);
      }
  }
}

/** The search structures for clearance `rc` in this world (built once per world and radius). */
export function navFor(world: MoveWorld, rc: number): Nav {
  let nav = world.caches.get(rc) as Nav | undefined;
  if (!nav) {
    nav = new Nav(world, rc);
    world.caches.set(rc, nav);
  }
  return nav;
}

/** Does a centre at (x, y) keep clearance rc from every wall and solid, inside the bounds? */
export function pointClear(world: MoveWorld, x: number, y: number, rc: number): boolean {
  const b = world.bounds;
  if (x < b.minX - 1e-9 || x > b.maxX + 1e-9 || y < b.minY - 1e-9 || y > b.maxY + 1e-9) return false;
  const r2 = (rc - 1e-6) * (rc - 1e-6);
  const ok = world.forWallsNear(
    x,
    y,
    x,
    y,
    rc,
    (i) =>
      pointSegDist2(
        x,
        y,
        world.wx0[i] as number,
        world.wy0[i] as number,
        world.wx1[i] as number,
        world.wy1[i] as number,
      ) >= r2,
  );
  if (!ok) return false;
  for (const s of world.solids) {
    const R = rc + s.r - 1e-6;
    if ((x - s.c.x) ** 2 + (y - s.c.y) ** 2 < R * R) return false;
  }
  return true;
}

/**
 * Free-space connectivity for clearance rc on a grid (cell h ≤ rc / 2): a cell is open when some point in it could
 * keep clearance, and two neighbouring cells connect when some point on their shared edge could. Both tests are
 * necessary conditions, so every route the search could find runs through connected cells: different components
 * prove a goal unreachable at once, instead of by exhausting the search (the grid may still call some unreachable
 * pairs connected — then the search decides).
 */
export class ReachGrid {
  readonly h: number;
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  /** Component per cell (−1: no point in it keeps clearance). */
  readonly comp: Int32Array;

  constructor(world: MoveWorld, rc: number) {
    const b = world.bounds;
    const W = Math.max(1e-6, b.maxX - b.minX);
    const H = Math.max(1e-6, b.maxY - b.minY);
    // Fine enough that a thin wall separates its two sides (rc > h), capped at about two million cells.
    let h = Math.min(1, Math.max(0.25, rc / 2));
    h = Math.max(h, Math.sqrt((W * H) / 2e6));
    this.h = h;
    this.x0 = b.minX;
    this.y0 = b.minY;
    this.cols = Math.max(1, Math.ceil(W / h));
    this.rows = Math.max(1, Math.ceil(H / h));
    const N = this.cols * this.rows;
    const blocked = new Uint8Array(N);
    const eastShut = new Uint8Array(N);
    const southShut = new Uint8Array(N);
    const M = 0.02;
    const cellT = rc - h * Math.SQRT1_2 - M;
    const edgeT = rc - h / 2 - M;
    const mark = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      extra: number,
      dist2: (px: number, py: number) => number,
    ) => {
      const T = Math.max(cellT, edgeT) + extra;
      if (T <= 0) return;
      const c0 = Math.max(0, Math.floor((Math.min(x0, x1) - T - this.x0) / h) - 1);
      const c1 = Math.min(this.cols - 1, Math.floor((Math.max(x0, x1) + T - this.x0) / h) + 1);
      const r0 = Math.max(0, Math.floor((Math.min(y0, y1) - T - this.y0) / h) - 1);
      const r1 = Math.min(this.rows - 1, Math.floor((Math.max(y0, y1) + T - this.y0) / h) + 1);
      const ct = cellT + extra;
      const et = edgeT + extra;
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const k = r * this.cols + c;
          const px = this.x0 + (c + 0.5) * h;
          const py = this.y0 + (r + 0.5) * h;
          if (ct > 0 && dist2(px, py) < ct * ct) blocked[k] = 1;
          if (et > 0) {
            if (dist2(px + h / 2, py) < et * et) eastShut[k] = 1;
            if (dist2(px, py + h / 2) < et * et) southShut[k] = 1;
          }
        }
    };
    for (let i = 0; i < world.walls.length; i++) {
      const ax = world.wx0[i] as number;
      const ay = world.wy0[i] as number;
      const bx = world.wx1[i] as number;
      const by = world.wy1[i] as number;
      mark(ax, ay, bx, by, 0, (px, py) => pointSegDist2(px, py, ax, ay, bx, by));
    }
    for (const s of world.solids)
      mark(s.c.x, s.c.y, s.c.x, s.c.y, s.r, (px, py) => (px - s.c.x) ** 2 + (py - s.c.y) ** 2);
    // Label components (4-neighbour flood fill).
    const comp = new Int32Array(N).fill(-1);
    const queue = new Int32Array(N);
    let id = 0;
    for (let s = 0; s < N; s++) {
      if (blocked[s] || comp[s] !== -1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = s;
      comp[s] = id;
      while (head < tail) {
        const k = queue[head++] as number;
        const c = k % this.cols;
        const visit = (m: number) => {
          if (!blocked[m] && comp[m] === -1) {
            comp[m] = id;
            queue[tail++] = m;
          }
        };
        if (c + 1 < this.cols && !eastShut[k]) visit(k + 1);
        if (c > 0 && !eastShut[k - 1]) visit(k - 1);
        if (k + this.cols < N && !southShut[k]) visit(k + this.cols);
        if (k - this.cols >= 0 && !southShut[k - this.cols]) visit(k - this.cols);
      }
      id++;
    }
    this.comp = comp;
  }

  /** The component of the cell holding (x, y); −1 outside the bounds or where no clear point can be. */
  at(x: number, y: number): number {
    const c = Math.floor((x - this.x0) / this.h);
    const r = Math.floor((y - this.y0) / this.h);
    const cc = Math.min(this.cols - 1, Math.max(0, c));
    const rr = Math.min(this.rows - 1, Math.max(0, r));
    if (Math.abs(c - cc) > 1 || Math.abs(r - rr) > 1) return -1;
    return this.comp[rr * this.cols + cc] as number;
  }
}
