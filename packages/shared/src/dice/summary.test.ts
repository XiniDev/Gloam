import { describe, expect, it } from "vitest";
import { formulaText, summarizeFormula } from "./summary.ts";

const refs: Record<string, number> = { str: 3, dex: 1, prof: 3, "wis.save": 4 };
const resolve = (p: readonly string[]) => refs[p.join(".")];

describe("a formula as the sheet shows it (§8.10 Actions)", () => {
  it("resolves references into one bonus beside the dice", () => {
    expect(summarizeFormula("1d20 + @str + @prof", resolve)).toEqual({ dice: ["1d20"], bonus: 6, tags: [] });
    expect(formulaText(summarizeFormula("1d20 + @str + @prof", resolve), { toHit: true })).toBe("+6");
    expect(formulaText(summarizeFormula("1d8 + @str [bludgeoning]", resolve))).toBe("1d8 + 3 bludgeoning");
    expect(formulaText(summarizeFormula("2d6 - 1", resolve))).toBe("2d6 − 1");
    expect(formulaText(summarizeFormula("1d20 - @prof", resolve), { toHit: true })).toBe("−3");
  });

  it("leaves what isn't a plain sum as written", () => {
    expect(summarizeFormula("2d6 * 2", resolve)).toBeNull();
    expect(summarizeFormula("4d6kh3", resolve)).toBeNull();
    expect(summarizeFormula("1d20 + @unknown", resolve)).toBeNull();
    expect(summarizeFormula("1d20 +", resolve)).toBeNull();
    // Two damage types can't be one "dice + bonus type" line: as written.
    expect(summarizeFormula("1d6 + @dex [piercing] + 1d6 [fire]", resolve)).toBeNull();
    expect(formulaText(null)).toBeNull();
  });
});
