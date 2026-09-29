import { describe, expect, it } from "vitest";
import { segSegDist2 } from "../geometry/index.ts";
import { clearanceRadius } from "./blocking.ts";
import { buildMoveWorld } from "./build.ts";
import { pathCost, route } from "./route.ts";

const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const medium = { rc: 2 };
const across = (a: number) => ({ a: { x: 50, y: a }, b: { x: 50, y: 100 - a } });

describe("a scene's movement world (§16.1)", () => {
  it("walls block by the blocking matrix: doors when shut, windows and invisible walls always, curtains never", () => {
    const cases: [string, string | null, boolean][] = [
      ["wall", null, true],
      ["door", "closed", true],
      ["door", "locked", true],
      ["door", "open", false],
      ["window", null, true],
      ["curtain", null, false],
      ["invisible", null, true],
      ["secret", "closed", true],
      ["secret", "open", false],
      ["occluder", null, false],
    ];
    for (const [kind, doorState, blocks] of cases) {
      const world = buildMoveWorld({
        walls: [{ id: "w", ...across(-1), kind, doorState: doorState as never }],
        zones: [],
        bounds,
      });
      // A wall spanning the whole scene: blocking means there is no way across.
      const r = route(world, { x: 30, y: 50 }, { x: 70, y: 50 }, [], medium);
      expect(r === null, `${kind}/${doorState}`).toBe(blocks);
    }
  });

  it("effects slow the ground: Web's difficult terrain doubles, Spirit Guardians' halved Speed doubles on top (§8.13)", () => {
    const web = { x: 0, y: 40 };
    const sq = (o: { x: number; y: number }) => [
      o,
      { x: o.x + 100, y: o.y },
      { x: o.x + 100, y: o.y + 20 },
      { x: o.x, y: o.y + 20 },
    ];
    const line = (y: number) => [
      { x: 10, y },
      { x: 30, y },
    ];
    const world = buildMoveWorld({
      walls: [],
      zones: [],
      bounds,
      slow: [
        { poly: sq(web), difficult: true, halved: false },
        { circle: { c: { x: 20, y: 80 }, r: 15 }, difficult: false, halved: true },
        { poly: sq({ x: 0, y: 0 }), difficult: true, halved: false },
        { poly: sq({ x: 0, y: 0 }), difficult: false, halved: true },
      ],
    });
    // Open ground, then web, then guardians, then both: 20, 40, 40, 80.
    expect(pathCost(world, line(30), medium).cost).toBeCloseTo(20, 5);
    expect(pathCost(world, line(50), medium).cost).toBeCloseTo(40, 5);
    expect(pathCost(world, line(80), medium).cost).toBeCloseTo(40, 5);
    expect(pathCost(world, line(10), medium).cost).toBeCloseTo(80, 5);
    // Straight through the guardians' ring costs 36 + 30 = 66; the pathfinder finds the cheaper way round.
    const r = route(world, { x: 2, y: 80 }, { x: 38, y: 80 }, [], medium);
    expect(r?.cost).toBeLessThan(60);
    expect(r?.points.length).toBeGreaterThan(2);
  });

  it("impassable zones are walls around their outline; difficult terrain doubles; water only for non-swimmers", () => {
    const zones = [
      { id: "pit", kind: "impassable", shape: { kind: "circle" as const, x: 50, y: 50, r: 10 } },
      { id: "mud", kind: "difficult", shape: { kind: "rect" as const, x: 0, y: 80, w: 100, h: 20 } },
      {
        id: "lake",
        kind: "water",
        shape: {
          kind: "polygon" as const,
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 20 },
            { x: 0, y: 20 },
          ],
        },
      },
      { id: "altar", kind: "label", shape: { kind: "rect" as const, x: 40, y: 20, w: 20, h: 10 } },
      { id: "fire", kind: "hazard", shape: { kind: "rect" as const, x: 60, y: 60, w: 10, h: 10 } },
    ];
    const walker = buildMoveWorld({ walls: [], zones, bounds });
    const swimmer = buildMoveWorld({ walls: [], zones, bounds, creature: { swim: true } });
    // Straight through the pit is impossible: the route bends around it (and keeps clear of it).
    const r = route(walker, { x: 30, y: 50 }, { x: 70, y: 50 }, [], medium);
    expect(r?.points.length).toBeGreaterThan(2);
    for (const p of r?.points ?? []) expect(Math.hypot(p.x - 50, p.y - 50)).toBeGreaterThan(10);
    // Mud doubles; labels and hazards cost nothing extra.
    expect(
      pathCost(
        walker,
        [
          { x: 10, y: 90 },
          { x: 30, y: 90 },
        ],
        {},
      ).cost,
    ).toBeCloseTo(40, 9);
    expect(
      pathCost(
        walker,
        [
          { x: 45, y: 25 },
          { x: 55, y: 25 },
        ],
        {},
      ).cost,
    ).toBeCloseTo(10, 9);
    expect(
      pathCost(
        walker,
        [
          { x: 61, y: 65 },
          { x: 69, y: 65 },
        ],
        {},
      ).cost,
    ).toBeCloseTo(8, 9);
    // Water: double for a walker, normal for a swimmer.
    expect(
      pathCost(
        walker,
        [
          { x: 10, y: 10 },
          { x: 30, y: 10 },
        ],
        {},
      ).cost,
    ).toBeCloseTo(40, 9);
    expect(
      pathCost(
        swimmer,
        [
          { x: 10, y: 10 },
          { x: 30, y: 10 },
        ],
        {},
      ).cost,
    ).toBeCloseTo(20, 9);
  });
});

