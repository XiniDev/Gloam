import { z } from "zod";
import { SKILL_IDS } from "../constants.ts";
import { Ability, ConditionId, DamageType, Formula, Ft, LongText, ShortText, Size } from "./common.ts";

/**
 * The character sheet document (SPEC §8.10, §12.3, Appendix F.3): `actors.sheet_json`. Two layers — **core**, the
 * fifth-edition numbers automation reads, and **custom** blocks for everything homebrew — plus the overrides of
 * derived values. Everything is bounded so an import (or an AI reply) can't smuggle in absurd values. The published
 * JSON Schema (`/api/v1/schemas/character.json`, and the Import-with-AI prompt) is generated from this.
 */

const Int = (min: number, max: number) => z.number().int().min(min).max(max);
const Id = z.string().min(1).max(40);

export const PROFICIENCY_LEVELS = ["none", "half", "proficient", "expertise"] as const;
export const ProficiencyLevel = z.enum(PROFICIENCY_LEVELS);
export type ProficiencyLevel = z.infer<typeof ProficiencyLevel>;

export const RECHARGES = ["short", "long", "dawn", "none"] as const;
export const Uses = z
  .object({ max: Int(0, 999), used: Int(0, 999).default(0), recharge: z.enum(RECHARGES).default("long") })
  .strict();

export const HIT_DIE_TYPES = ["d6", "d8", "d10", "d12"] as const;

export const SheetClass = z
  .object({ name: ShortText.min(1), level: Int(1, 20), subclass: ShortText.optional() })
  .strict();

export const SheetAttack = z
  .object({
    name: ShortText.min(1),
    /** e.g. "1d20 + @str + @prof" */
    attack: Formula.optional(),
    /** e.g. "1d8 + @str [slashing]" — a trailing tag types every untagged term (§18.1). */
    damage: Formula.optional(),
    range: ShortText.optional(),
    properties: ShortText.optional(),
  })
  .strict();

export const SheetSpell = z
  .object({
    name: ShortText.min(1),
    level: Int(0, 9),
    prepared: z.boolean().default(false),
    /** The spell's content id, when it's in the campaign's spell list. */
    contentId: Id.optional(),
  })
  .strict();

export const SheetItem = z
  .object({
    name: ShortText.min(1),
    qty: Int(0, 99_999).default(1),
    /** Pounds, each. */
    weight: z.number().finite().min(0).max(10_000).default(0),
    equipped: z.boolean().default(false),
    attuned: z.boolean().default(false),
    notes: ShortText.optional(),
    /** A light source it can be (a light preset id, e.g. "torch"). */
    light: ShortText.optional(),
  })
  .strict();

export const SheetFeature = z
  .object({ name: ShortText.min(1), text: LongText.default(""), uses: Uses.optional() })
  .strict();

const Bonus = Int(-99, 99);
const AbilityScores = z
  .object({
    str: Int(1, 30).default(10),
    dex: Int(1, 30).default(10),
    con: Int(1, 30).default(10),
    int: Int(1, 30).default(10),
    wis: Int(1, 30).default(10),
    cha: Int(1, 30).default(10),
  })
  .strict();

const SaveEntry = z.object({ proficient: z.boolean().default(false), bonus: Bonus.optional() }).strict();
const SkillEntry = z.object({ prof: ProficiencyLevel.default("none"), bonus: Bonus.optional() }).strict();

export const Spellcasting = z
  .object({
    ability: Ability,
    /** Slots by spell level (1–9): how many, and how many used. */
    slots: z
      .array(z.object({ level: Int(1, 9), max: Int(0, 9), used: Int(0, 9).default(0) }).strict())
      .max(9)
      .default([]),
    pact: z
      .object({ level: Int(1, 9), max: Int(0, 9), used: Int(0, 9).default(0) })
      .strict()
      .optional(),
    spells: z.array(SheetSpell).max(500).default([]),
  })
  .strict();

/** Every derived value (SPEC §8.10 Derived values), by key: each can be overridden and reverted. */
export const DERIVED_KEYS = [
  "level",
  "proficiencyBonus",
  "initiative",
  "passive.perception",
  "passive.investigation",
  "passive.insight",
  "spell.dc",
  "spell.attack",
  "carry.capacity",
  ...(["str", "dex", "con", "int", "wis", "cha"] as const).map((a) => `mod.${a}` as const),
  ...(["str", "dex", "con", "int", "wis", "cha"] as const).map((a) => `save.${a}` as const),
  ...SKILL_IDS.map((s) => `skill.${s}` as const),
] as const;
export type DerivedKey = (typeof DERIVED_KEYS)[number];

