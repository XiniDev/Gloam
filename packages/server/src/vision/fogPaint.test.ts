import { Raster } from "@gloam/shared/vision";
import { describe, expect, it } from "vitest";
import { capsuleRow, fogCover } from "./fogPaint.ts";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance from p to segment ab. */
function segDist(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2)) : 0;
  return Math.hypot(a.x + t * dx - px, a.y + t * dy - py);
}

describe("fog painting (SPEC §8.8 DM fog tools)", () => {
  it("a brush stroke covers exactly the cells whose centres lie within its radius of the stroke, filled by rows", () => {
    const r = rng(3);
    const bounds = { minX: 0, minY: 0, maxX: 80, maxY: 60 };
    let bad = 0;
    let covered = 0;
    for (let trial = 0; trial < 60; trial++) {
      const raster = Raster.over(bounds, trial % 3 === 0 ? 1 : 2.5);
      const pts = Array.from({ length: 1 + Math.floor(r() * 6) }, () => ({
        x: r() * 90 - 5,
        y: r() * 70 - 5,
      }));
      const radius = 0.25 + r() * 12;
      const got = fogCover({ kind: "brush", points: pts, radius }, raster, () => []);
      for (let j = 0; j < raster.h; j++)
        for (let i = 0; i < raster.w; i++) {
          const cx = raster.x0 + (i + 0.5) * raster.cell;
          const cy = raster.y0 + (j + 0.5) * raster.cell;
          let d = Number.POSITIVE_INFINITY;
          for (let k = 0; k < pts.length; k++)
            d = Math.min(
              d,
              segDist(
                cx,
                cy,
                pts[k] as { x: number; y: number },
                (pts[k + 1] ?? pts[k]) as { x: number; y: number },
              ),
            );
          // Cells within a hair of the edge may go either way (floating point); everything else must match.
          if (Math.abs(d - radius) < 1e-9) continue;
          const want = d < radius;
          if (want) covered++;
          if ((got?.mask[j * raster.w + i] === 1) !== want) bad++;
        }
    }
    expect(covered).toBeGreaterThan(5000);
    expect(bad).toBe(0);
  });

  it("capsuleRow: the row's interval, or nothing when the row misses", () => {
    expect(capsuleRow({ x: 0, y: 0 }, { x: 10, y: 0 }, 2, 0)).toEqual([-2, 12]);
    expect(capsuleRow({ x: 0, y: 0 }, { x: 10, y: 0 }, 2, 3)).toBeNull();
    const [lo, hi] = capsuleRow({ x: 0, y: 0 }, { x: 0, y: 10 }, 2, 5) as [number, number];
    expect([lo, hi]).toEqual([-2, 2]);
  });

  it("a stroke that would cover the raster many times over is refused, not ground through (the server stays responsive)", () => {
    const raster = Raster.over({ minX: 0, minY: 0, maxX: 400, maxY: 400 }, 1);
    // 4000 points zig-zagging corner to corner with a 100-ft brush: thousands of full-raster sweeps.
    const pts = Array.from({ length: 4000 }, (_, i) => (i % 2 ? { x: 0, y: 0 } : { x: 400, y: 400 }));
    const t0 = performance.now();
    expect(() => fogCover({ kind: "brush", points: pts, radius: 100 }, raster, () => [])).toThrow(/too much/);
    expect(performance.now() - t0).toBeLessThan(3000);
    // An ordinary stroke is fine.
    const stroke = Array.from({ length: 200 }, (_, i) => ({ x: 10 + i, y: 50 + Math.sin(i / 10) * 20 }));
    expect(fogCover({ kind: "brush", points: stroke, radius: 6 }, raster, () => [])).not.toBeNull();
  });
});
