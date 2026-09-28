/**
 * Fog rasters (SPEC §15.5, §15.8): one byte per cell over the scene bounds at `fog_cell_ft`, for painted reveal
 * layers, explored memory and the light raster. Patches travel as run-length encoded rectangles.
 */
import type { VisPoly } from "../geometry/index.ts";
import { visRing } from "../geometry/index.ts";
import type { Bounds } from "../schemas/entities.ts";
import { BRIGHT, DARK, type LightLevel, type VisionWorld } from "./world.ts";

/** Largest raster side in cells (a 4096-ft scene at 1 ft). */
export const RASTER_MAX_SIDE = 4096;

export interface CellRect {
  /** Column and row of the first cell, and the size in cells. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Raster {
  /** World position of cell (0, 0)'s corner. */
  readonly x0: number;
  readonly y0: number;
  /** Cell size (ft) and size in cells. */
  readonly cell: number;
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
  constructor(x0: number, y0: number, cell: number, w: number, h: number, data?: Uint8Array) {
    this.x0 = x0;
    this.y0 = y0;
    this.cell = cell;
    this.w = w;
    this.h = h;
    this.data = data ?? new Uint8Array(w * h);
  }

  /** A raster covering the bounds (cells of `cell` ft, the side capped at RASTER_MAX_SIDE cells). */
  static over(b: Bounds, cell: number): Raster {
    let c = cell > 0 ? cell : 1;
    const W = b.maxX - b.minX;
    const H = b.maxY - b.minY;
    while (Math.ceil(W / c) > RASTER_MAX_SIDE || Math.ceil(H / c) > RASTER_MAX_SIDE) c *= 2;
    return new Raster(b.minX, b.minY, c, Math.max(1, Math.ceil(W / c)), Math.max(1, Math.ceil(H / c)));
  }

  /** Same placement and size. */
  sameShape(o: Raster): boolean {
    return o.x0 === this.x0 && o.y0 === this.y0 && o.cell === this.cell && o.w === this.w && o.h === this.h;
  }

  /** The cell holding a world point, or −1 outside. */
  indexAt(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
  }

  at(x: number, y: number): number {
    const k = this.indexAt(x, y);
    return k < 0 ? 0 : (this.data[k] as number);
  }

  /** The cells whose centres lie in a world rectangle (clamped; w or h 0 when none). */
  cellsIn(x0: number, y0: number, x1: number, y1: number): CellRect {
    const i0 = Math.max(0, Math.ceil((x0 - this.x0) / this.cell - 0.5));
    const j0 = Math.max(0, Math.ceil((y0 - this.y0) / this.cell - 0.5));
    const i1 = Math.min(this.w - 1, Math.floor((x1 - this.x0) / this.cell - 0.5));
    const j1 = Math.min(this.h - 1, Math.floor((y1 - this.y0) / this.cell - 0.5));
    return { x: i0, y: j0, w: Math.max(0, i1 - i0 + 1), h: Math.max(0, j1 - j0 + 1) };
  }

  /** A copy of a rectangle's cells (row-major). */
  read(r: CellRect): Uint8Array {
    const out = new Uint8Array(r.w * r.h);
    for (let j = 0; j < r.h; j++)
      out.set(this.data.subarray((r.y + j) * this.w + r.x, (r.y + j) * this.w + r.x + r.w), j * r.w);
    return out;
  }

  write(r: CellRect, cells: Uint8Array): void {
    for (let j = 0; j < r.h; j++)
      this.data.set(cells.subarray(j * r.w, (j + 1) * r.w), (r.y + j) * this.w + r.x);
  }

  /** Whether any cell is set. */
  any(): boolean {
    for (let k = 0; k < this.data.length; k++) if (this.data[k]) return true;
    return false;
  }
}

/**
 * Calls fn for every cell whose centre lies inside the ring (even–odd scanline fill; a star-shaped visibility ring is
 * simple, so this is its inside), within `clip` if given. `ring` is [x0, y0, x1, y1, …], implicitly closed. fn
 * returning true stops the fill.
 */
