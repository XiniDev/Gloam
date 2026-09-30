import { describe, expect, it } from "vitest";
import { clampFlight, flightCost, turnBudget } from "./route.ts";
import { MoveWorld } from "./world.ts";

const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

describe("flight (§16.4; rules audit A3)", () => {
  // Spirit Guardians round a caster on the ground at (50, 50): a 15-ft emanation, from the floor to 15 ft up.
  const world = new MoveWorld({
    walls: [],
    bounds,
    regions: [
      { circle: { c: { x: 50, y: 50 }, r: 15 }, kind: "halved", z: { min: 0, max: 15 } },
      // The ground's difficult terrain (no height): never slows a flier.
      { circle: { c: { x: 20, y: 50 }, r: 10 }, kind: "difficult" },
    ],
  });

  it("pays each foot at its 3-D length; an effect at its height caps what it may spend there (halved Speed, rules audit Q1), nothing above it", () => {
    const low = flightCost(
      [
        { x: 20, y: 50 },
        { x: 80, y: 50 },
      ],
      [10, 10],
      world,
    );
    // 60 ft across, 30 of them inside the emanation (x 35–65) at 10 ft up: 60 — halving caps, it doesn't price.
    expect(low).toBeCloseTo(60, 5);
    // With a 60-ft fly speed: 30 may be spent inside it — the first 15 ft to its edge, then 15 in.
    const capped = clampFlight(
      world,
      [
        { x: 20, y: 50 },
        { x: 80, y: 50 },
      ],
      [10, 10],
      turnBudget(60, 0),
    );
    expect(capped.points.at(-1)?.x).toBeCloseTo(50, 3);
    // Above it (30 ft up): no cap.
    expect(
      clampFlight(
        world,
        [
          { x: 20, y: 50 },
          { x: 80, y: 50 },
        ],
        [30, 30],
        turnBudget(60, 0),
      ).points.at(-1)?.x,
    ).toBeCloseTo(80, 3);
    const high = flightCost(
      [
        { x: 20, y: 50 },
        { x: 80, y: 50 },
      ],
      [30, 30],
      world,
    );
    expect(high).toBeCloseTo(60, 5);
    // Climbing: the 3-D length (a 3-4-5 triangle), outside everything.
    expect(
      flightCost(
        [
          { x: 80, y: 10 },
          { x: 95, y: 10 },
        ],
        [0, 20],
        world,
      ),
    ).toBeCloseTo(25, 5);
  });

  it("stops where the budget runs out, at the height climbed to by then", () => {
    const c = clampFlight(
      world,
      [
        { x: 80, y: 10 },
        { x: 95, y: 10 },
      ],
      [0, 20],
      10,
    );
    expect(flightCost(c.points, c.elevations, world)).toBeCloseTo(10, 3);
    expect(c.points.at(-1)?.x).toBeCloseTo(86, 1);
    expect(c.elevations.at(-1)).toBeCloseTo(8, 1);
  });
});
