import { circleCrossings, inPolygon, type P, polygonCrossings } from "../geometry/index.ts";

/**
 * What a move is planned against (SPEC §16.1): movement-blocking segments (walls, closed doors, windows, invisible
 * walls, impassable-zone edges), solid creature bases, cost regions and the scene bounds. The client builds one
 * from the walls it knows; the server from all of them. A world is immutable: build a new one per scene version,
 * so the caches below (search nodes, edge results, connectivity — §16.3 "cache edge results per scene version")
 * stay valid for its lifetime.
 */
export interface Region {
  /** Difficult terrain (×2, never cumulative), or a passable non-ally's space (also ×2). */
  poly?: P[];
  circle?: { c: P; r: number };
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface MoveWorldInput {
  walls: { a: P; b: P; id?: string }[];
  solids?: { c: P; r: number; id?: string }[];
  regions?: Region[];
  bounds: Bounds;
}

/** Wall grid cell size (ft). */
const CELL = 8;
/** Walls may lie a little outside the bounds and still matter to clearance near the edge. */
const MARGIN = 2 * CELL;

export class MoveWorld {
  readonly walls: { a: P; b: P; id?: string }[];
  readonly solids: { c: P; r: number; id?: string }[];
  readonly regions: Region[];
  readonly bounds: Bounds;
  /** Wall endpoints as flat arrays (hot loops avoid object access). */
  readonly wx0: Float64Array;
  readonly wy0: Float64Array;
  readonly wx1: Float64Array;
  readonly wy1: Float64Array;
  /** Per-rc search structures (nav.ts), built on first use. */
  readonly caches = new Map<number, unknown>();
  private readonly gx0: number;
  private readonly gy0: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Wall indices per cell (CSR layout: cellStart[c]..cellStart[c + 1] into cellWalls). */
  private readonly cellStart: Int32Array;
  private readonly cellWalls: Int32Array;
  /** Visit stamps, so a query reports each wall once without allocating a set. */
  private readonly stamp: Uint32Array;
  private tick = 0;

  constructor(input: MoveWorldInput) {
    this.walls = input.walls;
    this.solids = input.solids ?? [];
    this.regions = input.regions ?? [];
    this.bounds = input.bounds;
    const n = this.walls.length;
    this.wx0 = new Float64Array(n);
    this.wy0 = new Float64Array(n);
    this.wx1 = new Float64Array(n);
    this.wy1 = new Float64Array(n);
    this.walls.forEach((w, i) => {
      this.wx0[i] = w.a.x;
      this.wy0[i] = w.a.y;
      this.wx1[i] = w.b.x;
      this.wy1[i] = w.b.y;
    });
    const b = this.bounds;
    this.gx0 = b.minX - MARGIN;
    this.gy0 = b.minY - MARGIN;
    this.cols = Math.max(1, Math.ceil((b.maxX - b.minX + 2 * MARGIN) / CELL));
    this.rows = Math.max(1, Math.ceil((b.maxY - b.minY + 2 * MARGIN) / CELL));
    const counts = new Int32Array(this.cols * this.rows + 1);
    const each = (i: number, fn: (c: number) => void) => {
      const [c0, c1] = this.colRange(
        Math.min(this.wx0[i] as number, this.wx1[i] as number),
        Math.max(this.wx0[i] as number, this.wx1[i] as number),
      );
      const [r0, r1] = this.rowRange(
        Math.min(this.wy0[i] as number, this.wy1[i] as number),
        Math.max(this.wy0[i] as number, this.wy1[i] as number),
      );
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * this.cols + c);
    };
    for (let i = 0; i < n; i++)
      each(i, (c) => {
        counts[c + 1] = (counts[c + 1] as number) + 1;
      });
    for (let c = 0; c < this.cols * this.rows; c++)
      counts[c + 1] = (counts[c + 1] as number) + (counts[c] as number);
    this.cellStart = counts;
    this.cellWalls = new Int32Array(counts[this.cols * this.rows] as number);
    const fill = counts.slice(0, this.cols * this.rows);
    for (let i = 0; i < n; i++)
      each(i, (c) => {
        this.cellWalls[fill[c] as number] = i;
        fill[c] = (fill[c] as number) + 1;
      });
    this.stamp = new Uint32Array(n);
  }

