import { z } from "zod";
import {
  Ability,
  ConditionId,
  DamageType,
  Formula,
  Ft,
  LongText,
  ShortText,
  Slug,
  SpellSchool,
  VfxPreset,
} from "./common.ts";

/**
 * Normalised spell record (SPEC §33.3, Appendix F.2). Strict: unknown fields are rejected so imports
 * fail loudly instead of silently dropping data.
 */

/** Growth of the area's primary dimension per slot level above the spell's level (e.g. Fog Cloud +20 ft). */
export const AreaScaling = z
  .object({
    perSlot: Ft.describe(
      "Feet added to the primary dimension (radius, length, size, distance) per slot level above the spell's level",
    ),
  })
  .strict();

export const SpellArea = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("sphere"), radius: Ft, scaling: AreaScaling.optional() }).strict(),
  z
    .object({ shape: z.literal("cylinder"), radius: Ft, height: Ft, scaling: AreaScaling.optional() })
    .strict(),
  z.object({ shape: z.literal("cone"), length: Ft, scaling: AreaScaling.optional() }).strict(),
  z.object({ shape: z.literal("cube"), size: Ft, scaling: AreaScaling.optional() }).strict(),
  z
    .object({
      shape: z.literal("line"),
      length: Ft,
      width: Ft.default(5),
      scaling: AreaScaling.optional(),
    })
    .strict(),
  z.object({ shape: z.literal("emanation"), distance: Ft, scaling: AreaScaling.optional() }).strict(),
  z
    .object({
      shape: z.literal("wall"),
      length: Ft,
      height: Ft,
      thickness: Ft,
      ring: Ft.optional().describe("Diameter in feet when the wall can be shaped as a ring"),
      ringHeight: Ft.optional().describe(
        "Height in feet of the ring form when it differs from `height` (Wall of Thorns: 10 ft straight, 20 ft ring)",
      ),
      opaque: z.boolean().default(false),
      blocksMove: z.boolean().default(false),
      damagingSide: z.enum(["left", "right", "both"]).optional(),
      scaling: AreaScaling.optional(),
    })
    .strict(),
]);
export type SpellArea = z.infer<typeof SpellArea>;

export const DamageScaling = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("slot"), perLevel: Formula }).strict(),
  z
    .object({
      mode: z.literal("cantrip"),
      atLevels: z.record(z.enum(["5", "11", "17"]), Formula),
    })
    .strict(),
]);
export type DamageScaling = z.infer<typeof DamageScaling>;

export const SpellDamage = z
  .object({
    formula: Formula,
    type: DamageType,
    typeOptions: z
      .array(DamageType)
      .min(2)
      .max(13)
      .optional()
      .describe(
        "The damage is one of these types, chosen when casting or determined as the text says (Chromatic Orb, Dragon's Breath, Prismatic Spray's ray roll); `type` is the default",
      ),
    scaling: DamageScaling.optional(),
    on: z
      .enum(["hit", "save"])
      .optional()
      .describe(
        "In a spell with both an attack and a save (Ice Knife), what this damage rides on: the attack's hit, or the save (with `splash`)",
      ),
  })
  .strict();

export const SpellHealing = z.object({ formula: Formula, scaling: DamageScaling.optional() }).strict();

export const SpellSave = z
  .object({
    ability: Ability,
    onSuccess: z.enum(["half", "none", "special"]),
    ignoresCover: z
      .literal(true)
      .optional()
      .describe(
        "The target gains no benefit from Half Cover or Three-Quarters Cover for this save (Sacred Flame); Total Cover still keeps it from being targeted",
      ),
  })
  .strict();

export const SpellConditionApplied = z
  .object({
    id: ConditionId,
    onFailedSave: z.boolean().default(true),
    choice: z
      .string()
      .max(20)
      .optional()
      .describe(
        'A group of alternatives: the spell imposes one of them (Blindness/Deafness: "your choice"). The card ticks the group\'s first; the DM picks another',
      ),
    stage: z
      .number()
      .int()
      .min(2)
      .max(9)
      .optional()
      .describe(
        "A later stage, not landed on the first failed save (Sleep's Unconscious on a second failure, Flesh to Stone's Petrified after the third): the DM ticks it when it comes",
      ),
    pick: z
      .boolean()
      .optional()
      .describe(
        "The DM judges whether it applies (Divine Word by the creature's Hit Points, a Prismatic Spray's ray): unticked on the card",
      ),
    duration: z
      .object({
        rounds: z.number().int().min(1).max(100_000).optional(),
        untilSaveEnds: z.boolean().optional(),
        until: z
          .enum(["casterTurnEnd", "casterTurnStart", "ownTurnEnd"])
          .optional()
          .describe(
            "It lasts until the end of the caster's next turn (Color Spray), the start of the caster's next turn (Sunbeam), or the end of the creature's own next turn (Sleep, Holy Aura)",
          ),
      })
      .strict()
      .optional(),
  })
  .strict();

