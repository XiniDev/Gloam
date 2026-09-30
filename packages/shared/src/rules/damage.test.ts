import { describe, expect, it } from "vitest";
import {
  applyDamage,
  applyHealing,
  concentrationDc,
  type DamageOptions,
  type DamagePart,
  type DamageTarget,
  parseDamage,
  tempHpChoice,
} from "./damage.ts";

const creature = (o: Partial<DamageTarget> = {}): DamageTarget => ({
  hp: 30,
  hpMax: 30,
  hpTemp: 0,
  resistances: [],
  immunities: [],
  vulnerabilities: [],
  conditions: [],
  concentrating: false,
  isPC: true,
  ...o,
});
const p = (amount: number, type: DamagePart["type"] = "untyped"): DamagePart => ({ amount, type });

/** [what, target, parts, options, expected total, expected hp, expected temp after] */
const TABLE: [string, Partial<DamageTarget>, DamagePart[], DamageOptions, number, number, number][] = [
  ["plain untyped damage", {}, [p(7)], {}, 7, 23, 0],
  ["plain typed damage", {}, [p(9, "fire")], {}, 9, 21, 0],
  ["zero damage", {}, [p(0, "fire")], {}, 0, 30, 0],
  ["resistance halves, rounding down (odd)", { resistances: ["fire"] }, [p(9, "fire")], {}, 4, 26, 0],
  ["resistance halves (even)", { resistances: ["fire"] }, [p(10, "fire")], {}, 5, 25, 0],
  ["resistance to 1 damage leaves 0", { resistances: ["cold"] }, [p(1, "cold")], {}, 0, 30, 0],
  ["vulnerability doubles", { vulnerabilities: ["radiant"] }, [p(6, "radiant")], {}, 12, 18, 0],
  ["immunity is zero", { immunities: ["poison"] }, [p(20, "poison")], {}, 0, 30, 0],
  [
    "immunity beats vulnerability",
    { immunities: ["fire"], vulnerabilities: ["fire"] },
    [p(8, "fire")],
    {},
    0,
    30,
    0,
  ],
  [
    "resistance then vulnerability (both: net once)",
    { resistances: ["fire"], vulnerabilities: ["fire"] },
    [p(9, "fire")],
    {},
    8,
    22,
    0,
  ],
  [
    "resistance is per instance, not per total",
    { resistances: ["fire"] },
    [p(5, "fire"), p(5, "fire")],
    {},
    4,
    26,
    0,
  ],
  [
    "each typed part meets its own defences",
    { resistances: ["slashing"] },
    [p(12, "slashing"), p(7, "fire")],
    {},
    13,
    17,
    0,
  ],
  ["untyped ignores resistances", { resistances: ["fire", "slashing"] }, [p(9)], {}, 9, 21, 0],
  ["half on a save, rounding down", {}, [p(15, "fire")], { halved: true }, 7, 23, 0],
  [
    "half on a save before resistance",
    { resistances: ["fire"] },
    [p(15, "fire")],
    { halved: true },
    3,
    27,
    0,
  ],
  [
    "half on a save before vulnerability",
    { vulnerabilities: ["cold"] },
    [p(9, "cold")],
    { halved: true },
    8,
    22,
    0,
  ],
  ["half on a save per part", {}, [p(9, "fire"), p(9, "cold")], { halved: true }, 8, 22, 0],
  [
    "petrified resists everything",
    { conditions: ["petrified"] },
    [p(9, "force"), p(9, "acid")],
    {},
    8,
    22,
    0,
  ],
  [
    "petrified and immune: still zero",
    { conditions: ["petrified"], immunities: ["poison"] },
    [p(9, "poison")],
    {},
    0,
    30,
    0,
  ],
  [
    "petrified and vulnerable: halved then doubled",
    { conditions: ["petrified"], vulnerabilities: ["bludgeoning"] },
    [p(9, "bludgeoning")],
    {},
    8,
    22,
    0,
  ],
  // Rules audit A13: "Resistance to all damage" (SRD 5.2.1 p. 186) — untyped damage too, and after a save's half.
  ["petrified: untyped damage halved too", { conditions: ["petrified"] }, [p(9)], {}, 4, 26, 0],
  [
    "petrified: halved on a save, then resisted",
    { conditions: ["petrified"] },
    [p(9)],
    { halved: true },
    2,
    28,
    0,
  ],
  // The DM's final number is taken as it is: not halved again, resisted, doubled or cancelled.
  [
    "the DM's final number, as it is",
    { conditions: ["petrified"] },
    [p(9)],
    { final: true, halved: true },
    9,
    21,
    0,
  ],
  [
    "a final number ignores immunity and vulnerability too",
    { immunities: ["fire"], vulnerabilities: ["cold"] },
    [p(6, "fire"), p(6, "cold")],
    { final: true },
    12,
    18,
    0,
  ],
  ["temp HP absorb first", { hpTemp: 5 }, [p(3)], {}, 3, 30, 2],
  ["temp HP absorb, the rest to HP", { hpTemp: 5 }, [p(8)], {}, 8, 27, 0],
  [
    "temp HP take the damage after resistance",
    { hpTemp: 5, resistances: ["fire"] },
    [p(10, "fire")],
    {},
    5,
    30,
    0,
  ],
  [
    "immune damage leaves temp HP alone",
    { hpTemp: 5, immunities: ["poison"] },
    [p(10, "poison")],
    {},
    0,
    30,
    5,
  ],
  ["damage beyond HP stops at 0", { hp: 6 }, [p(10)], {}, 10, 0, 0],
  ["exact lethal to 0", { hp: 10 }, [p(10)], {}, 10, 0, 0],
  ["negative parts count as none", {}, [p(-4, "fire"), p(6, "cold")], {}, 6, 24, 0],
  ["many instances add up", {}, [p(3, "piercing"), p(4, "fire"), p(5, "cold")], {}, 12, 18, 0],
  ["already at 0", { hp: 0 }, [p(5)], {}, 5, 0, 0],
  [
    "vulnerable and halved on a save, with temp HP",
    { hpTemp: 4, vulnerabilities: ["thunder"] },
    [p(11, "thunder")],
    { halved: true },
    10,
    24,
    0,
  ],
];

