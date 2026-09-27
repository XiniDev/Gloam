import { describe, expect, it } from "vitest";
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
