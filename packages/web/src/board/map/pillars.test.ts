import { ShapeUtils, Vector2 } from "three";
import { describe, expect, it } from "vitest";
import { findPillars, loopArea, offsetLoop, PILLAR_MAX_AREA, pillarLoops, pillarPrism } from "./pillars.ts";

type P = { x: number; y: number };
const ring = (pts: [number, number][]) =>
  pts.map(([x, y], i) => {
    const [nx, ny] = pts[(i + 1) % pts.length] as [number, number];
    return { a: { x, y }, b: { x: nx, y: ny } };
  });
const area = (poly: P[]) =>
  Math.abs(
    poly.reduce(
      (s, p, i) =>
        s + p.x * (poly[(i + 1) % poly.length] as P).y - (poly[(i + 1) % poly.length] as P).x * p.y,
      0,
    ),
  ) / 2;

describe("pillar loops", () => {
  it("fills a small closed loop of walls, corners in order", () => {
    const loops = pillarLoops(
      ring([
        [10, 10],
        [15, 10],
        [15, 15],
        [10, 15],
      ]),
    );
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
    expect(area(loops[0] as P[])).toBeCloseTo(25);
  });

  it("finds loops whatever the segments' order and direction, and a round column", () => {
    const square = ring([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]).map((s, i) => (i % 2 ? { a: s.b, b: s.a } : s));
    const octagon = ring(
      Array.from(
        { length: 8 },
        (_, i) =>
          [50 + 2 * Math.cos((i * Math.PI) / 4), 50 + 2 * Math.sin((i * Math.PI) / 4)] as [number, number],
      ),
    );
    const loops = pillarLoops([
      ...octagon.reverse(),
      square[2],
      square[0],
      square[3],
      square[1],
    ] as typeof square);
    expect(loops.map((l) => l.length).sort()).toEqual([4, 8]);
  });

  it("leaves rooms, open runs and junctions hollow", () => {
    const room = ring([
      [0, 0],
      [30, 0],
      [30, 20],
      [0, 20],
    ]);
    const open = ring([
      [100, 0],
      [103, 0],
      [103, 3],
      [100, 3],
    ]).slice(0, 3);
    // Two small rooms sharing a wall: its corners carry three walls, so neither is a lone pillar.
    const shared = [
      ...ring([
        [200, 0],
        [203, 0],
        [203, 3],
        [200, 3],
      ]),
      ...ring([
        [203, 0],
        [206, 0],
        [206, 3],
        [203, 3],
      ]).filter((s) => !(s.a.x === 203 && s.b.x === 203)),
    ];
    expect(pillarLoops([...room, ...open, ...shared])).toEqual([]);
    expect(PILLAR_MAX_AREA).toBeLessThan(30 * 20);
  });

  it("welds corners within a hundredth of a foot", () => {
    const loops = pillarLoops([
      { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } },
      { a: { x: 3.001, y: 0.002 }, b: { x: 3, y: 3 } },
      { a: { x: 3, y: 3 }, b: { x: 0, y: 3 } },
      { a: { x: 0, y: 3 }, b: { x: 0.003, y: -0.001 } },
    ]);
    expect(loops).toHaveLength(1);
  });
});

describe("pillar prism", () => {
  const tri = (c: P[]) =>
    ShapeUtils.triangulateShape(
      c.map((p) => new Vector2(p.x, p.y)),
      [],
    );
  const square: P[] = [
    { x: 10, y: 10 },
    { x: 12, y: 10 },
    { x: 12, y: 12 },
    { x: 10, y: 12 },
  ];

  it("names each pillar's walls", () => {
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 30, y: 0 } },
      ...ring(square.map((p) => [p.x, p.y] as [number, number])),
    ];
    const [p] = findPillars(segs);
    expect(p?.members.slice().sort()).toEqual([1, 2, 3, 4]);
  });

  it("grows the loop by half the walls' thickness, either winding", () => {
    for (const loop of [square, [...square].reverse()]) {
      const out = offsetLoop(loop, 0.375);
      expect(Math.abs(loopArea(out))).toBeCloseTo(2.75 * 2.75, 6);
      expect(Math.abs(loopArea(offsetLoop(out, -0.375)))).toBeCloseTo(4, 6);
    }
  });

  it("is closed and faces out: its top covers the grown outline exactly, every face wound toward its normal", () => {
    for (const loop of [square, [...square].reverse(), offsetLoop(square, 3).slice(0, 3)]) {
      const d = pillarPrism(loop, 0.75, 8, tri);
      const n = d.position.length / 9;
      let top = 0;
      let sides = 0;
      const outer = offsetLoop(loop, 0.375);
      const cx = outer.reduce((s, p) => s + p.x, 0) / outer.length;
      const cz = outer.reduce((s, p) => s + p.y, 0) / outer.length;
      for (let t = 0; t < n; t++) {
        const v = (k: number) => [0, 1, 2].map((c) => d.position[t * 9 + k * 3 + c] as number);
        const [a, b, c] = [v(0), v(1), v(2)] as number[][];
        const u = [0, 1, 2].map((i) => (b?.[i] as number) - (a?.[i] as number));
        const w = [0, 1, 2].map((i) => (c?.[i] as number) - (a?.[i] as number));
        const cross = [
          (u[1] as number) * (w[2] as number) - (u[2] as number) * (w[1] as number),
          (u[2] as number) * (w[0] as number) - (u[0] as number) * (w[2] as number),
          (u[0] as number) * (w[1] as number) - (u[1] as number) * (w[0] as number),
        ];
        const nrm = [0, 1, 2].map((i) => d.normal[t * 9 + i] as number);
        const facing = cross.reduce((s, x, i) => s + x * (nrm[i] as number), 0);
        expect(facing, `triangle ${t} wound toward its normal`).toBeGreaterThan(0);
        if ((nrm[1] as number) > 0.5) top += Math.hypot(...cross) / 2;
        else {
          sides++;
          // Outward: from the middle towards the face.
          const mx = ((a?.[0] as number) + (b?.[0] as number) + (c?.[0] as number)) / 3 - cx;
          const mz = ((a?.[2] as number) + (b?.[2] as number) + (c?.[2] as number)) / 3 - cz;
          expect(mx * (nrm[0] as number) + mz * (nrm[2] as number)).toBeGreaterThan(0);
        }
      }
      expect(top).toBeCloseTo(Math.abs(loopArea(outer)), 5);
      expect(sides).toBe(outer.length * 2);
    }
  });

  it("runs its courses on round the corners, and rims its top", () => {
    const d = pillarPrism(square, 0.75, 8, tri);
    expect(Math.max(...d.along)).toBeCloseTo(4 * 2.75, 5);
    expect(Math.max(...d.edge)).toBe(1);
    expect(Math.min(...d.edge)).toBe(0);
  });
});
