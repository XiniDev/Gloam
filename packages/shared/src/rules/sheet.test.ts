import { describe, expect, it } from "vitest";
import { roll } from "../dice/evaluate.ts";
import { characterJsonSchema, Sheet } from "../schemas/sheet.ts";
import { deriveSheet, proficiencyFor, sheetRefs } from "./sheet.ts";

/** Appendix F.3's worked example. */
const thorin = () =>
  Sheet.parse({
    schemaVersion: 1,
    core: {
      name: "Thorin Emberhand",
      species: "Dwarf",
      classes: [{ name: "Fighter", level: 5, subclass: "Champion" }],
      abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 13, cha: 8 },
      saves: { str: { proficient: true }, con: { proficient: true } },
      skills: { athletics: { prof: "proficient" }, perception: { prof: "proficient" } },
      ac: { value: 18, note: "chain mail + shield" },
      speeds: { walk: 30 },
      hp: { max: 44, current: 44, temp: 0 },
      senses: { darkvision: 120 },
      attacks: [{ name: "Warhammer", attack: "1d20 + @str + @prof", damage: "1d8 + @str [bludgeoning]" }],
      inventory: [{ name: "Torch", qty: 5, weight: 1, light: "torch" }],
      currency: { gp: 100 },
    },
    custom: [{ id: "b1", type: "counter", title: "Sanity", value: 8, max: 10, pinToToken: true }],
  });

