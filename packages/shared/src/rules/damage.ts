/**
 * Damage and healing (SPEC §19.2, §8.11; SRD 5.2.1 "Damage and Healing"). Pure: the server plans with it and the
 * client previews with it — the same numbers on both sides. Per damage instance (a typed part): multipliers such as
 * "half damage on a successful save" first, then resistance (halve, round down), then vulnerability (double);
 * immunity means none. Resistance and vulnerability apply once per instance however many sources grant them.
 * Temporary Hit Points absorb damage before Hit Points.
 */
import { DAMAGE_TYPES, type DamageType } from "../constants.ts";

export interface DamageTarget {
  hp: number;
  hpMax: number;
  hpTemp: number;
  resistances: readonly string[];
  immunities: readonly string[];
  vulnerabilities: readonly string[];
  /** Condition ids (petrified grants resistance to all damage). */
  conditions: readonly string[];
  concentrating: boolean;
  /** Player characters make death saving throws; others don't. */
  isPC: boolean;
}

export interface DamagePart {
  amount: number;
  type: DamageType | "untyped";
}

export interface DamageOptions {
  /** A successful save that halves the damage (applied to each instance before resistance). */
  halved?: boolean;
  /** From a critical hit: two death-save failures for a creature already at 0 HP. */
  crit?: boolean;
  /**
   * The DM's own final number (a card's edited total, the HP dialog's total): taken as it is — no halving, resistance,
   * vulnerability or immunity, which the number already allows for.
   */
  final?: boolean;
  /** The rules pack played: SRD 5.1's Concentration DC has no cap (5.2.1's is at most 30). */
  rulesPack?: string;
}

/** What happened to one instance, for the preview ("12 slashing → 6, resisted"). */
export interface PartOutcome {
  type: DamageType | "untyped";
  amount: number;
  applied: number;
  steps: ("halved" | "immune" | "resisted" | "vulnerable")[];
}

export interface DamagePreview {
  parts: PartOutcome[];
  /** Damage dealt after every modifier (before temp HP). */
  total: number;
  /** How much of it the temporary HP took. */
  fromTemp: number;
  hpTemp: number;
  hp: number;
  /** Damage past 0 HP. */
  overflow: number;
  /** Brought to 0 HP by this (it had more). */
  down: boolean;
  /** Death-save failures this adds (a PC already at 0 HP taking damage: 1, or 2 from a critical hit). */
  deathSaveFailures: 0 | 1 | 2;
  /** SRD massive damage: a PC at 0 HP with damage left over at least its HP maximum — the DM is asked. */
  massiveDeath: boolean;
  /** The concentration save's DC when the creature is concentrating and took damage; null otherwise. */
  concentrationDc: number | null;
}

/** Applies damage (§19.2), without changing anything: the caller previews it, the DM may edit it, then it's applied. */
export function applyDamage(
  t: DamageTarget,
  parts: readonly DamagePart[],
  o: DamageOptions = {},
): DamagePreview {
  const resist = new Set<string>(t.resistances);
  const immune = new Set<string>(t.immunities);
  const vuln = new Set<string>(t.vulnerabilities);
  // Petrified: "Resistance to all damage" (SRD 5.2.1 p. 186) — untyped damage too (rules audit A13).
  const resistAll = t.conditions.includes("petrified");
  if (resistAll) for (const d of DAMAGE_TYPES) resist.add(d);
  let total = 0;
  const outcomes: PartOutcome[] = [];
  for (const part of parts) {
    let a = Math.trunc(part.amount);
    const steps: PartOutcome["steps"] = [];
    // (The DM's final number: nothing more to apply.)
    if (!o.final) {
      if (o.halved) {
        a = Math.floor(a / 2);
        steps.push("halved");
      }
      if (part.type === "untyped") {
        if (resistAll) {
          a = Math.floor(a / 2);
          steps.push("resisted");
        }
      } else if (immune.has(part.type)) {
        a = 0;
        steps.push("immune");
      } else {
        if (resist.has(part.type)) {
          a = Math.floor(a / 2);
          steps.push("resisted");
        }
        if (vuln.has(part.type)) {
          a *= 2;
          steps.push("vulnerable");
        }
      }
    }
    const applied = Math.max(0, a);
    outcomes.push({ type: part.type, amount: part.amount, applied, steps });
    total += applied;
  }
  const temp = Math.max(0, t.hpTemp);
  const fromTemp = Math.min(temp, total);
  const rest = total - fromTemp;
  const before = Math.max(0, t.hp);
  const hp = Math.max(0, before - rest);
  const overflow = Math.max(0, rest - before);
  const atZero = before === 0;
  return {
    parts: outcomes,
    total,
    fromTemp,
    hpTemp: temp - fromTemp,
    hp,
    overflow,
    down: !atZero && hp === 0 && rest > 0,
    deathSaveFailures: t.isPC && atZero && rest > 0 ? (o.crit ? 2 : 1) : 0,
    massiveDeath: t.isPC && hp === 0 && rest > 0 && overflow >= t.hpMax,
    concentrationDc: total > 0 && t.concentrating ? concentrationDc(total, o.rulesPack) : null,
  };
}