describe("the damage pipeline (SPEC §19.2, SRD 5.2.1; AC-HP-01)", () => {
  it.each(TABLE)("%s", (_, target, parts, opts, total, hp, temp) => {
    const r = applyDamage(creature(target), parts, opts);
    expect(r.total).toBe(total);
    expect(r.hp).toBe(hp);
    expect(r.hpTemp).toBe(temp);
  });

  it("says what happened to each instance, for the preview", () => {
    const r = applyDamage(creature({ resistances: ["slashing"], vulnerabilities: ["fire"] }), [
      p(12, "slashing"),
      p(7, "fire"),
    ]);
    expect(r.parts).toEqual([
      { type: "slashing", amount: 12, applied: 6, steps: ["resisted"] },
      { type: "fire", amount: 7, applied: 14, steps: ["vulnerable"] },
    ]);
  });

  it("overflow past 0, going down, and the SRD massive damage rule (PCs)", () => {
    const hit = applyDamage(creature({ hp: 7, hpMax: 30 }), [p(10)]);
    expect(hit).toMatchObject({ hp: 0, overflow: 3, down: true, massiveDeath: false });
    const massive = applyDamage(creature({ hp: 7, hpMax: 30 }), [p(37)]);
    expect(massive).toMatchObject({ hp: 0, overflow: 30, massiveDeath: true });
    // One short of the maximum left over: not massive.
    expect(applyDamage(creature({ hp: 7, hpMax: 30 }), [p(36)]).massiveDeath).toBe(false);
    // Temp HP soak it first: what's left decides.
    expect(applyDamage(creature({ hp: 7, hpMax: 30, hpTemp: 5 }), [p(40)]).massiveDeath).toBe(false);
    // NPCs don't make death saves; the DM's 0-HP prompt decides for them.
    expect(applyDamage(creature({ hp: 7, hpMax: 30, isPC: false }), [p(40)]).massiveDeath).toBe(false);
  });

  it("damage at 0 HP: one death-save failure, two from a critical hit; massive at 0 if it reaches the maximum", () => {
    expect(applyDamage(creature({ hp: 0 }), [p(3)]).deathSaveFailures).toBe(1);
    expect(applyDamage(creature({ hp: 0 }), [p(3)], { crit: true }).deathSaveFailures).toBe(2);
    expect(applyDamage(creature({ hp: 0 }), [p(3)]).down).toBe(false);
    expect(applyDamage(creature({ hp: 0, hpMax: 20 }), [p(20)]).massiveDeath).toBe(true);
    // Soaked entirely by temporary HP, or immune: no failure.
    expect(applyDamage(creature({ hp: 0, hpTemp: 5 }), [p(3)]).deathSaveFailures).toBe(0);
    expect(applyDamage(creature({ hp: 0, immunities: ["fire"] }), [p(9, "fire")]).deathSaveFailures).toBe(0);
    expect(applyDamage(creature({ hp: 0, isPC: false }), [p(3)]).deathSaveFailures).toBe(0);
  });

  it("concentration: DC max(10, half the damage), at most 30, only when concentrating and damaged", () => {
    expect(concentrationDc(1)).toBe(10);
    expect(concentrationDc(21)).toBe(10);
    expect(concentrationDc(22)).toBe(11);
    expect(concentrationDc(45)).toBe(22);
    expect(concentrationDc(200)).toBe(30);
    // SRD 5.1 (p. 102) sets no cap (rules audit A12); 5.2.1's pack caps it.
    expect(concentrationDc(200, "srd-5.1")).toBe(100);
    expect(concentrationDc(200, "srd-5.2.1")).toBe(30);
    expect(
      applyDamage(creature({ concentrating: true, hp: 300, hpMax: 300 }), [p(90)], { rulesPack: "srd-5.1" })
        .concentrationDc,
    ).toBe(45);
    expect(applyDamage(creature({ concentrating: true }), [p(30)]).concentrationDc).toBe(15);
    // Damage the temp HP took is still damage taken.
    expect(applyDamage(creature({ concentrating: true, hpTemp: 10 }), [p(4)]).concentrationDc).toBe(10);
    expect(
      applyDamage(creature({ concentrating: true, immunities: ["fire"] }), [p(30, "fire")]).concentrationDc,
    ).toBeNull();
    expect(applyDamage(creature(), [p(30)]).concentrationDc).toBeNull();
  });
});