export const LightSpec = z
  .object({
    bright: Ft,
    dim: Ft,
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    magical: z.boolean().default(true),
    pierceDarkness: z.boolean().default(false),
    cone: z.number().min(1).max(360).optional().describe("Cone angle in degrees for directional light"),
  })
  .strict();
export type LightSpec = z.infer<typeof LightSpec>;

export const Obscurement = z.enum(["light", "heavy", "magicalDarkness"]);

/** Trigger templates on a persistent effect (SPEC §12.3). The DC comes from the caster at cast time. */
export const EffectTriggerTemplate = z
  .object({
    when: z
      .enum(["enter", "startTurn", "endTurn", "per5ft", "moveInto", "action"])
      .describe(
        "enter: a creature enters (or the area moves into its space); startTurn/endTurn: its own turn inside; per5ft: each 5 ft it moves inside; moveInto: the effect's object is moved into its space (Flaming Sphere); action: its caster's action repeats it at a point in the area (Call Lightning)",
      ),
    save: z
      .object({
        ability: Ability,
        dc: z.number().int().min(1).max(40).optional(),
        onSuccess: z.enum(["half", "none", "special"]),
      })
      .strict()
      .optional(),
    damage: z.object({ formula: Formula, type: DamageType }).strict().optional(),
    condition: ConditionId.optional(),
    conditionEnds: z
      .enum(["turnEnd"])
      .optional()
      .describe("The condition lasts until the end of the creature's current turn (Stinking Cloud)"),
    breaksConcentration: z
      .boolean()
      .optional()
      .describe("A failed save also ends the creature's Concentration (Sleet Storm)"),
    side: Ft.optional().describe(
      "A wall's trigger reaches this far out of its damaging side as well as inside it (Wall of Fire: 10 ft)",
    ),
    note: ShortText.optional(),
  })
  .strict();

export const EffectPropsTemplate = z
  .object({
    difficult: z.boolean().optional(),
    obscurement: z.enum(["light", "heavy"]).optional(),
    magicalDarkness: z.boolean().optional(),
    opaque: z.boolean().optional(),
    light: z
      .object({
        bright: Ft,
        dim: Ft,
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        magical: z.boolean().default(true),
        pierceDarkness: z.boolean().default(false),
      })
      .strict()
      .optional(),
    silence: z.boolean().optional(),
    outline: z
      .boolean()
      .optional()
      .describe("Creatures inside are outlined (Faerie Fire): can't benefit from Invisible"),
    speedHalved: z
      .boolean()
      .optional()
      .describe(
        "A creature's Speed is halved while it is inside (Spirit Guardians); distinct from Difficult Terrain",
      ),
    senses: z
      .object({
        darkvision: Ft.optional(),
        blindsight: Ft.optional(),
        tremorsense: Ft.optional(),
        truesight: Ft.optional(),
      })
      .strict()
      .optional()
      .describe("Senses the creature it's on gains, in feet (Darkvision 150, True Seeing's Truesight 120)"),
    seeInvisible: z
      .boolean()
      .optional()
      .describe("The creature it's on sees Invisible creatures (See Invisibility)"),
  })
  .strict();

