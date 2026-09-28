import { describe, expect, it } from "vitest";
import { isD20Test, withHint, withPenalty } from "./d20tests.ts";

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
});