describe("healing and temporary HP (AC-HP-02, AC-HP-03)", () => {
  it("never past the maximum; from 0 it revives", () => {
    expect(applyHealing({ hp: 20, hpMax: 30 }, 8)).toEqual({ hp: 28, gained: 8, revived: false });
    expect(applyHealing({ hp: 25, hpMax: 30 }, 12)).toEqual({ hp: 30, gained: 5, revived: false });
    expect(applyHealing({ hp: 30, hpMax: 30 }, 5)).toEqual({ hp: 30, gained: 0, revived: false });
    expect(applyHealing({ hp: 0, hpMax: 30 }, 1)).toEqual({ hp: 1, gained: 1, revived: true });
    expect(applyHealing({ hp: 0, hpMax: 30 }, 0)).toEqual({ hp: 0, gained: 0, revived: false });
    // The dead regain nothing (SRD 5.2.1 p. 180: only magic that revives brings them back — rules audit A2).
    expect(applyHealing({ hp: 0, hpMax: 30 }, 7, true)).toEqual({ hp: 0, gained: 0, revived: false });
  });

  it("temp HP don't stack: keep or replace, the higher first", () => {
    expect(tempHpChoice(0, 8)).toBeNull();
    expect(tempHpChoice(5, 5)).toBeNull();
    expect(tempHpChoice(5, 8)).toEqual({ keep: 5, replace: 8, best: 8 });
    expect(tempHpChoice(9, 4)).toEqual({ keep: 9, replace: 4, best: 9 });
  });
});

describe("typed damage as written", () => {
  it("reads '12 slashing + 7 fire', a bare number, commas; refuses what isn't damage", () => {
    expect(parseDamage("12 slashing + 7 fire")).toEqual([p(12, "slashing"), p(7, "fire")]);
    expect(parseDamage("9")).toEqual([p(9)]);
    expect(parseDamage("5 Cold, 3 piercing")).toEqual([p(5, "cold"), p(3, "piercing")]);
    expect(parseDamage("4 sonic")).toBeNull();
    expect(parseDamage("fire")).toBeNull();
    expect(parseDamage("")).toBeNull();
  });
});