/**
 * The Constitution save to keep concentrating after taking `damage`: DC max(10, ⌊damage ÷ 2⌋) — at most 30 in SRD
 * 5.2.1 (p. 179); SRD 5.1 (p. 102) sets no cap (rules audit A12).
 */
export function concentrationDc(damage: number, rulesPack?: string): number {
  const dc = Math.max(10, Math.floor(damage / 2));
  return rulesPack === "srd-5.1" ? dc : Math.min(30, dc);
}

export interface HealingOutcome {
  hp: number;
  gained: number;
  /** Was at 0 HP and isn't now: conscious again, death saves reset (§8.11). */
  revived: boolean;
}

/**
 * Healing never exceeds the maximum; from 0 HP it brings the creature round (§19.2). The dead regain nothing: "a dead
 * creature has no Hit Points and can't regain them unless it is first revived by magic" (SRD 5.2.1 p. 180; rules
 * audit A2) — Healing Word on a corpse revived it. Revival is the DM's own act (clearing Dead), healing after it.
 */
export function applyHealing(
  t: Pick<DamageTarget, "hp" | "hpMax">,
  amount: number,
  dead = false,
): HealingOutcome {
  const before = Math.max(0, t.hp);
  if (dead) return { hp: before, gained: 0, revived: false };
  const heal = Math.max(0, Math.trunc(amount));
  const hp = Math.min(t.hpMax, before + heal);
  return { hp: Math.max(before, hp), gained: Math.max(0, hp - before), revived: before === 0 && hp > 0 };
}

/**
 * Temporary HP don't stack (SRD): gaining some while having some, the creature keeps one or the other — the prompt
 * offers both, the higher preselected. Null when there's nothing to choose (no temp HP yet, or the same amount).
 */
export function tempHpChoice(
  current: number,
  incoming: number,
): { keep: number; replace: number; best: number } | null {
  const cur = Math.max(0, Math.trunc(current));
  const inc = Math.max(0, Math.trunc(incoming));
  if (cur === 0 || inc === 0 || cur === inc) return null;
  return { keep: cur, replace: inc, best: Math.max(cur, inc) };
}

/** Parses typed damage as written: "12 slashing + 7 fire", "9", "5 cold, 3 piercing". Null when it can't. */
export function parseDamage(text: string): DamagePart[] | null {
  const parts: DamagePart[] = [];
  for (const raw of text.split(/[+,]/)) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    const m = /^(\d{1,5})\s*([a-z]*)$/.exec(s);
    if (!m) return null;
    const type = (m[2] || "untyped") as DamagePart["type"];
    if (type !== "untyped" && !(DAMAGE_TYPES as readonly string[]).includes(type)) return null;
    parts.push({ amount: Number(m[1]), type });
  }
  return parts.length ? parts : null;
}
