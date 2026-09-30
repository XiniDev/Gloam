import { describe, expect, it } from "vitest";
import { hostileTo, opportunityMarks, type Threat } from "./opportunity.ts";

const goblin = (over: Partial<Threat> = {}): Threat => ({
  id: "g1",
  name: "Goblin 2",
  pos: { x: 10, y: 0 },
  sizeFt: 5,
  reachFt: 5,
  disposition: "hostile",
  incapacitated: false,
  ...over,
});
const hero = { sizeFt: 5, disposition: "party" as const, disengaged: false };

describe("opportunity attacks (AC-MOV-15)", () => {
  it("who threatens whom: the party and its friends against the hostiles", () => {
    expect(hostileTo("party", "hostile")).toBe(true);
    expect(hostileTo("hostile", "friendly")).toBe(true);
    expect(hostileTo("party", "neutral")).toBe(false);
    expect(hostileTo("hostile", "hostile")).toBe(false);
  });

  it("leaving a hostile's reach marks the exit, where the bases' edges are the reach apart", () => {
    // Starting beside the goblin (edges 5 ft apart = in reach), walking away along −x.
    const marks = opportunityMarks(
      [
        { x: 5, y: 0 },
        { x: -10, y: 0 },
      ],
      hero,
      [goblin()],
    );
    expect(marks).toHaveLength(1);
    // Edge to edge: |x − 10| − 2.5 − 2.5 = 5 → x = 0.
    expect(marks[0]?.at.x).toBeCloseTo(0, 2);
    expect(marks[0]?.byName).toBe("Goblin 2");
  });

  it("no mark: never in reach, staying in reach, a friend, a creature that can't react, a Disengaged mover", () => {
    const away = [
      { x: -20, y: 0 },
      { x: -40, y: 0 },
    ];
    expect(opportunityMarks(away, hero, [goblin()])).toEqual([]);
    const stay = [
      { x: 4, y: 0 },
      { x: 4, y: 3 },
    ];
    expect(opportunityMarks(stay, hero, [goblin()])).toEqual([]);
    const leave = [
      { x: 5, y: 0 },
      { x: -10, y: 0 },
    ];
    expect(opportunityMarks(leave, hero, [goblin({ disposition: "friendly" })])).toEqual([]);
    expect(opportunityMarks(leave, hero, [goblin({ incapacitated: true })])).toEqual([]);
    expect(opportunityMarks(leave, { ...hero, disengaged: true }, [goblin()])).toEqual([]);
    // Its Reaction spent, or it can't see the mover (Blinded, the mover Invisible): no mark (rules audit C3).
    expect(opportunityMarks(leave, hero, [goblin({ canReact: false })])).toEqual([]);
    expect(opportunityMarks(leave, hero, [goblin({ seesMover: false })])).toEqual([]);
    expect(opportunityMarks(leave, hero, [goblin({ canReact: true, seesMover: true })])).toHaveLength(1);
  });

  it("a reach of 10 ft (a polearm, a large claw) moves the exit out", () => {
    const marks = opportunityMarks(
      [
        { x: 5, y: 0 },
        { x: -20, y: 0 },
      ],
      hero,
      [goblin({ reachFt: 10 })],
    );
    expect(marks[0]?.at.x).toBeCloseTo(-5, 2);
  });

  it("in, out, in again, out again: two marks", () => {
    const marks = opportunityMarks(
      [
        { x: 5, y: 0 },
        { x: -5, y: 0 },
        { x: 5, y: 0 },
        { x: -5, y: 0 },
      ],
      hero,
      [goblin()],
    );
    expect(marks).toHaveLength(2);
  });
});
