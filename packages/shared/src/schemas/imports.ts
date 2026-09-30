import { z } from "zod";
import {
  Ability,
  ConditionId,
  DamageType,
  Formula,
  Ft,
  LongText,
  ShortText,
  Size,
  SkillId,
  Slug,
} from "./common.ts";
import { AbilityScores, characterJsonSchema, SheetAttack, SheetFeature } from "./sheet.ts";
import { SpellSchema } from "./spell.ts";

/**
 * The import formats besides spells and sheets (SPEC §8.23, §26.1, Appendix F): a homebrew monster (F.4), an item, a
 * handout and a campaign log entry. Strict like every import (F.1): an unknown field is an error, so an AI given the
 * schema can't slip in something the table would silently drop.
 */

const Int = (min: number, max: number) => z.number().int().min(min).max(max);
const Id = z.string().min(1).max(40);
/** Challenge ratings of fifth edition: 0, 1/8, 1/4, 1/2, 1–30. */
const CR = z
  .string()
  .regex(/^(0|1\/8|1\/4|1\/2|[1-9]|[12][0-9]|30)$/, "a challenge rating: 0, 1/8, 1/4, 1/2 or 1–30");

/** A homebrew bestiary entry (Appendix F.4): imported as an NPC sheet the Bestiary places, each copy its own HP. */
export const MonsterSchema = z
  .object({
    id: Slug,
    name: ShortText.min(1),
    size: Size,
    /** Its creature type ("monstrosity", "undead"…). */
    type: ShortText.min(1),
    alignment: ShortText.optional(),
    ac: Int(0, 99),
    /** What its AC is from ("natural armor"). */
    acNote: ShortText.optional(),
    hp: z.object({ average: Int(1, 99_999), formula: Formula.optional() }).strict(),
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
    senses: z
      .object({
        darkvision: Ft.default(0),
        blindsight: Ft.default(0),
        tremorsense: Ft.default(0),
        truesight: Ft.default(0),
      })
      .strict()
      .default({ darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0 }),
    abilities: AbilityScores,
    /** Saving throws it's better at: the whole bonus (Con +5 → `{ "con": 5 }`). */
    saves: z.partialRecord(Ability, Int(-20, 30)).default({}),
    /** Skills it's better at: the whole bonus. */
    skills: z.partialRecord(SkillId, Int(-20, 30)).default({}),
    resistances: z.array(DamageType).max(13).default([]),
    immunities: z.array(DamageType).max(13).default([]),
    vulnerabilities: z.array(DamageType).max(13).default([]),
    conditionImmunities: z.array(ConditionId).max(20).default([]),
    languages: z.array(ShortText).max(50).default([]),
    cr: CR,
    /** Its attacks, rolled from its sheet ("1d20 + 6", "2d8 + 4 [piercing]"). */
    attacks: z.array(SheetAttack).max(30).default([]),
    /** Traits, actions, reactions and legendary actions in words. */
    features: z.array(SheetFeature).max(60).default([]),
    /** The stat block as written, for the DM to read. */
    statBlockMarkdown: LongText.default(""),
    /** Token art already uploaded to the campaign. */
    tokenAssetId: Id.nullable().default(null),
    source: z
      .object({ pack: ShortText.min(1) })
      .strict()
      .default({ pack: "homebrew" }),
  })
  .strict();
export type Monster = z.infer<typeof MonsterSchema>;

/** An item (for a sheet's inventory, a treasure list, an AI's loot table). */
export const ItemSchema = z
  .object({
    id: Slug,
    name: ShortText.min(1),
    kind: z.enum(["weapon", "armor", "gear", "consumable", "magic", "treasure"]).default("gear"),
    rarity: z.enum(["common", "uncommon", "rare", "very rare", "legendary", "artifact"]).optional(),
    /** Pounds. */
    weight: z.number().finite().min(0).max(10_000).default(0),
    /** As written ("15 gp"). */
    cost: ShortText.optional(),
    attunement: z.boolean().default(false),
    description: LongText.default(""),
    /** A weapon's attack, as a sheet rolls it. */
    attack: SheetAttack.optional(),
    /** A light source it can be (a light preset id, e.g. "torch"). */
    light: ShortText.optional(),
    source: z
      .object({ pack: ShortText.min(1) })
      .strict()
      .default({ pack: "homebrew" }),
  })
  .strict();
export type Item = z.infer<typeof ItemSchema>;

/** A handout (SPEC §8.18): a draft until the DM shows it. */
export const HandoutSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    /** Markdown. */
    bodyMd: z.string().max(20_000).default(""),
    imageAssetId: Id.nullable().default(null),
  })
  .strict();
export type HandoutImport = z.infer<typeof HandoutSchema>;

/** An entry for the campaign log (SPEC §8.18): a recap, a note to the party. */
export const CampaignLogEntrySchema = z
  .object({
    text: z.string().trim().min(1).max(4000),
    kind: z.enum(["recap", "note"]).default("recap"),
  })
  .strict();
export type CampaignLogEntryImport = z.infer<typeof CampaignLogEntrySchema>;

/** Every published import schema by its name in `/api/v1/schemas/<name>.json`. */
export const IMPORT_SCHEMA_NAMES = [
  "spell",
  "character",
  "monster",
  "item",
  "handout",
  "campaign-log-entry",
] as const;
export type ImportSchemaName = (typeof IMPORT_SCHEMA_NAMES)[number];

const SCHEMAS: Record<Exclude<ImportSchemaName, "character">, z.ZodType> = {
  spell: SpellSchema,
  monster: MonsterSchema,
  item: ItemSchema,
  handout: HandoutSchema,
  "campaign-log-entry": CampaignLogEntrySchema,
};

/**
 * The JSON Schema (draft 2020-12) of an import format, generated from its zod schema — of what may be sent: defaults
 * may be left out. The published files (`docs/schemas/`) are these, regenerated and compared by a test.
 */
export function importJsonSchema(name: ImportSchemaName): Record<string, unknown> {
  if (name === "character") return characterJsonSchema();
  return z.toJSONSchema(SCHEMAS[name], {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}
