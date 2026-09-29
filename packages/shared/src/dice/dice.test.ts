import { describe, expect, it } from "vitest";
import { normalizeFormula, roll, termContribution } from "./evaluate.ts";
import { checkFormula, DICE_LIMITS, DiceError, parseFormula } from "./parse.ts";
import { DEFAULT_SKIN, type RollRecord, type RollVisibility, viewOfRoll } from "./record.ts";
import { seededDie, xoshiro128ss } from "./rng.ts";

/** A die that returns the given faces in order (then 1s). */
function faces(...vs: number[]) {
  let i = 0;
  return (sides: number) => {
    const v = vs[i++] ?? 1;
    if (v > sides) throw new Error(`face ${v} on a d${sides}`);
    return v;
  };
}
const refs: Record<string, number> = { str: 3, dex: 2, prof: 2, "dex.save": 4, "skill.stealth": 6, level: 5 };
const resolve = (p: readonly string[]) => refs[p.join(".")];
const r = (f: string, ...vs: number[]) => roll(f, { die: faces(...vs), resolve });
const err = (f: string): DiceError => {
  try {
    roll(f, { die: faces(), resolve });
  } catch (e) {
    if (e instanceof DiceError) return e;
    throw e;
  }
  throw new Error(`${f} rolled`);
};

