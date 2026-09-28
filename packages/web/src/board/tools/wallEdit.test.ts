import { describe, expect, it } from "vitest";
import {
  angleSnap,
  chainSegments,
  EndIndex,
  footOn,
  movedWalls,
  rectCorners,
  type Seg,
  segHitsRect,
  snapPoint,
  wallAt,
} from "./wallEdit.ts";

const segs: Seg[] = [
  { id: "w1", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
  { id: "w2", a: { x: 10, y: 0 }, b: { x: 10, y: 10 } },
  { id: "w3", a: { x: 10, y: 0 }, b: { x: 20, y: 5 } },
];

describe("Walls tool geometry (SPEC §8.7, AC-WAL-02)", () => {
  const ends = new EndIndex(segs);

  it("endpoints snap within 1 ft, and only within 1 ft", () => {
    expect(snapPoint({ x: 10.6, y: 0.7 }, { ends, segs })).toEqual({ p: { x: 10, y: 0 }, kind: "end" });
    // 1.1 ft from the end, and more than ½ ft from any wall line: stays put.
    const far = { x: 10.8, y: -0.8 };
    expect(snapPoint(far, { ends, segs })).toEqual({ p: far, kind: null });
    // The nearest end wins.
    expect(snapPoint({ x: 0.4, y: 0.2 }, { ends, segs }).p).toEqual({ x: 0, y: 0 });
  });

  it("a point near a wall's middle lands on the wall (a sealed T-junction); ends win over lines", () => {
    const s = snapPoint({ x: 5, y: 0.3 }, { ends, segs });
    expect(s.kind).toBe("wall");
    expect(s.p).toEqual({ x: 5, y: 0 });
    expect(snapPoint({ x: 9.5, y: 0.2 }, { ends, segs }).kind).toBe("end");
  });

  it("the chain's own points snap too (closing a loop on its first point)", () => {
    const s = snapPoint({ x: 30.5, y: 30.5 }, { ends, segs, extra: [{ x: 30, y: 30 }] });
    expect(s).toEqual({ p: { x: 30, y: 30 }, kind: "end" });
  });

  it("Shift snaps the angle to 15° from the previous point, keeping the distance along it", () => {
    const from = { x: 0, y: 0 };
    expect(angleSnap(from, { x: 10, y: 0.9 })).toEqual({ x: 10, y: 0 });
    const d = angleSnap(from, { x: 7, y: 7.4 }); // ≈ 46.6° → 45°
    expect(Math.atan2(d.y, d.x) * (180 / Math.PI)).toBeCloseTo(45, 6);
    const r = angleSnap(from, { x: 8.66, y: 5.1 }); // ≈ 30.5° → 30°
    expect(Math.atan2(r.y, r.x) * (180 / Math.PI)).toBeCloseTo(30, 6);
    // Shift overrides endpoint snapping.
    expect(snapPoint({ x: 10.2, y: 0.4 }, { ends, segs, from, angle: true })).toEqual({
      p: { x: 10.2, y: 0 },
      kind: "angle",
    });
  });

  it("Ctrl/Cmd turns snapping off", () => {
    const raw = { x: 10.2, y: 0.1 };
    expect(snapPoint(raw, { ends, segs, off: true, angle: true, from: { x: 0, y: 0 } })).toEqual({
      p: raw,
      kind: null,
    });
  });

  it("joints gather every end at a point; skipped walls don't snap", () => {
    expect(new Set(ends.joint({ x: 10, y: 0 }).map((e) => `${e.id}.${e.end}`))).toEqual(
      new Set(["w1.b", "w2.a", "w3.a"]),
    );
    const without = new EndIndex(segs, (id) => id !== "w2");
    expect(without.nearest({ x: 10.1, y: 9.8 }, 1)?.id).toBe("w2");
    expect(without.nearest({ x: 10, y: 0 }, 1)?.id).toBe("w2");
  });

  it("hit tests, box selection and chains", () => {
    expect(wallAt({ x: 5, y: 0.2 }, segs, 0.5)).toBe("w1");
    expect(wallAt({ x: 5, y: 0.7 }, segs, 0.5)).toBeNull();
    expect(footOn({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }).p).toEqual({ x: 5, y: 0 });
    // A box crossing w2's middle, holding none of its ends.
    expect(segHitsRect({ x: 10, y: 0 }, { x: 10, y: 10 }, { x0: 9, y0: 4, x1: 11, y1: 6 })).toBe(true);
    expect(segHitsRect({ x: 10, y: 0 }, { x: 10, y: 10 }, { x0: 11, y0: 4, x1: 12, y1: 6 })).toBe(false);
    expect(segHitsRect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x0: -1, y0: -1, x1: 2, y1: 2 })).toBe(true);
    // A double-click's repeated point makes no wall; a closed chain returns to its start.
    expect(
      chainSegments([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 0.01 },
      ]),
    ).toHaveLength(1);
    const room = chainSegments(rectCorners({ x: 0, y: 0 }, { x: 10, y: 8 }), true);
    expect(room).toHaveLength(4);
    expect(room[3]).toEqual({ a: { x: 0, y: 8 }, b: { x: 0, y: 0 } });
  });

  it("moving a joint moves every end at it", () => {
    const map = new Map(segs.map((s) => [s.id, s]));
    const to = { x: 12, y: 1 };
    const moved = movedWalls(map, ends.joint({ x: 10, y: 0 }), () => to);
    expect(moved.get("w1")).toEqual({ a: { x: 0, y: 0 }, b: to });
    expect(moved.get("w2")).toEqual({ a: to, b: { x: 10, y: 10 } });
    expect(moved.get("w3")?.a).toEqual(to);
    // Both ends of one wall (a move by offset).
    const both = movedWalls(
      map,
      [
        { id: "w1", end: "a" },
        { id: "w1", end: "b" },
      ],
      (p) => ({ x: p.x + 1, y: p.y + 2 }),
    );
    expect(both.get("w1")).toEqual({ a: { x: 1, y: 2 }, b: { x: 11, y: 2 } });
  });

  it("a thousand walls: a snap query and a hit test take well under a millisecond", () => {
    const many: Seg[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `m${i}`,
      a: { x: (i % 40) * 5, y: Math.floor(i / 40) * 5 },
      b: { x: (i % 40) * 5 + 5, y: Math.floor(i / 40) * 5 },
    }));
    const idx = new EndIndex(many);
    const t0 = performance.now();
    for (let k = 0; k < 200; k++) {
      const p = { x: (k * 7.3) % 200, y: (k * 3.1) % 125 };
      snapPoint(p, { ends: idx, segs: many });
      wallAt(p, many, 0.5);
    }
    expect((performance.now() - t0) / 200).toBeLessThan(1);
  });
});
