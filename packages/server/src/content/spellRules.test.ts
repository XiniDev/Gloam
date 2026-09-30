import {
  addDice,
  areaAtSlot,
  areaText,
  attackRangeFt,
  castArea,
  critFormula,
  critMaxFormula,
  defaultSlot,
  durationRounds,
  durationText,
  levelSchool,
  normalRangeFt,
  rangeText,
  repeatTargets,
  saveOutcome,
  scaledFormula,
  slotOptions,
  spellMatches,
  spellRank,
  targetCount,
  targetingKind,
} from "@gloam/shared/rules";
import type { Spell } from "@gloam/shared/schemas";
import { describe, expect, it } from "vitest";
import { loadSrdPack } from "./packs.ts";

const SRD: Spell[] = loadSrdPack().spells;
const spell = (id: string): Spell => {
  const s = SRD.find((x) => x.id === id);
  if (!s) throw new Error(`no ${id}`);
  return s;
};

describe("spells at the table (§8.13)", () => {
  it("the slots a spell can take: every level at or above it with one left, the pact's too, lowest first", () => {
    const sc = {
      ability: "int" as const,
      slots: [
        { level: 1, max: 4, used: 4 },
        { level: 2, max: 3, used: 1 },
        { level: 3, max: 2, used: 0 },
      ],
      pact: { level: 2, max: 2, used: 0 },
      spells: [],
    };
    const opts = slotOptions({ level: 2 }, sc);
    expect(opts).toEqual([
      { level: 2, kind: "slot", left: 2 },
      { level: 2, kind: "pact", left: 2 },
      { level: 3, kind: "slot", left: 2 },
    ]);
    expect(defaultSlot(opts)).toEqual({ level: 2, kind: "slot", left: 2 });
    // First-level slots are spent: a 1st-level spell goes up to the lowest left.
    expect(defaultSlot(slotOptions({ level: 1 }, sc))?.level).toBe(2);
    expect(slotOptions({ level: 0 }, sc)).toEqual([]);
    expect(slotOptions({ level: 4 }, sc)).toEqual([]);
  });

  it("upcasting adds the per-level dice; cantrips grow at 5, 11 and 17; a critical hit doubles the dice", () => {
    const fb = spell("fireball");
    const dmg = fb.damage?.[0];
    expect(scaledFormula(dmg?.formula ?? "", dmg?.scaling, 3, 3, 5)).toBe("8d6");
    expect(scaledFormula(dmg?.formula ?? "", dmg?.scaling, 3, 5, 9)).toBe("10d6");
    const cw = spell("cure-wounds").healing;
    expect(scaledFormula(cw?.formula ?? "", cw?.scaling, 1, 2, 3)).toBe("4d8 + @spellmod");
    const bolt = spell("fire-bolt").damage?.[0];
    expect(
      [4, 5, 10, 11, 17, 20].map((lvl) => scaledFormula(bolt?.formula ?? "", bolt?.scaling, 0, null, lvl)),
    ).toEqual(["1d10", "2d10", "2d10", "3d10", "4d10", "4d10"]);
    expect(addDice("1d4 + 1", "1d4 + 1", 2)).toBe("3d4 + 3");
    expect(addDice("2d6 - 1", "1d8", 1)).toBe("2d6 + 1d8 - 1");
    expect(critFormula("2d6 + 3")).toBe("4d6 + 3");
    expect(critFormula("1d8 + 1d6 + @str")).toBe("2d8 + 2d6 + @str");
    // The "maximum plus a roll" house rule (§19.6): the dice as rolled, plus their maximum.
    expect(critMaxFormula("2d6 + 3")).toBe("2d6 + 3 + 12");
    expect(critMaxFormula("1d8 + 1d6 [fire]")).toBe("1d8 + 1d6 + 14 [fire]");
  });

  it("targets per slot (Hold Person +1 a level), repeated picks for darts and rays, and the targeting each spell takes", () => {
    expect(targetCount(spell("hold-person"), 2)).toBe(1);
    expect(targetCount(spell("hold-person"), 4)).toBe(3);
    expect(targetCount(spell("magic-missile"), 3)).toBe(5);
    expect(repeatTargets(spell("magic-missile"))).toBe(true);
    expect(repeatTargets(spell("hold-person"))).toBe(false);
    expect(targetingKind(spell("fireball"))).toBe("area");
    expect(targetingKind(spell("fire-bolt"))).toBe("creatures");
    expect(targetingKind(spell("spirit-guardians"))).toBe("area");
    expect(targetingKind(spell("see-invisibility"))).toBe("self");
  });

  it("areas grow with the slot (Fog Cloud +20 ft a level); durations in rounds; a save's outcome", () => {
    const fog = spell("fog-cloud");
    expect(fog.area && areaText(areaAtSlot(fog.area, 1, 3))).toBe("60-ft-radius sphere");
    expect(durationRounds(spell("hold-person").duration)).toBe(10);
    expect(durationRounds(spell("spirit-guardians").duration)).toBe(100);
    expect(durationRounds(spell("fireball").duration)).toBe(0);
    expect(durationText(spell("hold-person").duration)).toBe("Concentration, up to 1 minute");
    expect(rangeText(spell("fireball").range)).toBe("150 feet");
    expect(levelSchool(spell("fireball"))).toBe("3rd-level evocation");
    expect(levelSchool(spell("fire-bolt"))).toBe("Evocation cantrip");
    expect(saveOutcome("half", true)).toBe("half");
    expect(saveOutcome("half", false)).toBe("full");
    expect(saveOutcome("none", true)).toBe("none");
    expect(saveOutcome("half", null)).toBe("full");
    // A "special" save is for something else (Heat Metal's grip, Searing Smite's burning): the damage stands.
    expect(saveOutcome("special", true)).toBe("full");
  });

  it("the browser's filters (AC-SPL-02): level, school, class, casting time, concentration, ritual, damage type, save, shape, source, words", () => {
    const ids = (f: Parameters<typeof spellMatches>[1]) =>
      SRD.filter((s) => spellMatches(s, f)).map((s) => s.id);
    const fire3 = ids({ levels: [3], schools: ["evocation"], damageTypes: ["fire"] });
    expect(fire3).toContain("fireball");
    expect(fire3.every((id) => spell(id).level === 3)).toBe(true);
    expect(ids({ castingTime: ["reaction"] })).toContain("shield");
    expect(ids({ castingTime: ["reaction"] }).every((id) => spell(id).castingTime.unit === "reaction")).toBe(
      true,
    );
    expect(ids({ ritual: true })).toContain("detect-magic");
    expect(ids({ ritual: true }).every((id) => spell(id).ritual)).toBe(true);
    expect(ids({ concentration: true })).toContain("hold-person");
    expect(ids({ concentration: true })).not.toContain("fireball");
    expect(ids({ saves: ["dex"], shapes: ["sphere"] })).toContain("fireball");
    expect(ids({ shapes: ["cone"] })).toContain("burning-hands");
    expect(ids({ shapes: ["emanation"] })).toContain("spirit-guardians");
    expect(ids({ classes: ["druid"] })).toContain("moonbeam");
    expect(ids({ classes: ["druid"] })).not.toContain("fireball");
    expect(ids({ source: "homebrew" })).toEqual([]);
    expect(ids({ source: "srd" })).toHaveLength(339);
    expect(ids({ q: "fire ball" })).toContain("fireball");
    // Names first: "Fire" ranks Fire Bolt before a spell that only mentions fire in its text.
    const q = ids({ q: "fire" }).sort((a, b) => spellRank(spell(a), "fire") - spellRank(spell(b), "fire"));
    // Every spell named "Fire…" comes before every spell that has fire only inside its name or its text.
    const lead = q.findIndex((id) => !spell(id).name.toLowerCase().startsWith("fire"));
    expect(lead).toBeGreaterThan(0);
    expect(q.slice(lead).some((id) => spell(id).name.toLowerCase().startsWith("fire"))).toBe(false);
    expect(spellRank(spell("fire-bolt"), "fire")).toBeLessThan(spellRank(spell("burning-hands"), "fire"));
  });
});

