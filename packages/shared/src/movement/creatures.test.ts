import { describe, expect, it } from "vitest";
import {
  allies,
  endsClear,
  lastClearPoint,
  type SpaceCreature,
  spaceFor,
  withCreatureSpaces,
} from "./creatures.ts";
import { validateMove } from "./validate.ts";
import { MoveWorld } from "./world.ts";

const c = (id: string, x: number, y: number, over: Partial<SpaceCreature> = {}): SpaceCreature => ({
  id,
  pos: { x, y },
  sizeFt: 5,
  size: "medium",
  disposition: "hostile",
  incapacitated: false,
  ...over,
});
const hero = c("hero", 0, 0, { disposition: "party" });
const world = new MoveWorld({ walls: [], bounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 } });

describe("creature spaces (SRD 5.2.1 p. 14, AC-MOV-16)", () => {
  it("sides: the party and its friends; hostiles together; a neutral with no one", () => {
    expect(allies("party", "friendly")).toBe(true);
    expect(allies("hostile", "hostile")).toBe(true);
    expect(allies("party", "hostile")).toBe(false);
    expect(allies("neutral", "neutral")).toBe(false);
  });

  it("an ally is passed freely; a non-ally blocks unless Tiny, Incapacitated or two sizes apart (then difficult)", () => {
    expect(spaceFor(hero, c("mira", 0, 0, { disposition: "party" }))).toBe("free");
    expect(spaceFor(hero, c("orc", 0, 0))).toBe("blocked");
    expect(spaceFor(hero, c("rat", 0, 0, { size: "tiny" }))).toBe("free");
    expect(spaceFor(hero, c("dazed", 0, 0, { incapacitated: true }))).toBe("difficult");
    expect(spaceFor(hero, c("giant", 0, 0, { size: "huge" }))).toBe("difficult");
    expect(spaceFor(hero, c("ogre", 0, 0, { size: "large" }))).toBe("blocked");
  });

  it("SRD 5.1: any non-hostile creature can be passed, a hostile one only two sizes apart; every space is difficult", () => {
    expect(spaceFor(hero, c("mira", 0, 0, { disposition: "party" }), "srd-5.1")).toBe("difficult");
    expect(spaceFor(hero, c("villager", 0, 0, { disposition: "neutral" }), "srd-5.1")).toBe("difficult");
    expect(spaceFor(hero, c("orc", 0, 0), "srd-5.1")).toBe("blocked");
    expect(spaceFor(hero, c("giant", 0, 0, { size: "huge" }), "srd-5.1")).toBe("difficult");
  });

  it("a move through a blocking creature stops at it; through a passable one costs double there", () => {
    const orc = c("orc", 10, 0);
    const w = withCreatureSpaces(world, hero, [orc]);
    const blocked = validateMove(
      w,
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      { rc: 2 },
      null,
    );
    expect("error" in blocked).toBe(false);
    if (!("error" in blocked)) {
      expect(blocked.bumped).toBe(true);
      expect((blocked.points.at(-1) as { x: number }).x).toBeLessThan(10);
    }
    const dazed = c("dazed", 10, 0, { incapacitated: true });
    const w2 = withCreatureSpaces(world, hero, [dazed]);
    const through = validateMove(
      w2,
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      { rc: 2 },
      null,
    );
    expect("error" in through).toBe(false);
    if (!("error" in through)) expect(through.cost).toBeCloseTo(25, 0);
  });

  it("a move may not end overlapping another base by more than half the smaller diameter", () => {
    const orc = c("orc", 10, 0);
    expect(endsClear({ x: 6, y: 0 }, hero, [orc])).toBe(true);
    expect(endsClear({ x: 7.6, y: 0 }, hero, [orc])).toBe(false);
    const back = lastClearPoint(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      hero,
      [orc],
    );
    expect(back).not.toBeNull();
    expect(back?.at.x).toBeLessThanOrEqual(7.5 + 1e-6);
    expect(back?.at.x).toBeGreaterThan(6);
    // Nowhere along it but the start: no move.
    expect(
      lastClearPoint(
        [
          { x: 9, y: 0 },
          { x: 10, y: 0 },
        ],
        hero,
        [orc],
      ),
    ).toBeNull();
  });
});
