import { describe, expect, it } from "vitest";
import { hintFor, modeOf, testOf, withMode } from "./rollMode.ts";

describe("rolling from the sheet with advantage (AC-SHEET-08)", () => {
  it("Alt is advantage, Ctrl or Cmd disadvantage, nothing is a normal roll", () => {
    expect(modeOf({ altKey: true, ctrlKey: false, metaKey: false })).toBe("adv");
    expect(modeOf({ altKey: false, ctrlKey: true, metaKey: false })).toBe("dis");
    expect(modeOf({ altKey: false, ctrlKey: false, metaKey: true })).toBe("dis");
    expect(modeOf({ altKey: false, ctrlKey: false, metaKey: false })).toBe("normal");
  });

  it("adds advantage to a d20 roll's formula — 1d20, with references and modifiers", () => {
    expect(withMode("1d20 + @skill.perception", "adv")).toBe("1d20 + @skill.perception adv");
    expect(withMode("1d20 + @wis.save", "dis")).toBe("1d20 + @wis.save dis");
    expect(withMode("1d20+5", "adv")).toBe("1d20+5 adv");
    expect(withMode("1d20 + @str + @prof", "normal")).toBe("1d20 + @str + @prof");
  });

  it("leaves alone what has no single d20 to double, or already says adv/dis", () => {
    expect(withMode("2d6 + @str", "adv")).toBe("2d6 + @str");
    expect(withMode("1d100", "dis")).toBe("1d100");
    expect(withMode("2d20kh1 + 3", "adv")).toBe("2d20kh1 + 3");
    expect(withMode("1d20 + 3 adv", "dis")).toBe("1d20 + 3 adv");
    expect(withMode("1d20 +", "adv")).toBe("1d20 +");
  });
});

describe("sheet rolls: their conditions' hints (AC-DICE-11)", () => {
  it("reads what kind of D20 Test a sheet formula is", () => {
    expect(testOf("1d20 + @dex.save")).toEqual({ kind: "save", ability: "dex" });
    expect(testOf("1d20 + @skill.stealth")).toEqual({ kind: "check", ability: "dex" });
    expect(testOf("1d20 + @init")).toEqual({ kind: "initiative" });
    expect(testOf("1d20 + @wis")).toEqual({ kind: "check", ability: "wis" });
    expect(testOf("2d6 + @str")).toBeNull();
  });
  it("hints from the character's conditions: Poisoned checks at disadvantage, Invisible initiative at advantage", () => {
    expect(hintFor(["poisoned"], { kind: "check", ability: "wis" })).toEqual({
      mode: "dis",
      from: ["Poisoned"],
    });
    expect(hintFor(["invisible"], { kind: "initiative" })).toEqual({ mode: "adv", from: ["Invisible"] });
    expect(hintFor(["poisoned", "invisible"], { kind: "attack" })).toEqual({ mode: "normal", from: [] });
    expect(hintFor(["poisoned"], null)).toEqual({ mode: "normal", from: [] });
  });
});