describe("sheet attacks and strikes", () => {
  it("an attack's reach from its range as written: normal/long takes the long, a number its feet, nothing 5 ft", () => {
    expect(attackRangeFt("20/60")).toBe(60);
    expect(attackRangeFt("80/320 ft")).toBe(320);
    // Its normal range where it has a long one: past it, Disadvantage (rules audit C6); none written, none.
    expect(normalRangeFt("80/320 ft")).toBe(80);
    expect(normalRangeFt("120 ft")).toBeUndefined();
    expect(normalRangeFt(undefined)).toBeUndefined();
    expect(attackRangeFt("120 ft")).toBe(120);
    expect(attackRangeFt("reach 10 ft")).toBe(10);
    expect(attackRangeFt("30")).toBe(30);
    expect(attackRangeFt(undefined)).toBe(5);
    expect(attackRangeFt("Melee")).toBe(5);
  });

  it("the area a cast targets: Call Lightning's bolt (5 ft) under its 60-ft cloud; otherwise the spell's area, or its other form's", () => {
    expect(castArea(spell("call-lightning"))).toEqual({ shape: "sphere", radius: 5 });
    expect(spell("call-lightning").area).toEqual({ shape: "cylinder", radius: 60, height: 10 });
    expect(castArea(spell("fireball"))).toEqual(spell("fireball").area);
    const dark = spell("darkness");
    expect(castArea(dark, 0)).toEqual(dark.areaAlternatives?.[0]?.area);
  });
});