export const SheetCore = z
  .object({
    name: ShortText.min(1),
    portraitAssetId: Id.optional(),
    tokenAssetId: Id.optional(),
    species: ShortText.optional(),
    background: ShortText.optional(),
    alignment: ShortText.optional(),
    classes: z.array(SheetClass).max(12).default([]),
    xp: Int(0, 10_000_000).default(0),
    abilities: AbilityScores.default({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }),
    saves: z.partialRecord(Ability, SaveEntry).default({}),
    skills: z.partialRecord(z.enum(SKILL_IDS as [string, ...string[]]), SkillEntry).default({}),
    ac: z
      .object({ value: Int(0, 99), note: ShortText.optional() })
      .strict()
      .default({ value: 10 }),
    /** Extra initiative bonus on top of the Dexterity modifier. */
    initiativeBonus: Bonus.default(0),
    speeds: z
      .object({
        walk: Ft.default(30),
        fly: Ft.default(0),
        swim: Ft.default(0),
        climb: Ft.default(0),
        burrow: Ft.default(0),
        hover: z.boolean().default(false),
      })
      .strict()
      .default({ walk: 30, fly: 0, swim: 0, climb: 0, burrow: 0, hover: false }),
    size: Size.default("medium"),
    hp: z
      .object({ max: Int(0, 99_999), current: Int(-99_999, 99_999), temp: Int(0, 99_999).default(0) })
      .strict()
      .default({ max: 10, current: 10, temp: 0 }),
    hitDice: z
      .array(
        z.object({ die: z.enum(HIT_DIE_TYPES), total: Int(0, 99), used: Int(0, 99).default(0) }).strict(),
      )
      .max(8)
      .default([]),
    deathSaves: z
      .object({ successes: Int(0, 3).default(0), failures: Int(0, 3).default(0) })
      .strict()
      .default({ successes: 0, failures: 0 }),
    senses: z
      .object({
        darkvision: Ft.default(0),
        blindsight: Ft.default(0),
        tremorsense: Ft.default(0),
        truesight: Ft.default(0),
      })
      .strict()
      .default({ darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0 }),
    resistances: z.array(DamageType).max(13).default([]),
    immunities: z.array(DamageType).max(13).default([]),
    vulnerabilities: z.array(DamageType).max(13).default([]),
    conditionImmunities: z.array(ConditionId).max(20).default([]),
    conditions: z.array(ConditionId).max(20).default([]),
    exhaustion: Int(0, 6).default(0),
    inspiration: z.boolean().default(false),
    /** What the character is concentrating on (a spell or effect name), if anything. */
    concentration: ShortText.optional(),
    spellcasting: Spellcasting.nullable().default(null),
    attacks: z.array(SheetAttack).max(100).default([]),
    /** The light source carried (a light preset id), if any. */
    light: ShortText.optional(),
    currency: z
      .object({
        cp: Int(0, 99_999_999).default(0),
        sp: Int(0, 99_999_999).default(0),
        ep: Int(0, 99_999_999).default(0),
        gp: Int(0, 99_999_999).default(0),
        pp: Int(0, 99_999_999).default(0),
      })
      .strict()
      .default({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }),
    inventory: z.array(SheetItem).max(500).default([]),
    features: z.array(SheetFeature).max(200).default([]),
    languages: z.array(ShortText).max(50).default([]),
    proficiencies: z.array(ShortText).max(100).default([]),
    notes: LongText.default(""),
    /** Derived values set by hand (an override badge shows; reverting removes the key). */
    overrides: z.partialRecord(z.enum(DERIVED_KEYS), z.number().int().min(-999).max(9_999)).default({}),
  })
  .strict();
export type SheetCore = z.infer<typeof SheetCore>;

const BlockBase = { id: Id, title: ShortText.default("") };
/** Custom blocks (§8.10 Structure 2): seven types, for everything that doesn't fit the standard shape. */
export const CustomBlock = z.discriminatedUnion("type", [
  z.object({ ...BlockBase, type: z.literal("text"), markdown: LongText.default("") }).strict(),
  z.object({ ...BlockBase, type: z.literal("number"), value: z.number().finite().default(0) }).strict(),
  z
    .object({
      ...BlockBase,
      type: z.literal("counter"),
      value: Int(-99_999, 99_999).default(0),
      max: Int(0, 99_999).default(0),
      /** Shown on the token as a thin extra bar under the HP bar. */
      pinToToken: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...BlockBase,
      type: z.literal("checklist"),
      items: z
        .array(z.object({ label: ShortText, done: z.boolean().default(false) }).strict())
        .max(200)
        .default([]),
    })
    .strict(),
  z
    .object({
      ...BlockBase,
      type: z.literal("table"),
      columns: z.array(ShortText).max(12).default([]),
      rows: z.array(z.array(ShortText).max(12)).max(200).default([]),
    })
    .strict(),
  z
    .object({
      ...BlockBase,
      type: z.literal("keyValue"),
      entries: z
        .array(z.object({ key: ShortText, value: ShortText }).strict())
        .max(200)
        .default([]),
    })
    .strict(),
  z.object({ ...BlockBase, type: z.literal("image"), assetId: Id.optional() }).strict(),
]);
export type CustomBlock = z.infer<typeof CustomBlock>;
export const CUSTOM_BLOCK_TYPES = [
  "text",
  "number",
  "counter",
  "checklist",
  "table",
  "keyValue",
  "image",
] as const;

export const Sheet = z
  .object({
    schemaVersion: z.literal(1).default(1),
    core: SheetCore,
    custom: z.array(CustomBlock).max(100).default([]),
    /** Anything an import was unsure about (Appendix F.3 rule 6). */
    importNotes: z.array(ShortText).max(50).optional(),
  })
  .strict();
export type Sheet = z.infer<typeof Sheet>;

/** The published JSON Schema of the sheet document (`/api/v1/schemas/character.json`; embedded in the AI prompt). */
export function characterJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Sheet, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}
