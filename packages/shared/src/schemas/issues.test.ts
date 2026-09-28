import { describe, expect, it } from "vitest";
import { issueText } from "./issues.ts";
import { Sheet } from "./sheet.ts";

const problems = (doc: unknown) => {
  const r = Sheet.safeParse(doc);
  if (r.success) return [];
  return r.error.issues.map((i) => `${i.path.join(".")}: ${issueText(i as never, doc)}`);
};

describe("import problems in plain words (AC-SHEET-06)", () => {
  it("says what's wrong and what the value is", () => {
    expect(problems({ core: { name: "A", abilities: { str: 34 } } })).toEqual([
      "core.abilities.str: must be 30 or less (it's 34)",
    ]);
    expect(problems({ core: { name: "A", ac: { value: -2 } } })).toEqual([
      "core.ac.value: must be 0 or more (it's -2)",
    ]);
    expect(problems({ core: { name: "" } })).toEqual(["core.name: can't be empty"]);
    expect(problems({ core: {} })).toEqual(["core.name: is missing"]);
    expect(problems({ core: { name: "A", hp: { max: "lots", current: 3 } } })).toEqual([
      'core.hp.max: should be a number (it\'s "lots")',
    ]);
    expect(problems({ core: { name: "A", size: "enormous" } })[0]).toMatch(
      /^core\.size: isn't one Gloam knows \(it's "enormous"\) — one of "tiny"/,
    );
    expect(problems({ core: { name: "A", colour: "red" } })).toEqual([
      "core: has a field Gloam doesn't know: colour",
    ]);
  });
});
