import { z } from "zod";
import {
  ABILITIES,
  CONDITION_IDS,
  DAMAGE_TYPES,
  LIMITS,
  SIZES,
  SKILL_IDS,
  SPELL_SCHOOLS,
  VFX_PRESETS,
} from "../constants.ts";

/** Distances in feet. Bounded so hostile input can't smuggle Infinity/NaN or absurd values in. */
export const Ft = z.number().finite().min(0).max(100_000);
export const SignedFt = z.number().finite().min(-100_000).max(100_000);
export const Vec2 = z.object({ x: SignedFt, y: SignedFt }).strict();
export type Vec2 = z.infer<typeof Vec2>;

export const Ability = z.enum(ABILITIES);
export const DamageType = z.enum(DAMAGE_TYPES);
export const ConditionId = z.enum(CONDITION_IDS);
export const SpellSchool = z.enum(SPELL_SCHOOLS);
export const VfxPreset = z.enum(VFX_PRESETS);
export const Size = z.enum(SIZES);
export const SkillId = z.enum(SKILL_IDS as [string, ...string[]]);

/** A dice formula in the SPEC §18.1 grammar (validated for syntax by the dice parser separately). */
export const Formula = z.string().trim().min(1).max(LIMITS.formulaLength);

/** kebab-case identifier, e.g. "fireball" or "poison-ball". */
export const Slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be kebab-case: lowercase letters, digits and single hyphens");

/** Human text that ends up in the UI. React escapes it; the cap protects memory and layout. */
export const ShortText = z.string().max(200);
export const LongText = z.string().max(40_000);

export const Senses = z
  .object({
    darkvision: Ft.default(0),
    blindsight: Ft.default(0),
    tremorsense: Ft.default(0),
    truesight: Ft.default(0),
  })
  .strict();
export type Senses = z.infer<typeof Senses>;

export const Speeds = z
  .object({
    walk: Ft.default(30),
    fly: Ft.default(0),
    swim: Ft.default(0),
    climb: Ft.default(0),
    burrow: Ft.default(0),
    hover: z.boolean().default(false),
  })
  .strict();
export type Speeds = z.infer<typeof Speeds>;
