import { describe, expect, it } from "vitest";
import { DERIVED_KEYS } from "../schemas/sheet.ts";
import { derivedName, fieldLabel, skillName } from "./names.ts";

describe("sheet names on screen (a proposal's diff, AC-SHEET-05)", () => {
  it("skills and derived numbers read as the sheet prints them", () => {
    expect(skillName("sleightOfHand")).toBe("Sleight of Hand");
    expect(skillName("animalHandling")).toBe("Animal Handling");
    expect(derivedName("skill.perception")).toBe("Perception");
    expect(derivedName("passive.investigation")).toBe("Passive Investigation");
    expect(derivedName("mod.str")).toBe("Strength modifier");
    expect(derivedName("save.wis")).toBe("Wisdom save");
    expect(derivedName("spell.dc")).toBe("Spell save DC");
    expect(derivedName("carry.capacity")).toBe("Carrying capacity");
    // Every derived key has a name of its own (none falls through to a raw key).
    for (const k of DERIVED_KEYS) expect(derivedName(k), k).not.toMatch(/\./);
  });

  it("a changed field goes by its name, never its JSON path", () => {
    expect(fieldLabel(["core", "ac", "value"])).toBe("AC");
    expect(fieldLabel(["core", "hp", "max"])).toBe("Max HP");
    expect(fieldLabel(["core", "hp", "current"])).toBe("HP");
    expect(fieldLabel(["core", "abilities", "wis"])).toBe("Wisdom score");
    expect(fieldLabel(["core", "skills", "perception"])).toBe("Perception proficiency");
    expect(fieldLabel(["core", "saves", "dex", "proficient"])).toBe("Dexterity save proficiency");
    expect(fieldLabel(["core", "speeds", "walk"])).toBe("Walk speed");
    expect(fieldLabel(["core", "senses", "darkvision"])).toBe("Darkvision");
    expect(fieldLabel(["core", "overrides", "skill.perception"])).toBe("Perception (set by hand)");
    expect(fieldLabel(["core", "classes", 0, "level"])).toBe("Class 1 level");
    expect(fieldLabel(["core", "initiativeBonus"])).toBe("Initiative bonus");
    expect(fieldLabel(["core", "notes"])).toBe("Notes");
    const sheet = { custom: [{ title: "Oath" }, { title: "Sanity" }] };
    expect(fieldLabel(["custom", 1, "value"], sheet)).toBe("Sanity value");
    expect(fieldLabel(["custom", 0], sheet)).toBe("Oath");
    expect(fieldLabel(["custom", 4, "max"])).toBe("Custom block 5 max");
    expect(fieldLabel(["custom"])).toBe("Custom blocks");
  });
});