describe("derived sheet values (SPEC §8.10, AC-SHEET-02)", () => {
  it("proficiency bonus by level: 2 at 1–4, +1 every four levels", () => {
    expect([1, 4, 5, 8, 9, 12, 13, 16, 17, 20].map(proficiencyFor)).toEqual([2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  });

  it("works Thorin through: level, proficiency, modifiers, saves, skills, passives, initiative, carrying", () => {
    const d = deriveSheet(thorin().core).values;
    expect(d.level).toBe(5);
    expect(d.proficiencyBonus).toBe(3);
    expect([d["mod.str"], d["mod.dex"], d["mod.con"], d["mod.int"], d["mod.wis"], d["mod.cha"]]).toEqual([
      3, 1, 3, 0, 1, -1,
    ]);
    // Proficient in Strength and Constitution saves.
    expect(d["save.str"]).toBe(6);
    expect(d["save.con"]).toBe(6);
    expect(d["save.dex"]).toBe(1);
    expect(d["save.cha"]).toBe(-1);
    expect(d["skill.athletics"]).toBe(6);
    expect(d["skill.perception"]).toBe(4);
    expect(d["skill.stealth"]).toBe(1);
    expect(d["passive.perception"]).toBe(14);
    expect(d["passive.insight"]).toBe(11);
    expect(d.initiative).toBe(1);
    expect(d["carry.capacity"]).toBe(240);
    // No spellcasting: no DC.
    expect(d["spell.dc"]).toBe(0);
    // 5 torches at 1 lb and 100 gp at 50 to the pound.
    expect(deriveSheet(thorin().core).load).toBe(7);
  });

  it("half proficiency and expertise; bonuses; a caster's DC and attack; multiclass levels; size and carrying", () => {
    const core = Sheet.parse({
      core: {
        name: "Mira",
        classes: [
          { name: "Rogue", level: 3 },
          { name: "Wizard", level: 2 },
        ],
        abilities: { str: 8, dex: 16, con: 12, int: 17, wis: 10, cha: 14 },
        skills: {
          stealth: { prof: "expertise" },
          arcana: { prof: "proficient", bonus: 1 },
          history: { prof: "half" },
        },
        initiativeBonus: 2,
        size: "small",
        spellcasting: { ability: "int", slots: [{ level: 1, max: 3 }] },
      },
    }).core;
    const d = deriveSheet(core).values;
    expect(d.level).toBe(5);
    expect(d.proficiencyBonus).toBe(3);
    expect(d["skill.stealth"]).toBe(3 + 6);
    expect(d["skill.arcana"]).toBe(3 + 3 + 1);
    expect(d["skill.history"]).toBe(3 + 1);
    expect(d.initiative).toBe(5);
    expect(d["spell.dc"]).toBe(8 + 3 + 3);
    expect(d["spell.attack"]).toBe(6);
    expect(d["carry.capacity"]).toBe(120);
  });

  it("every derived value can be overridden and reverted — and an override is what everything downstream uses", () => {
    const core = thorin().core;
    core.overrides = { proficiencyBonus: 4, "mod.wis": 3, "passive.insight": 20 };
    const d = deriveSheet(core);
    expect(d.values.proficiencyBonus).toBe(4);
    expect(d.auto.proficiencyBonus).toBe(3);
    expect(d.values["save.con"]).toBe(3 + 4);
    expect(d.values["skill.perception"]).toBe(3 + 4);
    expect(d.values["passive.perception"]).toBe(17);
    expect(d.values["passive.insight"]).toBe(20);
    expect([...d.overridden].sort()).toEqual(["mod.wis", "passive.insight", "proficiencyBonus"]);
    // Revert: the key goes, and the computed values come back.
    core.overrides = {};
    const back = deriveSheet(core);
    expect(back.values.proficiencyBonus).toBe(3);
    expect(back.values["passive.insight"]).toBe(11);
    expect(back.overridden.size).toBe(0);
    // Any derived key can be overridden.
    for (const k of Object.keys(back.values) as (keyof typeof back.values)[]) {
      core.overrides = { [k]: 42 };
      expect(deriveSheet(core).values[k], k).toBe(42);
    }
  });

  it("dice formulas read the sheet: @str, @prof, @dex.save, @skill.stealth, @perception, @init, @level; unknown refs fail", () => {
    const refs = sheetRefs(thorin().core);
    const r = roll("1d20 + @str + @prof", { die: () => 10, resolve: refs });
    expect(r.total).toBe(10 + 3 + 3);
    expect(
      roll("@con.save + @skill.athletics + @perception + @init + @level", { die: () => 1, resolve: refs })
        .total,
    ).toBe(6 + 6 + 4 + 1 + 5);
    expect(() => roll("1d20 + @spellmod", { die: () => 1, resolve: refs })).toThrow();
    expect(() => roll("1d20 + @nonsense", { die: () => 1, resolve: refs })).toThrow();
  });
});

describe("the sheet document (Appendix F.3)", () => {
  it("parses the worked example; export → import round-trips", () => {
    const s = thorin();
    expect(Sheet.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
  it("rejects out-of-range and unknown input with readable paths", () => {
    const bad = Sheet.safeParse({ core: { name: "X", abilities: { str: 31 }, level: 3 } });
    expect(bad.success).toBe(false);
    const paths = bad.error?.issues.map((i) => i.path.join(".")) ?? [];
    expect(paths).toContain("core.abilities.str");
    expect(paths).toContain("core");
  });
  it("publishes a JSON Schema with every block type", () => {
    const js = JSON.stringify(characterJsonSchema());
    for (const t of ["text", "number", "counter", "checklist", "table", "keyValue", "image"])
      expect(js).toContain(`"${t}"`);
    expect(js).toContain("pinToToken");
  });
});

describe("the Import-with-AI prompt (Appendix F.3, AC-SHEET-07)", () => {
  it("is F.3's prompt with the published schema in place of its marker, and reads a fenced reply", async () => {
    const { CHARACTER_AI_PROMPT, CHARACTER_SCHEMA_MARKER, fillPrompt, jsonFromReply } = await import(
      "../schemas/prompts.ts"
    );
    const schema = characterJsonSchema();
    const text = fillPrompt(CHARACTER_AI_PROMPT, CHARACTER_SCHEMA_MARKER, schema);
    expect(text).not.toContain("{{");
    expect(text).toContain(JSON.stringify(schema, null, 2));
    for (const rule of [
      "Output ONLY one JSON object that validates against the JSON Schema below",
      "Never invent\n   values",
      "Put everything that doesn't fit",
      "Ability scores are the scores, not modifiers.",
      'Tag damage types in brackets, e.g. "1d8 + @str [slashing]".',
      "Keep names of spells, features and items exactly as written.",
      'List anything you were unsure about in "importNotes".',
    ])
      expect(text).toContain(rule);
    const reply = 'Here it is:\n```json\n{"core": {"name": "Mira"}}\n```';
    expect(Sheet.parse(JSON.parse(jsonFromReply(reply) as string)).core.name).toBe("Mira");
    expect(jsonFromReply("no json here")).toBeNull();
  });
});
