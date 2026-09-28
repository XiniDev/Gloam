import { describe, expect, it } from "vitest";
import { numbersOf } from "./HpNumbers.tsx";

describe("floating HP numbers (AC-HP-11)", () => {
  it("each damage type in its colour, largest first; healing verdigris with a +; temp HP in ice", () => {
    expect(
      numbersOf({
        tokenId: "t",
        kind: "damage",
        amount: 17,
        parts: [
          { type: "fire", amount: 10 },
          { type: "slashing", amount: 7 },
        ],
      }),
    ).toEqual([
      { text: "−10", color: "var(--dmg-fire)" },
      { text: "−7", color: "var(--dmg-slashing)" },
    ]);
    expect(numbersOf({ tokenId: "t", kind: "heal", amount: 5 })).toEqual([
      { text: "+5", color: "var(--dmg-healing)" },
    ]);
    expect(numbersOf({ tokenId: "t", kind: "temp", amount: 3 })).toEqual([
      { text: "+3 temp", color: "var(--hp-temp)" },
    ]);
    // Nothing taken, nothing shown.
    expect(numbersOf({ tokenId: "t", kind: "damage", amount: 0, parts: [] })).toEqual([]);
  });
});
