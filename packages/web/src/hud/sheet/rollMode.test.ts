import { describe, expect, it } from "vitest";
import { modeOf, withMode } from "./rollMode.ts";

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