describe("a free-standing wall in a room with difficult ground (the P3 key screens' scene)", () => {
  it("routes round the wall's end — never through it — and pays double only inside the mud", () => {
    const world = buildMoveWorld({
      walls: [
        { id: "n", a: { x: 8, y: 6 }, b: { x: 52, y: 6 }, kind: "wall", doorState: null },
        { id: "e", a: { x: 52, y: 6 }, b: { x: 52, y: 34 }, kind: "wall", doorState: null },
        { id: "s", a: { x: 52, y: 34 }, b: { x: 8, y: 34 }, kind: "wall", doorState: null },
        { id: "w", a: { x: 8, y: 34 }, b: { x: 8, y: 6 }, kind: "wall", doorState: null },
        { id: "free", a: { x: 11, y: 20 }, b: { x: 21, y: 20 }, kind: "wall", doorState: null },
      ],
      zones: [{ id: "mud", kind: "difficult", shape: { kind: "rect", x: 12, y: 8, w: 10, h: 8 } }],
      bounds: { minX: 0, minY: 0, maxX: 60, maxY: 40 },
    });
    const r = route(world, { x: 16, y: 26 }, { x: 17, y: 11 }, [], { rc: clearanceRadius(5) });
    expect(r).not.toBeNull();
    const path = (r as NonNullable<typeof r>).points;
    // Never across the wall: every leg keeps clear of it.
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as { x: number; y: number };
      const b = path[i] as { x: number; y: number };
      expect(segSegDist2(a.x, a.y, b.x, b.y, 11, 20, 21, 20)).toBeGreaterThan(1.9 ** 2);
    }
    // Longer than the straight 15 ft (+5 ft of mud) it would be through the wall.
    expect((r as NonNullable<typeof r>).cost).toBeGreaterThan(21);
  });
});

describe("a drag: many queries from one start on one world (the kept start edges)", () => {
  it("answers each new goal as a fresh world would — a clear line to an earlier goal never carries over", () => {
    const walls = [
      { id: "n", a: { x: 8, y: 6 }, b: { x: 52, y: 6 }, kind: "wall" as const, doorState: null },
      { id: "s", a: { x: 52, y: 34 }, b: { x: 8, y: 34 }, kind: "wall" as const, doorState: null },
      { id: "w", a: { x: 8, y: 34 }, b: { x: 8, y: 6 }, kind: "wall" as const, doorState: null },
      { id: "e", a: { x: 52, y: 6 }, b: { x: 52, y: 34 }, kind: "wall" as const, doorState: null },
      { id: "free", a: { x: 11, y: 20 }, b: { x: 21, y: 20 }, kind: "wall" as const, doorState: null },
    ];
    const bounds = { minX: 0, minY: 0, maxX: 60, maxY: 40 };
    for (const zones of [
      [],
      [{ id: "mud", kind: "difficult", shape: { kind: "rect" as const, x: 12, y: 8, w: 10, h: 8 } }],
    ]) {
      const kept = buildMoveWorld({ walls, zones, bounds });
      const o = { rc: clearanceRadius(5) };
      const start = { x: 16, y: 26 };
      // Pointer positions of a drag straight north: first in plain view, then behind the wall.
      for (let i = 1; i <= 10; i++) {
        const goal = { x: 16 + i / 10, y: 26 - 1.5 * i };
        const r = route(kept, start, goal, [], o);
        const fresh = route(buildMoveWorld({ walls, zones, bounds }), start, goal, [], o);
        expect(r === null, `goal ${i} reachable`).toBe(fresh === null);
        if (r && fresh) expect(r.cost, `goal ${i}`).toBeCloseTo(fresh.cost, 6);
      }
    }
  });
});
