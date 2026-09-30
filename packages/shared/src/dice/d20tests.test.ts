import { describe, expect, it } from "vitest";
import { isD20Test, sheetTestOf, withHint, withPenalty, withTerms } from "./d20tests.ts";

describe("D20 Tests: Exhaustion's penalty and condition hints (AC-HP-05, AC-DICE-11)", () => {
  it("knows a D20 Test by its plain 1d20", () => {
    expect(isD20Test("1d20 + 5")).toBe(true);
    expect(isD20Test("1d20 + @dex.save adv")).toBe(true);
    expect(isD20Test("2d6 + 3")).toBe(false);
    expect(isD20Test("not a formula")).toBe(false);
  });
  it("takes 2 × Exhaustion off a D20 Test, before its advantage word; leaves other rolls alone", () => {
    expect(withPenalty("1d20 + 5", -4)).toBe("1d20 + 5 - 4");
    expect(withPenalty("1d20 + 5 dis", -2)).toBe("1d20 + 5 - 2 dis");
    expect(withPenalty("2d6 + 3", -4)).toBe("2d6 + 3");
    expect(withPenalty("1d20", 0)).toBe("1d20");
  });
  it("joins a hint to the roll's own advantage: the same stays, the other cancels, none takes it", () => {
    expect(withHint("1d20 + 5", "dis")).toBe("1d20 + 5 dis");
    expect(withHint("1d20 + 5 dis", "dis")).toBe("1d20 + 5 dis");
    expect(withHint("1d20 + 5 adv", "dis")).toBe("1d20 + 5");
    expect(withHint("1d20 + 5", "normal")).toBe("1d20 + 5");
    expect(withHint("3d6", "adv")).toBe("3d6");
  });
  it("joins marker terms before the advantage word (Bless +1d4, Bane −1d4, Slow −2); leaves other rolls alone", () => {
    expect(withTerms("1d20 + 5", ["+1d4"])).toBe("1d20 + 5 + 1d4");
    expect(withTerms("1d20 + 5 - 2 adv", ["+1d4", "-1d4"])).toBe("1d20 + 5 - 2 + 1d4 - 1d4 adv");
    expect(withTerms("1d20 + @dex.save", ["-2"])).toBe("1d20 + @dex.save - 2");
    expect(withTerms("2d6 + 3", ["+1d4"])).toBe("2d6 + 3");
    expect(withTerms("1d20", [])).toBe("1d20");
  });
  it("knows a sheet roll's test by its formula", () => {
    expect(sheetTestOf("1d20 + @dex.save")).toEqual({ kind: "save", ability: "dex" });
    expect(sheetTestOf("1d20 + @skill.stealth")).toEqual({ kind: "check", ability: "dex" });
    expect(sheetTestOf("1d20 + @init")).toEqual({ kind: "initiative" });
    expect(sheetTestOf("2d6 + @str")).toBeNull();
  });
});