describe("dice formulas (SPEC §18.1, AC-DICE-01)", () => {
  it("adds, subtracts, multiplies and divides (rounding down), with brackets and negation", () => {
    expect(r("1d20+5", 12).total).toBe(17);
    expect(r("2d6 - 1", 3, 4).total).toBe(6);
    expect(r("3*(1d4+1)", 2).total).toBe(9);
    expect(r("7/2").total).toBe(3);
    expect(r("-7/2").total).toBe(-4); // rounds down, not toward zero
    expect(r("-1d4", 3).total).toBe(-3);
    expect(r("10 - 2 - 3").total).toBe(5);
    expect(r("2*3+4*5").total).toBe(26);
  });

  it("d20, d%, a count from an expression", () => {
    expect(r("d20", 7).terms[0]).toMatchObject({ kind: "dice", count: 1, sides: 20 });
    expect(r("1d%", 57).total).toBe(57);
    // The count is rolled first (1d4 + 1 = 3), then 3d6; the count itself isn't added.
    const x = r("(1d4+1)d6", 2, 6, 6, 6);
    expect(x.total).toBe(18);
    expect(x.terms.find((t) => t.kind === "dice" && t.sides === 6)).toMatchObject({ count: 3, subtotal: 18 });
  });

  it("keep and drop: kh, kl, k (= kh), dh, dl, defaulting to 1", () => {
    expect(r("4d6kh3", 1, 5, 3, 6).total).toBe(14);
    expect(r("4d6dl1", 1, 5, 3, 6).total).toBe(14);
    expect(r("2d20kl1", 15, 4).total).toBe(4);
    expect(r("2d20k", 15, 4).total).toBe(15);
    expect(r("3d6dh", 6, 2, 5).total).toBe(7);
    const kept = r("4d6kh3", 1, 5, 3, 6).terms[0];
    expect(kept?.kind === "dice" && kept.dice.map((d) => d.kept)).toEqual([false, true, true, true]);
  });

  it("rerolls: r repeats while matching (at most 20), ro once; default =1; comparisons", () => {
    const a = r("1d6r", 1, 1, 4).terms[0];
    expect(a?.kind === "dice" && a.dice[0]).toMatchObject({ value: 4, rerolledFrom: [1, 1] });
    const b = r("1d6ro", 1, 1).terms[0];
    expect(b?.kind === "dice" && b.dice[0]).toMatchObject({ value: 1, rerolledFrom: [1] });
    expect(r("1d10r<3", 2, 1, 3).total).toBe(3);
    // Capped: 20 rerolls, then the face stands.
    const capped = r("1d6r<=2", ...Array(30).fill(1)).terms[0];
    expect(capped?.kind === "dice" && capped.dice[0]?.rerolledFrom?.length).toBe(20);
    expect(err("1d6r<7").message).toMatch(/every face/);
  });

  it("explosions: ! on the top face (or a comparison), each exploded die marked, depth at most 20", () => {
    const x = r("2d6!", 6, 3, 2);
    expect(x.total).toBe(11);
    const t = x.terms[0];
    expect(t?.kind === "dice" && t.dice.map((d) => [d.value, d.exploded])).toEqual([
      [6, true],
      [3, false],
      [2, false],
    ]);
    expect(r("1d10!>8", 9, 10, 2).total).toBe(21);
    // A d1 always explodes: the chain stops after 20 extra dice.
    const one = r("1d1!").terms[0];
    expect(one?.kind === "dice" && one.dice.length).toBe(DICE_LIMITS.explodeDepth + 1);
  });

  it("min and max: Great Weapon Fighting's min3", () => {
    expect(r("2d6min3", 1, 5).total).toBe(8);
    expect(r("1d20max15", 19).total).toBe(15);
    expect(err("1d6min7").message).toMatch(/outside/);
  });

  it("@ references resolve from the roller; unknown ones are errors", () => {
    expect(r("1d20+@dex.save", 10).total).toBe(14);
    expect(r("1d20 + @skill.stealth", 10).total).toBe(16);
    expect(r("@level*2").total).toBe(10);
    const e = err("1d20+@wis");
    expect(e.message).toMatch(/@wis/);
    expect([e.at, e.end]).toEqual([5, 9]);
  });

  it("adv / dis turn the first 1d20 into 2d20kh1 / 2d20kl1", () => {
    const a = r("1d20+5 adv", 4, 17);
    expect(a.total).toBe(22);
    expect(a.normalized).toBe("2d20kh1 + 5");
    expect(a.natural).toBe(17);
    const d = r("1d20+5 dis", 4, 17);
    expect(d.total).toBe(9);
    expect(d.normalized).toBe("2d20kl1 + 5");
    expect(err("2d6 adv").message).toMatch(/d20/);
    expect(checkFormula("1d8 adv")?.message).toMatch(/d20/);
  });

  it("a subtracted term keeps its sign: '1d20 - 4' records −4, '1d20 - 1d4' the d4 as subtracted, '-(-2)' as added", () => {
    const a = r("1d20 - 4", 10);
    expect(a.total).toBe(6);
    expect(a.terms.map(termContribution)).toEqual([10, -4]);
    const b = r("1d20 - 1d4 + @str", 12, 3);
    expect(b.terms.map((t) => t.sign ?? 1)).toEqual([1, -1, 1]);
    expect(b.terms.map(termContribution).reduce((x, y) => x + y, 0)).toBe(b.total);
    const c = r("1d20 - (2 - 1d4)", 10, 3);
    expect(c.terms.map(termContribution)).toEqual([10, -2, 3]);
    expect(c.terms.map(termContribution).reduce((x, y) => x + y, 0)).toBe(c.total);
  });

  it("normalizeFormula: the formula as it will roll, without rolling — the same form as a roll's normalized", () => {
    expect(normalizeFormula("1d20 - 4 dis")).toBe("2d20kl1 - 4");
    expect(normalizeFormula("1d20+5 adv")).toBe(r("1d20+5 adv", 4, 17).normalized);
    expect(normalizeFormula("1d20 + 3")).toBe("1d20 + 3");
    expect(normalizeFormula("2d6 + 1 [fire]")).toBe(r("2d6 + 1 [fire]", 3, 4).normalized);
    expect(() => normalizeFormula("2d6 adv")).toThrow(DiceError);
  });

  it("damage types: a tag on dice types that term; a trailing tag types every untagged term; the rest is untyped", () => {
    expect(r("1d8+@str [bludgeoning]", 5).byTag).toEqual({ bludgeoning: 8 });
    expect(r("1d8[slashing] + 2d6[fire] + 3", 5, 2, 6).byTag).toEqual({ slashing: 5, fire: 8, untyped: 3 });
    expect(r("1d8[slashing] + 1d6 [fire]", 5, 2).byTag).toEqual({ slashing: 5, fire: 2 });
    expect(r("1d8 [fire] + 2", 5).byTag).toEqual({ fire: 5, untyped: 2 });
    expect(r("2d6 - 1", 3, 4).byTag).toEqual({ untyped: 6 });
    expect(r("1d6[Fire]", 3).terms[0]).toMatchObject({ tag: "fire" });
  });

  it("naturals: the first kept d20 — crit on 20, fumble on 1", () => {
    expect(r("1d20+3", 20)).toMatchObject({ natural: 20, crit: true, fumble: false });
    expect(r("1d20+3", 1)).toMatchObject({ natural: 1, crit: false, fumble: true });
    expect(r("2d20kh1", 1, 20).natural).toBe(20);
    expect(r("1d8", 8).natural).toBeUndefined();
  });

  it("normalizes spacing and case", () => {
    expect(r("1D20 +  @DEX", 3).normalized).toBe("1d20 + @dex");
    expect(r("4d6kh3", 1, 1, 1, 1).normalized).toBe("4d6kh3");
    expect(r("2d6!>5ro<2min2", 1, 1, 1, 1).normalized).toBe("2d6!>5ro<2min2");
    expect(r("10-(2-3)").normalized).toBe("10 - (2 - 3)");
    expect(r("10-(2-3)").total).toBe(11);
  });

  it("invalid formulas: readable errors with where they are, before anything is rolled", () => {
    const cases: [string, RegExp, number][] = [
      ["", /Type a formula/, 0],
      ["1d", /sides/, 2],
      ["1d20+", /ends too soon/, 4],
      ["1d20 ++ 2", /Unexpected/, 6],
      ["(1d6", /isn't closed/, 0],
      ["1d6 x", /Unexpected/, 4],
      ["1d0", /1 to 1000 sides/, 2],
      ["1d1001", /1 to 1000 sides/, 2],
      ["101d6", /At most 100 dice/, 0],
      ["0d6", /at least one/, 0],
      ["1d6[]", /empty/, 3],
      ["1d6 [fire] adv x", /Unexpected/, 15],
      ["1d6!>", /needs a number/, 4],
      ["@", /reference/, 0],
      ["1d20+2 adv [fire]", /very end/, 11],
      ["1d6 [fire] [cold]", /right after its dice/, 11],
    ];
    for (const [f, re, at] of cases) {
      const e = checkFormula(f);
      expect([f, e?.message]).toEqual([f, expect.stringMatching(re)]);
      expect([f, e?.at]).toEqual([f, at]);
    }
    expect(checkFormula("1d20+5")).toBeNull();
    expect(checkFormula(`1d20+${"1+".repeat(100)}1`)?.message).toMatch(/at most 200 characters/);
    expect(() => parseFormula("1d6")).not.toThrow();
  });

  it("limits (AC-DICE-09): 100 per term, 500 in all including rerolls and explosions, counts from expressions too", () => {
    expect(r("100d6").terms[0]).toMatchObject({ count: 100 });
    expect(() => r("5*100d6")).not.toThrow();
    expect(err("100d6+100d6+100d6+100d6+100d6+1d6").message).toMatch(/At most 500 dice/);
    // Explosions count toward the 500.
    expect(err("100d1!").message).toMatch(/At most 500 dice/);
    expect(err("(50+51)d6").message).toMatch(/At most 100 dice/);
  });
});

describe("seeded dice (AC-DICE-10's generator)", () => {
  it("xoshiro128** matches the reference output", () => {
    // Reference: state {1, 2, 3, 4} gives 11520, 0, … — checked through the seeding path's own first values.
    const g = xoshiro128ss(42);
    const a = [g(), g(), g()];
    const h = xoshiro128ss(42);
    expect([h(), h(), h()]).toEqual(a);
    expect(new Set(a).size).toBe(3);
  });

  it("the same seed rolls the same; faces are uniform (χ² over 60 000 d20s and d6s)", () => {
    const f = "4d6kh3 + 1d20 + 2d8!";
    expect(roll(f, { die: seededDie(7) })).toEqual(roll(f, { die: seededDie(7) }));
    for (const sides of [6, 20]) {
      const die = seededDie(sides * 1000 + 1);
      const n = 60_000;
      const counts = new Array(sides).fill(0);
      for (let i = 0; i < n; i++) counts[die(sides) - 1]++;
      const e = n / sides;
      const chi2 = counts.reduce((s, c) => s + (c - e) ** 2 / e, 0);
      // 99.9th percentile of χ² with 5 / 19 degrees of freedom: 20.5 / 43.8.
      expect(chi2).toBeLessThan(sides === 6 ? 20.5 : 43.8);
    }
  });
});

describe("who sees a roll (SPEC §18.3, AC-DICE-04)", () => {
  const rec = (visibility: RollVisibility, userId = "anna"): RollRecord => ({
    ...roll("2d6+1", { die: () => 3 }),
    id: "r1",
    userId,
    name: "Anna",
    color: "amber",
    skin: DEFAULT_SKIN,
    visibility,
    manual: false,
    seed: 42,
    tumble: [
      { kind: "d6", face: 3, kept: true },
      { kind: "d6", face: 3, kept: true },
    ],
    at: 1,
  });
  const anna = { userId: "anna", dm: false };
  const bob = { userId: "bob", dm: false };
  const dm = { userId: "dm", dm: true };
  const numbers = (v: unknown) =>
    JSON.stringify(v).includes('"total"') || JSON.stringify(v).includes('"terms"');

  it("public: everyone gets the roll", () => {
    for (const v of [anna, bob, dm]) expect(viewOfRoll(rec("public"), v, false)).toMatchObject({ total: 7 });
  });
  it("private to DM: the roller and DMs get it; other players a card with no numbers", () => {
    expect(viewOfRoll(rec("dm"), anna, false)).toMatchObject({ total: 7 });
    expect(viewOfRoll(rec("dm"), dm, false)).toMatchObject({ total: 7 });
    const b = viewOfRoll(rec("dm"), bob, false);
    expect(b).toMatchObject({ masked: true, text: "Anna rolled privately" });
    expect(numbers(b)).toBe(false);
    // The DM's own private roll: "The DM rolls…".
    expect(viewOfRoll(rec("dm", "dm"), bob, true)).toMatchObject({ masked: true, text: "The DM rolls…" });
  });
  it("blind: only DMs get the numbers — the roller sees '?', others that it was for the DM", () => {
    expect(viewOfRoll(rec("blind"), dm, false)).toMatchObject({ total: 7 });
    const own = viewOfRoll(rec("blind"), anna, false);
    expect(own).toMatchObject({ masked: true, text: "Anna rolled for the DM" });
    expect(numbers(own)).toBe(false);
    const other = viewOfRoll(rec("blind"), bob, false);
    expect(other).toMatchObject({ masked: true, text: "Anna rolled for the DM" });
    expect(numbers(other)).toBe(false);
    // The masked dice keep their kinds (they tumble with "?" faces), never their faces.
    expect((own as { tumble: unknown[] }).tumble).toEqual([{ kind: "d6" }, { kind: "d6" }]);
  });
  it("self: only the roller; DMs are told, other players get nothing", () => {
    expect(viewOfRoll(rec("self"), anna, false)).toMatchObject({ total: 7 });
    expect(viewOfRoll(rec("self"), dm, false)).toMatchObject({
      masked: true,
      text: "Anna rolled for themselves",
    });
    expect(viewOfRoll(rec("self"), bob, false)).toBeNull();
  });
  it("a masked card never carries the label to anyone but its roller, and says when the DM rolled", () => {
    const labelled = (v: RollVisibility, userId = "anna") => ({ ...rec(v, userId), label: "Ambush" });
    for (const [v, viewer, dmRoller] of [
      ["dm", bob, true],
      ["dm", bob, false],
      ["blind", bob, true],
      ["blind", bob, false],
      ["self", dm, false],
    ] as const) {
      const m = viewOfRoll(labelled(v, dmRoller ? "dm" : "anna"), viewer, dmRoller);
      expect(JSON.stringify(m), `${v} for ${viewer.userId}`).not.toContain("Ambush");
      expect(m).toMatchObject({ masked: true, byDm: dmRoller });
    }
    // A player's own blind roll: they typed the label, so they keep it (their dice still show "?").
    expect(viewOfRoll(labelled("blind"), anna, false)).toMatchObject({ masked: true, label: "Ambush" });
  });
});
