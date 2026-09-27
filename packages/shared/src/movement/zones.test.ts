import { describe, expect, it } from "vitest";
import { hazardPrompts, pathEnters, zoneContains } from "./zones.ts";

const fire = {
  id: "z1",
  kind: "hazard",
  label: "Burning floor",
  shape: { kind: "rect" as const, x: 10, y: 10, w: 10, h: 10 },
  triggers: [
    { when: "enter" as const, label: "Flames lick at you", damage: { formula: "1d4", type: "fire" } },
    {
      when: "startTurn" as const,
      label: "Still burning",
      save: { ability: "dex", dc: 12, onSuccess: "half" as const },
      damage: { formula: "1d4", type: "fire" },
    },
    { when: "endTurn" as const, label: "Smoke", damage: { formula: "1", type: "poison" } },
  ],
};

describe("zones and hazard triggers (SPEC §8.7, AC-WAL-05)", () => {
  it("knows what's inside a rectangle, a circle and a polygon", () => {
    expect(zoneContains(fire.shape, { x: 15, y: 15 })).toBe(true);
    expect(zoneContains(fire.shape, { x: 25, y: 15 })).toBe(false);
    expect(zoneContains({ kind: "circle", x: 0, y: 0, r: 5 }, { x: 3, y: 3 })).toBe(true);
    expect(zoneContains({ kind: "circle", x: 0, y: 0, r: 5 }, { x: 4, y: 4 })).toBe(false);
    const tri = {
      kind: "polygon" as const,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
    };
    expect(zoneContains(tri, { x: 2, y: 2 })).toBe(true);
    expect(zoneContains(tri, { x: 8, y: 8 })).toBe(false);
  });

  it("a move enters a zone by ending inside or by crossing it — not by starting inside or passing by", () => {
    expect(
      pathEnters(fire.shape, [
        { x: 0, y: 15 },
        { x: 15, y: 15 },
      ]),
    ).toBe(true);
    // Straight through, ending beyond it.
    expect(
      pathEnters(fire.shape, [
        { x: 0, y: 15 },
        { x: 30, y: 15 },
      ]),
    ).toBe(true);
    // Starting inside and leaving isn't entering.
    expect(
      pathEnters(fire.shape, [
        { x: 15, y: 15 },
        { x: 30, y: 15 },
      ]),
    ).toBe(false);
    // Passing by.
    expect(
      pathEnters(fire.shape, [
        { x: 0, y: 5 },
        { x: 30, y: 5 },
      ]),
    ).toBe(false);
    // A circle crossed by a chord.
    expect(
      pathEnters({ kind: "circle", x: 0, y: 0, r: 5 }, [
        { x: -10, y: 2 },
        { x: 10, y: 2 },
      ]),
    ).toBe(true);
  });

  it("prompts at the right moments: entering, and starting or ending a turn inside", () => {
    const enter = hazardPrompts([fire], {
      when: "enter",
      path: [
        { x: 0, y: 15 },
        { x: 15, y: 15 },
      ],
    });
    expect(enter).toEqual([
      {
        zoneId: "z1",
        zoneLabel: "Burning floor",
        when: "enter",
        label: "Flames lick at you",
        damage: { formula: "1d4", type: "fire" },
      },
    ]);
    const start = hazardPrompts([fire], { when: "startTurn", at: { x: 12, y: 12 } });
    expect(start.map((p) => p.label)).toEqual(["Still burning"]);
    expect(start[0]?.save).toEqual({ ability: "dex", dc: 12, onSuccess: "half" });
    expect(hazardPrompts([fire], { when: "endTurn", at: { x: 12, y: 12 } }).map((p) => p.label)).toEqual([
      "Smoke",
    ]);
    // Outside, nothing; other kinds never prompt.
    expect(hazardPrompts([fire], { when: "startTurn", at: { x: 40, y: 40 } })).toEqual([]);
    expect(
      hazardPrompts([{ ...fire, kind: "difficult" }], { when: "startTurn", at: { x: 12, y: 12 } }),
    ).toEqual([]);
  });
});
