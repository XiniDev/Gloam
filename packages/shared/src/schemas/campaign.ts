import { z } from "zod";

/** House rules (SPEC §19.6). Defaults first; every option is a campaign setting the DM can change. */
export const HouseRules = z
  .object({
    automation: z.enum(["assist", "manual", "auto"]).default("assist"),
    overlongMoves: z.enum(["clamp", "reject"]).default("clamp"),
    moveReset: z.enum(["always", "untilAction", "never"]).default("always"),
    creatureSpaces: z.enum(["combat", "always", "never"]).default("combat"),
    areaCoverage: z.enum(["touches", "centre"]).default("touches"),
    criticalDamage: z.enum(["doubleDice", "maxPlusRoll"]).default("doubleDice"),
    initiativeTies: z.enum(["dexThenPcs", "dmDecides"]).default("dexThenPcs"),
    npcAtZero: z.enum(["dead", "unconscious", "keep"]).default("dead"),
    defaultInitiative: z.enum(["playersRoll", "rollAll", "fixed", "skip"]).default("playersRoll"),
    deathSavesVisibleTo: z.enum(["everyone", "ownerAndDm"]).default("everyone"),
    bloodied: z.boolean().default(true),
    partyVision: z.boolean().default(false),
    playerDamage: z.enum(["viaDm", "direct"]).default("viaDm"),
    hiddenCombatants: z.enum(["hidden", "unknown"]).default("hidden"),
    sheetLockDefault: z.enum(["unlocked", "core", "full"]).default("unlocked"),
    npcHpDisplay: z.enum(["bar", "exact", "descriptor", "hidden"]).default("bar"),
    squeeze: z.number().min(0.3).max(0.5).default(0.4),
    explorationMovement: z.enum(["free", "limited"]).default("free"),
  })
  .strict();
export type HouseRules = z.infer<typeof HouseRules>;
export const DEFAULT_HOUSE_RULES: HouseRules = HouseRules.parse({});

/** Per-campaign settings that aren't rules (SPEC §8.2, §8.5, §8.12). */
export const CampaignSettings = z
  .object({
    npcHpDisplayDefault: z.enum(["bar", "exact", "descriptor", "hidden"]).default("bar"),
    idleAnimations: z.boolean().default(true),
    autoFacing: z.boolean().default(true),
    revealHiddenCombatantCount: z.boolean().default(false),
  })
  .strict();
export type CampaignSettings = z.infer<typeof CampaignSettings>;

export const CampaignPatch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    units: z.enum(["ft", "m"]).optional(),
    houseRules: HouseRules.partial().optional(),
    settings: CampaignSettings.partial().optional(),
  })
  .strict();
export type CampaignPatch = z.infer<typeof CampaignPatch>;

/** Parses a stored JSON column leniently: unknown keys dropped, missing keys defaulted. */
export function parseHouseRules(json: string | null | undefined): HouseRules {
  try {
    const raw = JSON.parse(json ?? "{}") as Record<string, unknown>;
    const known = Object.fromEntries(Object.entries(raw).filter(([k]) => k in HouseRules.shape));
    const r = HouseRules.safeParse(known);
    return r.success ? r.data : DEFAULT_HOUSE_RULES;
  } catch {
    return DEFAULT_HOUSE_RULES;
  }
}

export function parseCampaignSettings(json: string | null | undefined): CampaignSettings {
  try {
    const raw = JSON.parse(json ?? "{}") as Record<string, unknown>;
    const known = Object.fromEntries(Object.entries(raw).filter(([k]) => k in CampaignSettings.shape));
    const r = CampaignSettings.safeParse(known);
    return r.success ? r.data : CampaignSettings.parse({});
  } catch {
    return CampaignSettings.parse({});
  }
}