export function fillRing(
  r: Raster,
  ring: ArrayLike<number>,
  fn: (k: number, cx: number, cy: number) => unknown,
  clip?: CellRect,
): void {
  const n = ring.length / 2;
  if (n < 3) return;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < n; k++) {
    const y = ring[k * 2 + 1] as number;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const j0 = Math.max(clip ? clip.y : 0, Math.ceil((minY - r.y0) / r.cell - 0.5));
  const j1 = Math.min(clip ? clip.y + clip.h - 1 : r.h - 1, Math.floor((maxY - r.y0) / r.cell - 0.5));
  if (j1 < j0) return;
  const ci0 = clip ? clip.x : 0;
  const ci1 = clip ? clip.x + clip.w - 1 : r.w - 1;
  // Crossings per row, laid out flat (counts, then offsets): no per-row arrays. The shared scratch is this call's
  // unless fn fills again inside it.
  const own = fillDepth++ > 0;
  try {
    fillRows(r, ring, n, j0, j1, ci0, ci1, own, fn);
  } finally {
    fillDepth--;
  }
}

function fillRows(
  r: Raster,
  ring: ArrayLike<number>,
  n: number,
  j0: number,
  j1: number,
  ci0: number,
  ci1: number,
  own: boolean,
  fn: (k: number, cx: number, cy: number) => unknown,
): void {
  const rows = j1 - j0 + 1;
  const span = own ? new Int32Array(2) : SPAN;
  const rowY = (j: number) => r.y0 + (j + 0.5) * r.cell;
  // Each edge's rows: those whose centre y is in [lo, hi) (half-open: a vertex is counted once).
  const edgeRows = (k: number): number => {
    const ay = ring[k * 2 + 1] as number;
    const by = ring[((k + 1) % n) * 2 + 1] as number;
    if (ay === by) return -1;
    const lo = Math.min(ay, by);
    const hi = Math.max(ay, by);
    let ja = Math.max(j0, Math.ceil((lo - r.y0) / r.cell - 0.5));
    if (ja <= j1 && rowY(ja) < lo) ja++;
    let jb = Math.min(j1, Math.ceil((hi - r.y0) / r.cell - 0.5) - 1);
    if (jb + 1 <= j1 && rowY(jb + 1) < hi) jb++;
    while (jb >= ja && rowY(jb) >= hi) jb--;
    span[0] = ja;
    span[1] = jb;
    return jb >= ja ? jb - ja + 1 : 0;
  };
  const start = own ? new Int32Array(rows + 1) : scratchInt(rows + 1);
  start.fill(0, 0, rows + 1);
  for (let k = 0; k < n; k++)
    if (edgeRows(k) > 0)
      for (let j = span[0] as number; j <= (span[1] as number); j++)
        start[j - j0 + 1] = (start[j - j0 + 1] as number) + 1;
  for (let q = 0; q < rows; q++) start[q + 1] = (start[q + 1] as number) + (start[q] as number);
  const total = start[rows] as number;
  const xs = own ? new Float64Array(total) : scratchX(total);
  const fillAt = own ? new Int32Array(rows) : scratchFill(rows);
  fillAt.set(start.subarray(0, rows));
  for (let k = 0; k < n; k++) {
    if (edgeRows(k) <= 0) continue;
    const ax = ring[k * 2] as number;
    const ay = ring[k * 2 + 1] as number;
    const bx = ring[((k + 1) % n) * 2] as number;
    const by = ring[((k + 1) % n) * 2 + 1] as number;
    for (let j = span[0] as number; j <= (span[1] as number); j++) {
      const cy = rowY(j);
      const at = fillAt[j - j0] as number;
      xs[at] = ax + ((cy - ay) * (bx - ax)) / (by - ay);
      fillAt[j - j0] = at + 1;
    }
  }
  for (let j = j0; j <= j1; j++) {
    const a0 = start[j - j0] as number;
    const a1 = start[j - j0 + 1] as number;
    // Insertion sort: a row crosses a handful of edges.
    for (let q = a0 + 1; q < a1; q++) {
      const v = xs[q] as number;
      let t = q - 1;
      while (t >= a0 && (xs[t] as number) > v) {
        xs[t + 1] = xs[t] as number;
        t--;
      }
      xs[t + 1] = v;
    }
    const cy = rowY(j);
    for (let q = a0; q + 1 < a1; q += 2) {
      const i0 = Math.max(ci0, Math.ceil(((xs[q] as number) - r.x0) / r.cell - 0.5));
      const i1 = Math.min(ci1, Math.floor(((xs[q + 1] as number) - r.x0) / r.cell - 0.5));
      for (let i = i0; i <= i1; i++) if (fn(j * r.w + i, r.x0 + (i + 0.5) * r.cell, cy) === true) return;
    }
  }
}