export const EffectTemplate = z
  .object({
    props: EffectPropsTemplate.default({}),
    triggers: z.array(EffectTriggerTemplate).max(8).default([]),
    attach: z.enum(["caster", "object", "point", "target"]).default("point"),
    onAppear: z
      .boolean()
      .optional()
      .describe(
        "Creatures in the area when it appears make the spell's save (Moonbeam, Cloudkill, Wall of Fire); otherwise only its triggers act",
      ),
    oncePerTurn: z
      .boolean()
      .optional()
      .describe(
        "A creature makes its save only once per turn, whichever trigger (Spirit Guardians, Moonbeam)",
      ),
    recastEnds: z
      .boolean()
      .optional()
      .describe(
        'Casting it again ends the caster\'s earlier one (Light: "the spell ends if you cast it again")',
      ),
    bodyFt: Ft.optional().describe(
      "An object's diameter at the effect's centre (Flaming Sphere: 5): its area reaches round the object, and it's what moves into a creature's space",
    ),
    strike: SpellArea.optional().describe(
      "Where each strike lands, when that isn't the spell's area (Call Lightning's bolt, a 5-ft radius under the cloud): the cast's targets and each action's; the spell's area is then the effect itself",
    ),
    centre: z
      .enum(["cast", "caster"])
      .optional()
      .describe(
        "Where the effect's area is centred: the cast's point (default) or over its caster (Call Lightning)",
      ),
    movement: z
      .object({
        by: z.enum(["caster", "dm"]),
        maxFt: Ft.optional(),
        action: z.enum(["action", "bonus", "free", "move"]).optional(),
        drift: z
          .object({ ft: Ft, direction: z.enum(["awayFromCaster", "chosen"]) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EffectTemplate = z.infer<typeof EffectTemplate>;

/**
 * An alternative form the caster can choose instead of `area`, e.g. Darkness cast on an object fills a
 * 15-ft Emanation that moves with the object instead of a 15-ft-radius Sphere (SPEC §33.4).
 */
export const SpellAreaAlternative = z
  .object({
    label: ShortText,
    area: SpellArea,
    attach: z.enum(["caster", "object", "point", "target"]).optional(),
  })
  .strict();

export const SpellSchema = z
  .object({
    id: Slug,
    name: z.string().trim().min(1).max(80),
    level: z.number().int().min(0).max(9),
    school: SpellSchool,
    classes: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    castingTime: z
      .object({
        amount: z.number().int().min(1).max(1000),
        unit: z.enum(["action", "bonus", "reaction", "minute", "hour"]),
        reactionTrigger: ShortText.optional(),
        text: ShortText.optional().describe(
          "Printed casting time, only when amount/unit can't express it (Plant Growth: 'Action (Overgrowth) or 8 hours (Enrichment)')",
        ),
      })
      .strict(),
    ritual: z.boolean().default(false),
    range: z
      .object({
        kind: z.enum(["self", "touch", "ranged", "sight", "unlimited", "special"]),
        ft: Ft.optional(),
        text: ShortText.optional().describe(
          "Printed range, only when `ft` can't express it (Project Image: '500 miles', beyond the Ft bound)",
        ),
      })
      .strict(),
    components: z
      .object({
        v: z.boolean(),
        s: z.boolean(),
        m: z.boolean(),
        material: z.string().max(400).optional(),
        costGp: z.number().min(0).max(1_000_000).optional(),
        consumed: z.boolean().optional(),
      })
      .strict(),
    duration: z
      .object({
        kind: z.enum(["instantaneous", "timed", "until-dispelled", "special"]),
        amount: z.number().int().min(1).max(100_000).optional(),
        unit: z.enum(["round", "minute", "hour", "day"]).optional(),
        concentration: z.boolean().default(false),
        text: ShortText.optional().describe(
          "Printed duration, only when kind/amount/unit can't express it ('Until dispelled or triggered', 'Up to 8 hours')",
        ),
      })
      .strict(),
    text: LongText,
    higherLevels: LongText.optional(),
    cantripUpgrade: LongText.optional(),
    targeting: z
      .object({
        kind: z.enum(["area", "creatures", "self", "point", "object"]),
        count: z.number().int().min(1).max(100).optional(),
        countPerSlot: z.number().int().min(0).max(100).optional(),
        countAtLevels: z
          .record(z.enum(["5", "11", "17"]), z.number().int().min(1).max(100))
          .optional()
          .describe("A cantrip's count at character levels 5, 11 and 17 (Eldritch Blast's beams)"),
      })
      .strict()
      .optional(),
    area: SpellArea.nullable().optional(),
    areaAlternatives: z.array(SpellAreaAlternative).max(4).optional(),
    attack: z
      .object({ kind: z.enum(["melee", "ranged"]) })
      .strict()
      .nullable()
      .optional(),
    splash: Ft.optional().describe(
      "After its attack, hit or miss, the target and each creature within this many feet of it make the save (Ice Knife: 5): a card of its own",
    ),
    save: SpellSave.nullable().optional(),
    damage: z.array(SpellDamage).max(8).optional(),
    healing: SpellHealing.nullable().optional(),
    conditions: z.array(SpellConditionApplied).max(8).optional(),
    effect: EffectTemplate.nullable().optional(),
    light: LightSpec.nullable().optional(),
    obscurement: Obscurement.nullable().optional(),
    vfx: VfxPreset,
    source: z
      .object({
        pack: z.string().min(1).max(40),
        page: z.number().int().min(1).max(10_000).optional(),
      })
      .strict(),
    provenance: z.record(z.string().max(60), z.string().max(200)).optional(),
  })
  .strict();

export type Spell = z.infer<typeof SpellSchema>;
export type SpellInput = z.input<typeof SpellSchema>;
