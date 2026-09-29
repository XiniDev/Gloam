import { describe, expect, it } from "vitest";
import { clipOutlineToRect, clipPolygonToRect, inPolygon, type P } from "./index.ts";

const r = { minX: 0, minY: 0, maxX: 60, maxY: 40 };
const square = (x: number, y: number, s: number): P[] => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];
const area = (poly: P[]) =>
  Math.abs(
    poly.reduce(
      (a, p, i) =>
        a + p.x * (poly[(i + 1) % poly.length] as P).y - (poly[(i + 1) % poly.length] as P).x * p.y,
      0,
    ),
  ) / 2;

describe("an effect's footprint cut to the scene (critic P9 r2 #6)", () => {
  it("keeps a polygon inside whole, cuts one across an edge to the part on the map, and drops one outside", () => {
    expect(clipPolygonToRect(square(10, 10, 10), r)).toHaveLength(4);
    const cut = clipPolygonToRect(square(50, 30, 20), r);
    expect(area(cut)).toBeCloseTo(100, 6);
    for (const p of cut) expect(p.x <= 60 + 1e-9 && p.y <= 40 + 1e-9).toBe(true);
    expect(clipPolygonToRect(square(70, 50, 5), r)).toEqual([]);
    // A circle-ish polygon over a corner: every point kept is inside, and inside points of the original stay inside.
    const circle = Array.from({ length: 72 }, (_, i) => ({
      x: 58 + 10 * Math.cos((i / 72) * 2 * Math.PI),
      y: 2 + 10 * Math.sin((i / 72) * 2 * Math.PI),
    }));
    const c = clipPolygonToRect(circle, r);
    expect(inPolygon({ x: 55, y: 5 }, c)).toBe(true);
    expect(c.every((p) => p.x >= -1e-9 && p.x <= 60 + 1e-9 && p.y >= -1e-9 && p.y <= 40 + 1e-9)).toBe(true);
  });

  it("draws an outline only where it is on the map", () => {
    // A square half off the right edge: its left side whole, top and bottom cut at x = 60, the right side gone.
    const segs = clipOutlineToRect(square(50, 10, 20), r);
    const len = segs.reduce((a, s) => a + Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), 0);
    expect(len).toBeCloseTo(10 + 10 + 20, 6);
    expect(segs.every((s) => s.a.x <= 60 + 1e-9 && s.b.x <= 60 + 1e-9)).toBe(true);
    expect(clipOutlineToRect(square(70, 50, 5), r)).toEqual([]);
    expect(clipOutlineToRect(square(10, 10, 5), r)).toHaveLength(4);
  });
});