  private colRange(x0: number, x1: number): [number, number] {
    const clamp = (v: number) => Math.min(this.cols - 1, Math.max(0, v));
    return [clamp(Math.floor((x0 - this.gx0) / CELL)), clamp(Math.floor((x1 - this.gx0) / CELL))];
  }
  private rowRange(y0: number, y1: number): [number, number] {
    const clamp = (v: number) => Math.min(this.rows - 1, Math.max(0, v));
    return [clamp(Math.floor((y0 - this.gy0) / CELL)), clamp(Math.floor((y1 - this.gy0) / CELL))];
  }

  /**
   * Calls `fn` once for every wall whose cells lie within `pad` of the segment a→b (a capsule, walked column by
   * column so a long diagonal doesn't scan its whole bounding box). Stops early when `fn` returns false; returns
   * whether it ran to the end.
   */
  forWallsNear(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    pad: number,
    fn: (i: number) => boolean,
  ): boolean {
    if (this.tick === 0xffffffff) {
      this.stamp.fill(0);
      this.tick = 0;
    }
    const t = ++this.tick;
    const [c0, c1] = this.colRange(Math.min(ax, bx) - pad, Math.max(ax, bx) + pad);
    const dx = bx - ax;
    for (let c = c0; c <= c1; c++) {
      // The segment's y range over this column's x span (grown by pad), then grown by pad.
      let ylo: number;
      let yhi: number;
      if (Math.abs(dx) < 1e-9) {
        ylo = Math.min(ay, by);
        yhi = Math.max(ay, by);
      } else {
        const xa = Math.max(Math.min(ax, bx), this.gx0 + c * CELL - pad);
        const xb = Math.min(Math.max(ax, bx), this.gx0 + (c + 1) * CELL + pad);
        const ya = ay + ((xa - ax) / dx) * (by - ay);
        const yb = ay + ((xb - ax) / dx) * (by - ay);
        ylo = Math.min(ya, yb);
        yhi = Math.max(ya, yb);
      }
      const [r0, r1] = this.rowRange(ylo - pad, yhi + pad);
      for (let r = r0; r <= r1; r++) {
        const cell = r * this.cols + c;
        for (let k = this.cellStart[cell] as number; k < (this.cellStart[cell + 1] as number); k++) {
          const i = this.cellWalls[k] as number;
          if (this.stamp[i] === t) continue;
          this.stamp[i] = t;
          if (!fn(i)) return false;
        }
      }
    }
    return true;
  }

  /** Indices of walls within `pad` of the segment a..b's cells (see forWallsNear). */
  wallsNear(a: P, b: P, pad: number): number[] {
    const out: number[] = [];
    this.forWallsNear(a.x, a.y, b.x, b.y, pad, (i) => {
      out.push(i);
      return true;
    });
    return out;
  }

  inBounds(p: P): boolean {
    const b = this.bounds;
    return p.x >= b.minX - 1e-9 && p.x <= b.maxX + 1e-9 && p.y >= b.minY - 1e-9 && p.y <= b.maxY + 1e-9;
  }

  /** Is p inside any cost region? */
  inRegion(p: P): boolean {
    for (const r of this.regions) {
      if (r.poly && inPolygon(p, r.poly)) return true;
      if (r.circle && Math.hypot(p.x - r.circle.c.x, p.y - r.circle.c.y) < r.circle.r) return true;
    }
    return false;
  }

  /** Every t ∈ (0, 1) where pq crosses a region boundary, sorted. */
  regionCrossings(p: P, q: P): number[] {
    const ts: number[] = [];
    for (const r of this.regions) {
      if (r.poly) ts.push(...polygonCrossings(p, q, r.poly));
      if (r.circle) ts.push(...circleCrossings(p, q, r.circle.c, r.circle.r));
    }
    return ts.sort((a, b) => a - b);
  }
}
