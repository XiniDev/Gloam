import { describe, expect, it } from "vitest";
import { EMPTY_STATUS, type TokenStatusT } from "../schemas/entities.ts";
import { Sheet } from "../schemas/sheet.ts";
import { applyRest, hitDieHealing, nextHitDie, restPlan } from "./rests.ts";

const sheet = (core: Record<string, unknown>) => Sheet.parse({ core: { name: "Thorin", ...core } });
const hurt = sheet({
  hp: { max: 40, current: 12, temp: 5 },
  hitDice: [
    { die: "d10", total: 5, used: 3 },
    { die: "d8", total: 1, used: 1 },
  ],
  features: [
    { name: "Second Wind", uses: { max: 1, used: 1, recharge: "short" } },
    { name: "Indomitable", uses: { max: 1, used: 1, recharge: "long" } },
    { name: "Lucky charm", uses: { max: 1, used: 1, recharge: "dawn" } },
  ],
  spellcasting: {
    ability: "wis",
    slots: [
      { level: 1, max: 4, used: 3 },
      { level: 2, max: 2, used: 1 },
    ],
    pact: { level: 1, max: 1, used: 1 },
    spells: [],
  },
});
const tired: TokenStatusT = {
  ...EMPTY_STATUS,
  exhaustion: 2,
  deathSaves: { successes: 1, failures: 1, stable: false, dead: false },
  markers: [{ id: "bloodied" }],
};

describe("rests (§8.11, §34.2; SRD 5.2.1 pp. 185, 187; AC-HP-13)", () => {
  it("a long rest: all HP, all spent Hit Dice, slots, pact slots, short- and long-rest uses, Exhaustion −1, temp HP gone, death saves cleared", () => {
    const plan = restPlan(hurt, tired, "long", "srd-5.2.1");
    expect(plan.items).toEqual([
      { key: "hp", label: "HP 12 → 40" },
      { key: "hitDice", label: "Hit Dice back: 3 d10, 1 d8" },
      { key: "slots", label: "Spell slots back: 4" },
      { key: "pact", label: "Pact slots back: 1" },
      { key: "features", label: "Uses back: Second Wind, Indomitable" },
      { key: "exhaustion", label: "Exhaustion 2 → 1" },
      { key: "tempHp", label: "Temporary HP 5 → 0" },
      { key: "deathSaves", label: "Death saves cleared" },
    ]);
    const { sheet: s, status } = applyRest(
      hurt,
      tired,
      "long",
      "srd-5.2.1",
      plan.items.map((i) => i.key),
    );
    expect(s.core.hp).toEqual({ max: 40, current: 40, temp: 0 });
    expect(s.core.hitDice.map((d) => d.used)).toEqual([0, 0]);
    expect(s.core.spellcasting?.slots.map((x) => x.used)).toEqual([0, 0]);
    expect(s.core.spellcasting?.pact?.used).toBe(0);
    expect(s.core.features.map((f) => f.uses?.used)).toEqual([0, 0, 1]);
    expect(status.exhaustion).toBe(1);
    expect(status.deathSaves).toBeUndefined();
  });

  it("the DM unticks what it shouldn't give (only the items kept apply)", () => {
    const { sheet: s, status } = applyRest(hurt, tired, "long", "srd-5.2.1", ["hp", "slots"]);
    expect(s.core.hp.current).toBe(40);
    expect(s.core.hp.temp).toBe(5);
    expect(s.core.hitDice.map((d) => d.used)).toEqual([3, 1]);
    expect(status.exhaustion).toBe(2);
  });

  it("SRD 5.1: a long rest gives back spent Hit Dice up to half the total, at least one", () => {
    // 6 dice in all: up to 3 back (the largest first).
    expect(restPlan(hurt, tired, "long", "srd-5.1").items.find((i) => i.key === "hitDice")?.label).toBe(
      "Hit Dice back: 3 d10",
    );
  });

  it("a short rest: short-rest uses and pact slots back, Hit Dice to spend on the player's cards", () => {
    expect(restPlan(hurt, tired, "short", "srd-5.2.1").items).toEqual([
      { key: "hitDiceCards", label: "Hit Dice to spend: 2 (on the player's cards)" },
      { key: "pact", label: "Pact slots back: 1" },
      { key: "features", label: "Uses back: Second Wind" },
    ]);
    const { sheet: s } = applyRest(hurt, tired, "short", "srd-5.2.1", ["pact", "features"]);
    expect(s.core.features.map((f) => f.uses?.used)).toEqual([0, 1, 1]);
    expect(s.core.hp.current).toBe(12);
  });

  it("no rest at 0 HP; the next Hit Die to spend is the largest left; each heals at least 1", () => {
    expect(restPlan(sheet({ hp: { max: 20, current: 0 } }), EMPTY_STATUS, "long", "srd-5.2.1")).toEqual({
      blocked: "At 0 HP — it needs at least 1 HP to rest",
      items: [],
    });
    expect(nextHitDie(hurt)).toEqual({ die: "d10", left: 2 });
    expect(
      nextHitDie(sheet({ hp: { max: 20, current: 20 }, hitDice: [{ die: "d8", total: 2 }] })),
    ).toBeNull();
    expect(hitDieHealing(-1)).toBe(1);
    expect(hitDieHealing(9)).toBe(9);
  });
});
