import type { FogShapeIn } from "@gloam/shared/protocol";
import { type CellRect, fillRing, type Raster, VisionGeometry, type VisionWall } from "@gloam/shared/vision";
import type { z } from "zod";

type FogShape = z.infer<typeof FogShapeIn>;

/**
 * The cells a fog shape covers (by cell centre) on a scene's fog raster (SPEC §8.8 DM fog tools): a mask over the
 * whole raster and the rectangle holding them, or null when it covers nothing.
 */
export function fogCover(
  shape: FogShape,
  r: Raster,
  walls: () => VisionWall[],
): { mask: Uint8Array; rect: CellRect } | null {
  const mask = new Uint8Array(r.w * r.h);
  switch (shape.kind) {
    case "all":
      mask.fill(1);
      break;
    case "rect": {
      const c = r.cellsIn(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h);
      for (let j = c.y; j < c.y + c.h; j++) mask.fill(1, j * r.w + c.x, j * r.w + c.x + c.w);
      break;
    }
    case "polygon":
      fillRing(
        r,
        shape.points.flatMap((p) => [p.x, p.y]),
        (k) => {
          mask[k] = 1;
        },
      );
      break;
    case "brush": {
      // Circles at the points and the capsules between them.
      const R2 = shape.radius * shape.radius;
      const pts = shape.points;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i] as { x: number; y: number };
        const b = (pts[i + 1] ?? a) as { x: number; y: number };
        const c = r.cellsIn(
          Math.min(a.x, b.x) - shape.radius,
          Math.min(a.y, b.y) - shape.radius,
          Math.max(a.x, b.x) + shape.radius,
          Math.max(a.y, b.y) + shape.radius,
        );
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L2 = dx * dx + dy * dy;
        for (let j = c.y; j < c.y + c.h; j++) {
          const cy = r.y0 + (j + 0.5) * r.cell;
          for (let q = c.x; q < c.x + c.w; q++) {
            const cx = r.x0 + (q + 0.5) * r.cell;
            const t = L2 > 0 ? Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / L2)) : 0;
            if ((a.x + t * dx - cx) ** 2 + (a.y + t * dy - cy) ** 2 <= R2) mask[j * r.w + q] = 1;
          }
        }
      }
      break;
    }
    case "room":
      if (!revealRoom(r, shape.x, shape.y, walls(), mask)) return null;
      break;
  }
  let i0 = r.w;
  let j0 = r.h;
  let i1 = -1;
  let j1 = -1;
  for (let j = 0; j < r.h; j++)
    for (let i = 0; i < r.w; i++)
      if (mask[j * r.w + i]) {
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
      }
  if (i1 < 0) return null;
  return { mask, rect: { x: i0, y: j0, w: i1 - i0 + 1, h: j1 - j0 + 1 } };
}

/**
 * Reveal room: a flood fill over the fog raster from the cell under (x, y), stepping to the four neighbours unless a
 * sight-blocking wall runs between the two cell centres. Bounded by the scene (its edge counts as a wall).
 */
function revealRoom(r: Raster, x: number, y: number, walls: VisionWall[], mask: Uint8Array): boolean {
  const start = r.indexAt(x, y);
  if (start < 0) return false;
  const sight = new VisionGeometry(walls).sight;
  const blocked = (ax: number, ay: number, bx: number, by: number): boolean => {
    let hit = false;
    sight.forNear((ax + bx) / 2, (ay + by) / 2, r.cell, (i) => {
      if (hit) return;
      if (
        crosses(
          ax,
          ay,
          bx,
          by,
          sight.ax[i] as number,
          sight.ay[i] as number,
          sight.bx[i] as number,
          sight.by[i] as number,
        )
      )
        hit = true;
    });
    return hit;
  };
  const queue = [start];
  mask[start] = 1;
  while (queue.length) {
    const k = queue.pop() as number;
    const i = k % r.w;
    const j = (k - i) / r.w;
    const cx = r.x0 + (i + 0.5) * r.cell;
    const cy = r.y0 + (j + 0.5) * r.cell;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= r.w || nj >= r.h) continue;
      const n = nj * r.w + ni;
      if (mask[n]) continue;
      if (blocked(cx, cy, cx + di * r.cell, cy + dj * r.cell)) continue;
      mask[n] = 1;
      queue.push(n);
    }
  }
  return true;
}

/** Closed segments pq and ab meet. */
function crosses(
  px: number,
  py: number,
  qx: number,
  qy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const o = (ux: number, uy: number, vx: number, vy: number, wx: number, wy: number) =>
    (vx - ux) * (wy - uy) - (vy - uy) * (wx - ux);
  const d1 = o(ax, ay, bx, by, px, py);
  const d2 = o(ax, ay, bx, by, qx, qy);
  const d3 = o(px, py, qx, qy, ax, ay);
  const d4 = o(px, py, qx, qy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (ux: number, uy: number, vx: number, vy: number, wx: number, wy: number) =>
    Math.min(ux, vx) <= wx && wx <= Math.max(ux, vx) && Math.min(uy, vy) <= wy && wy <= Math.max(uy, vy);
  return (
    (d1 === 0 && on(ax, ay, bx, by, px, py)) ||
    (d2 === 0 && on(ax, ay, bx, by, qx, qy)) ||
    (d3 === 0 && on(px, py, qx, qy, ax, ay)) ||
    (d4 === 0 && on(px, py, qx, qy, bx, by))
  );
}
