import type { Ability, ConditionId, DamageType, Size } from "../constants.ts";
import { SIZES } from "../constants.ts";
import {
  DEFAULT_SPEEDS,
  EMPTY_STATUS,
  type SensesT,
  type SpeedsT,
  type TokenEntity,
  type TokenStats,
  type TokenStatusT,
  ZERO_SENSES,
} from "../schemas/entities.ts";

/** The parts of an actor a token reads (the full sheet document is Appendix F.3). */
export interface ActorLike {
  id: string;
  kind: "character" | "npc";
  ownerUserId: string | null;
  sheet: Record<string, unknown>;
  status: Record<string, unknown>;
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const strs = <T extends string>(v: unknown): T[] =>
  Array.isArray(v) ? (v.filter((x) => typeof x === "string") as T[]) : [];

export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);

/** Proficiency bonus from total character level (SRD 5.2.1: +2 at 1–4, +3 at 5–8, … +6 at 17–20). */
export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, Math.min(20, level)) - 1) / 4);
}

/**
 * The token-facing numbers of a sheet (`core`, Appendix F.3): HP, AC, speeds, senses, saves, defences, size.
 * Linked tokens show these on every scene (SPEC §8.5 Linked and unlinked tokens).
 */
export function statsFromSheet(sheet: Record<string, unknown>): TokenStats {
  const core = obj(sheet.core);
  const hp = obj(core.hp);
  const abilities = obj(core.abilities);
  const level = (Array.isArray(core.classes) ? core.classes : []).reduce(
    (n: number, c) => n + num(obj(c).level, 0),
    0,
  );
  const prof = proficiencyBonus(level || 1);
  const saves: Partial<Record<Ability, number>> = {};
  const saveProf = obj(core.saves);
  for (const a of ["str", "dex", "con", "int", "wis", "cha"] as const) {
    const mod = abilityMod(num(abilities[a], 10));
    const s = obj(saveProf[a]);
    const bonus = typeof s.bonus === "number" ? s.bonus : 0;
    saves[a] = mod + (s.proficient === true ? prof : 0) + bonus;
  }
  const speeds = obj(core.speeds);
  const senses = obj(core.senses);
  const size = SIZES.includes(core.size as Size) ? (core.size as Size) : "medium";
  const dexMod = abilityMod(num(abilities.dex, 10));
  return {
    hp: num(hp.current, num(hp.max, 1)),
    hpMax: Math.max(1, num(hp.max, 1)),
    hpTemp: Math.max(0, num(hp.temp, 0)),
    ac: num(obj(core.ac).value, 10),
    speeds: {
      walk: num(speeds.walk, DEFAULT_SPEEDS.walk),
      fly: num(speeds.fly, 0),
      swim: num(speeds.swim, 0),
      climb: num(speeds.climb, 0),
      burrow: num(speeds.burrow, 0),
      hover: speeds.hover === true,
    } satisfies SpeedsT,
    senses: {
      darkvision: num(senses.darkvision, 0),
      blindsight: num(senses.blindsight, 0),
      tremorsense: num(senses.tremorsense, 0),
      truesight: num(senses.truesight, 0),
    } satisfies SensesT,
    saves,
    dexMod,
    initBonus: dexMod + num(obj(core.initiative).bonus, 0),
    resist: strs<DamageType>(core.resistances),
    immune: strs<DamageType>(core.immunities),
    vuln: strs<DamageType>(core.vulnerabilities),
    conditionImmune: strs<ConditionId>(core.conditionImmunities),
    reachFt: num(core.reachFt, 5),
    size,
    isPC: true,
  };
}

/** Actor status (conditions, exhaustion, death saves…) with defaults for missing fields. */
export function statusFromActor(status: Record<string, unknown>): TokenStatusT {
  return {
    ...EMPTY_STATUS,
    ...(status as Partial<TokenStatusT>),
    conditions: Array.isArray(status.conditions) ? (status.conditions as TokenStatusT["conditions"]) : [],
    markers: Array.isArray(status.markers) ? (status.markers as TokenStatusT["markers"]) : [],
  };
}

/** What a token shows: its own copy (unlinked) or its actor's (linked). */
export function effectiveTokenState(
  token: TokenEntity,
  actor: ActorLike | undefined,
): { stats: TokenStats; status: TokenStatusT } {
  if (token.link === "linked" && actor) {
    return {
      stats: { ...statsFromSheet(actor.sheet), isPC: actor.kind === "character" },
      status: statusFromActor(actor.status),
    };
  }
  return {
    stats: token.stats ?? {
      hp: 1,
      hpMax: 1,
      hpTemp: 0,
      ac: 10,
      speeds: { ...DEFAULT_SPEEDS },
      senses: { ...ZERO_SENSES },
      saves: {},
      dexMod: 0,
      initBonus: 0,
      resist: [],
      immune: [],
      vuln: [],
      conditionImmune: [],
      reachFt: 5,
      size: "medium",
      isPC: false,
    },
    status: token.status ?? EMPTY_STATUS,
  };
}

/** HP band (SPEC §8.5 Descriptor): 4 Healthy 100 %, 3 Hurt 51–99 %, 2 Bloodied 26–50 %, 1 Critical 1–25 %, 0 Down. */
export function hpBand(hp: number, hpMax: number): 0 | 1 | 2 | 3 | 4 {
  if (hp <= 0) return 0;
  const f = hp / Math.max(1, hpMax);
  if (f >= 1) return 4;
  if (f > 0.5) return 3;
  if (f > 0.25) return 2;
  return 1;
}
export const HP_BAND_LABELS = ["Down", "Critical", "Bloodied", "Hurt", "Healthy"] as const;
/** `hpBand` value meaning "not shown to this viewer" (HP display Hidden). */
export const HP_BAND_HIDDEN = 255;
