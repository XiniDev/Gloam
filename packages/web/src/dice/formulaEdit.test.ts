import { checkFormula } from "@gloam/shared/dice";
import { describe, expect, it } from "vitest";
import {
  addDie,
  advOf,
  countOf,
  modifierOf,
  refAt,
  removeDie,
  setAdv,
  stepCount,
  stepModifier,
  tokenize,
} from "./formulaEdit.ts";

describe("the dice tray's formula editing (SPEC §8.9)", () => {
  it("quick buttons add and remove dice (right-click removes), merging with a term of the same size", () => {
    let f = "";
    f = addDie(f, 20);
    expect(f).toBe("1d20");
    f = addDie(f, 6);
    f = addDie(f, 6);
    expect(f).toBe("1d20 + 2d6");
    f = addDie(f, "%");
    expect(f).toBe("1d20 + 2d6 + 1d%");
    f = removeDie(f, 6);
    expect(f).toBe("1d20 + 1d6 + 1d%");
    f = removeDie(f, 6);
    expect(f).toBe("1d20 + 1d%");
    f = removeDie(f, 20);
    expect(f).toBe("1d%");
    // A d2 isn't a d20.
    expect(addDie("1d2", 20)).toBe("1d2 + 1d20");
    // A term with modifiers is its own: a plain one is added beside it.
    expect(addDie("4d6kh3", 6)).toBe("4d6kh3 + 1d6");
  });

  it("the count stepper steps the last dice term; the modifier stepper the trailing number", () => {
    expect(stepCount("1d20 + 2d6", 1)).toBe("1d20 + 3d6");
    expect(stepCount("1d20", -1)).toBe("1d20");
    expect(stepModifier("1d20", 1)).toBe("1d20 + 1");
    expect(stepModifier("1d20 + 1", -1)).toBe("1d20");
    expect(stepModifier("1d20", -2)).toBe("1d20 - 2");
    expect(modifierOf("1d20 - 2")).toBe(-2);
    expect(modifierOf("2d6")).toBe(0);
    // What the count stepper shows: the term it steps; nothing to step without dice.
    expect(countOf("1d20 + 2d6")).toEqual({ count: 2, die: "d6" });
    expect(countOf("d20 adv")).toEqual({ count: 1, die: "d20" });
    expect(countOf("3d% + 1")).toEqual({ count: 3, die: "d100" });
    expect(countOf("5")).toBeNull();
  });

  it("advantage is a trailing keyword kept through edits, and the result always parses", () => {
    let f = setAdv("1d20 + 5", "adv");
    expect(f).toBe("1d20 + 5 adv");
    expect(advOf(f)).toBe("adv");
    f = stepModifier(f, 1);
    expect(f).toBe("1d20 + 6 adv");
    f = setAdv(f, "dis");
    expect(f).toBe("1d20 + 6 dis");
    expect(checkFormula(f)).toBeNull();
    expect(setAdv(f, null)).toBe("1d20 + 6");
    for (const g of ["1d20 + 1d6 + 1d%", "1d20 - 2", "3d6"]) expect(checkFormula(g)).toBeNull();
  });

  it("highlighting pieces and the reference being typed", () => {
    expect(tokenize("2d6!+@dex [fire] adv").map((t) => t.kind)).toEqual([
      "dice",
      "op",
      "ref",
      "space",
      "tag",
      "space",
      "keyword",
    ]);
    expect(refAt("1d20 + @de", 10)).toEqual({ start: 7, text: "@de" });
    expect(refAt("1d20 + 5", 8)).toBeNull();
  });
});