// Scratch buffers for the outermost fill.
let fillDepth = 0;
const SPAN = new Int32Array(2);
let startBuf = new Int32Array(256);
let fillBuf = new Int32Array(256);
let xBuf = new Float64Array(1024);
function scratchInt(n: number): Int32Array {
  if (startBuf.length < n) startBuf = new Int32Array(n * 2);
  return startBuf;
}
function scratchFill(n: number): Int32Array {
  if (fillBuf.length < n) fillBuf = new Int32Array(n * 2);
  return fillBuf;
}
function scratchX(n: number): Float64Array {
  if (xBuf.length < n) xBuf = new Float64Array(n * 2);
  return xBuf;
}

/** Fills a visibility polygon's cells. */
export function fillVis(
  r: Raster,
  v: VisPoly,
  fn: (k: number, cx: number, cy: number) => unknown,
  clip?: CellRect,
): void {
  fillRing(r, visRing(v), fn, clip);
}

/** Run lengths of a 0/1 cell array, starting with a run of zeros (possibly empty). */
export function rleEncode(cells: Uint8Array): number[] {
  const runs: number[] = [];
  let cur = 0;
  let len = 0;
  for (let k = 0; k < cells.length; k++) {
    const v = cells[k] ? 1 : 0;
    if (v === cur) len++;
    else {
      runs.push(len);
      cur = v;
      len = 1;
    }
  }
  runs.push(len);
  return runs;
}

export function rleDecode(runs: readonly number[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let k = 0;
  let v = 0;
  for (const n of runs) {
    if (v) out.fill(1, k, Math.min(size, k + n));
    k += n;
    v ^= 1;
  }
  return out;
}

/**
 * The light level at each cell centre (§15.5's light raster): rebuilt when lights or walls change, per area when one
 * light moves (a carried torch walks with its token every move).
 */
export class LightRaster {
  readonly raster: Raster;
  constructor(bounds: Bounds, cell: number) {
    this.raster = Raster.over(bounds, cell);
  }

  /** Every cell. */
  build(world: VisionWorld): void {
    this.refresh(
      world,
      this.raster.x0,
      this.raster.y0,
      this.raster.x0 + this.raster.w * this.raster.cell,
      this.raster.y0 + this.raster.h * this.raster.cell,
    );
  }

  /** The cells whose centres lie in a world rectangle. */
  refresh(world: VisionWorld, x0: number, y0: number, x1: number, y1: number): void {
    // The ambient (or darkness) everywhere, then each light's lit area by scanline — no polygon test per cell.
    const r = this.raster;
    const c = r.cellsIn(x0, y0, x1, y1);
    if (!c.w || !c.h) return;
    const dark = world.obscurers.some((o) => o.kind === "magicalDarkness");
    for (let j = c.y; j < c.y + c.h; j++) {
      const cy = r.y0 + (j + 0.5) * r.cell;
      for (let i = c.x; i < c.x + c.w; i++)
        r.data[j * r.w + i] =
          dark && world.inMagicalDarkness(r.x0 + (i + 0.5) * r.cell, cy) ? DARK : world.ambient;
    }
    if (world.ambient === BRIGHT && !dark) return;
    for (const l of world.lights) {
      const reach = l.bright + l.dim;
      if (l.x + reach < x0 || l.x - reach > x1 || l.y + reach < y0 || l.y - reach > y1) continue;
      fillVis(
        r,
        world.litOf(l),
        (k, cx, cy) => {
          const cur = r.data[k] as LightLevel;
          if (cur === BRIGHT) return;
          if (dark && !(l.magical && l.pierceDarkness) && world.inMagicalDarkness(cx, cy)) return;
          const lv = world.levelFrom(l, cx, cy);
          if (lv > cur) r.data[k] = lv;
        },
        c,
      );
    }
  }

  levelAt(x: number, y: number): LightLevel {
    const k = this.raster.indexAt(x, y);
    return k < 0 ? DARK : (this.raster.data[k] as LightLevel);
  }
}
