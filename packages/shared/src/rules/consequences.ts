/**
 * What follows from a change of HP (SPEC §8.11, §19.5): going down, death-save failures, massive damage, an NPC at
 * 0 HP, a concentration save, coming round, Bloodied. Pure — the server works them out when it applies damage or
 * healing and, per the campaign's automation level (§19.1), applies them at once (Auto), puts them to the DM to
 * apply, edit or skip (Assist), or leaves them (Manual). Also the death-saving-throw state machine.
 */
import type { ConditionId } from "../constants.ts";
import type { TokenStatusT } from "../schemas/entities.ts";
import { concentrationDc, type DamagePreview, type HealingOutcome } from "./damage.ts";

/** Where a condition came from when 0 HP brought it (so coming round takes away only those). */
export const AT_ZERO_SOURCE = "0 HP";

export type Consequence =
  /** A PC at 0 HP: Unconscious and Prone, dying (death saves). */
  | { kind: "down"; conditions: ConditionId[] }
  /** Death-save failures from damage at 0 HP (the total after them). */
  | { kind: "deathSaveFailures"; n: 1 | 2; failures: number }
  /** Three failures: the DM is asked "Mark dead?". */
  | { kind: "dying"; reason: "failures" | "massive" | "exhaustion" }
  /** An NPC or unit at 0 HP: the DM's choice, the campaign's default preselected. */
  | { kind: "npcAtZero"; choice: "dead" | "unconscious" | "keep" }
  /** A concentration save (DC) for its owner. */
  | { kind: "concentrationSave"; dc: number }
  /** Concentration ends outright (knocked out: Incapacitated). */
  | { kind: "concentrationEnds"; reason: string }
  /** Healed from 0 HP: conscious again, death saves cleared. */
  | { kind: "revive" }
  /** The Bloodied marker on or off (at half its HP or fewer, not at 0). */
  | { kind: "bloodied"; on: boolean };

/** Whether a creature is Bloodied (SRD 5.2.1: half its HP or fewer; at 0 it's down instead). */
export const isBloodied = (hp: number, hpMax: number) => hpMax > 0 && hp > 0 && hp <= hpMax / 2;

/** Dead: three failed death saves, or marked so (a monster the DM had die at 0 HP). */
export const isDead = (s: TokenStatusT) =>
  s.deathSaves?.dead === true || s.markers.some((m) => m.id === "dead");

export interface ConsequenceRules {
  bloodied: boolean;
  npcAtZero: "dead" | "unconscious" | "keep";
  /** The rules pack played ("srd-5.1": the Concentration DC has no cap). */
  rulesPack?: string;
}

/** What damage brings, from the creature as it was and the damage's preview. */
export function damageConsequences(
  before: { hp: number; hpMax: number; isPC: boolean; status: TokenStatusT },
  preview: DamagePreview,
  rules: ConsequenceRules,
): Consequence[] {
  const out: Consequence[] = [];
  const has = (id: string) => before.status.conditions.some((c) => c.id === id);
  if (preview.down) {
    if (before.isPC) {
      const conditions = (["unconscious", "prone"] as const).filter((c) => !has(c));
      out.push({ kind: "down", conditions });
      if (preview.massiveDeath) out.push({ kind: "dying", reason: "massive" });
    } else out.push({ kind: "npcAtZero", choice: rules.npcAtZero });
    if (before.status.concentration) out.push({ kind: "concentrationEnds", reason: "Unconscious" });
  } else if (preview.deathSaveFailures) {
    const failures = Math.min(3, (before.status.deathSaves?.failures ?? 0) + preview.deathSaveFailures);
    out.push({ kind: "deathSaveFailures", n: preview.deathSaveFailures, failures });
    if (preview.massiveDeath || failures >= 3)
      out.push({ kind: "dying", reason: preview.massiveDeath ? "massive" : "failures" });
  } else if (preview.total > 0 && before.status.concentration)
    out.push({ kind: "concentrationSave", dc: concentrationDc(preview.total, rules.rulesPack) });
  if (rules.bloodied) {
    const was = isBloodied(before.hp, before.hpMax);
    const now = isBloodied(preview.hp, before.hpMax);
    if (was !== now) out.push({ kind: "bloodied", on: now });
  }
  return out;
}

/** What healing brings. */
export function healingConsequences(
  before: { hp: number; hpMax: number; status: TokenStatusT },
  healed: HealingOutcome,
  rules: ConsequenceRules,
): Consequence[] {
  const out: Consequence[] = [];
  if (healed.revived) out.push({ kind: "revive" });
  if (rules.bloodied) {
    const was = isBloodied(before.hp, before.hpMax);
    const now = isBloodied(healed.hp, before.hpMax);
    if (was !== now) out.push({ kind: "bloodied", on: now });
  }
  return out;
}

/** Whether a consequence is the DM's decision even under Auto (a death, an NPC's fate without a default). */
export const isDecision = (c: Consequence) => c.kind === "dying";

const withMarker = (s: TokenStatusT, id: string, on: boolean): TokenStatusT => {
  const has = s.markers.some((m) => m.id === id);
  if (on === has) return s;
  return {
    ...s,
    markers: on
      ? [...s.markers, { id: id as TokenStatusT["markers"][number]["id"] }]
      : s.markers.filter((m) => m.id !== id),
  };
};

/**
 * A status with a consequence applied (the parts of it that are status; HP changes are the caller's). "dying" and
 * "npcAtZero" apply the DM's decision: dead (the Dead marker, dying cleared), or for an NPC unconscious / kept at 0.
 */
export function applyToStatus(s: TokenStatusT, c: Consequence, decision?: string): TokenStatusT {
  switch (c.kind) {
    case "down":
      return withMarker(
        {
          ...s,
          conditions: [...s.conditions, ...c.conditions.map((id) => ({ id, source: AT_ZERO_SOURCE }))],
          deathSaves: { successes: 0, failures: 0, stable: false, dead: false },
        },
        "deathsaves",
        true,
      );
    case "deathSaveFailures": {
      const d = s.deathSaves ?? { successes: 0, failures: 0, stable: false, dead: false };
      return {
        ...withMarker(s, "stable", false),
        deathSaves: { ...d, failures: Math.min(3, c.failures) as 0 | 1 | 2 | 3, stable: false },
      };
    }
    case "dying":
      if (decision === "keep") return s;
      return withMarker(
        withMarker(
          {
            ...s,
            deathSaves: { successes: 0, failures: 3, stable: false, dead: true },
            concentration: undefined,
          },
          "deathsaves",
          false,
        ),
        "dead",
        true,
      );
    case "npcAtZero": {
      const choice = decision ?? c.choice;
      if (choice === "keep") return s;
      // Unconscious is Prone too (SRD 5.2.1), as for a character going down.
      if (choice === "unconscious") {
        const add = (["unconscious", "prone"] as const).filter(
          (id) => !s.conditions.some((x) => x.id === id),
        );
        return add.length
          ? { ...s, conditions: [...s.conditions, ...add.map((id) => ({ id, source: AT_ZERO_SOURCE }))] }
          : s;
      }
      return withMarker(
        {
          ...s,
          concentration: undefined,
          deathSaves: { successes: 0, failures: 0, stable: false, dead: true },
        },
        "dead",
        true,
      );
    }
    case "concentrationEnds":
      return withMarker({ ...s, concentration: undefined }, "concentrating", false);
    case "concentrationSave":
      return s;
    case "revive":
      return withMarker(
        withMarker(
          {
            ...s,
            conditions: s.conditions.filter((x) => !(x.id === "unconscious" && x.source === AT_ZERO_SOURCE)),
            deathSaves: undefined,
          },
          "deathsaves",
          false,
        ),
        "stable",
        false,
      );
    case "bloodied":
      return withMarker(s, "bloodied", c.on);
  }
}

/** One death saving throw (SRD 5.2.1, §19.5): DC 10; a natural 20 brings the creature back with 1 HP; a 1 is two failures. */
export interface DeathSaveResult {
  successes: number;
  failures: number;
  /** Back on its feet with 1 HP (natural 20). */
  regain: boolean;
  stable: boolean;
  /** Three failures: the DM's "Mark dead?". */
  dying: boolean;
}

export function deathSave(
  current: { successes: number; failures: number },
  natural: number,
  total: number,
): DeathSaveResult {
  if (natural === 20) return { successes: 0, failures: 0, regain: true, stable: false, dying: false };
  let { successes, failures } = current;
  if (natural === 1) failures += 2;
  else if (total >= 10) successes += 1;
  else failures += 1;
  successes = Math.min(3, successes);
  failures = Math.min(3, failures);
  return { successes, failures, regain: false, stable: successes >= 3, dying: failures >= 3 };
}

/** A consequence in words for the DM's prompt and the damage preview, with the choice it offers (if any). */
export function describeConsequence(c: Consequence): {
  label: string;
  choices?: { id: string; label: string }[];
  choice?: string;
} {
  switch (c.kind) {
    case "down": {
      const names = c.conditions.map((id) => id[0]?.toUpperCase() + id.slice(1));
      return {
        label: names.length ? `${names.join(" and ")}; death saves start` : "Death saves start",
      };
    }
    case "deathSaveFailures":
      return {
        label: `${c.n === 2 ? "Two death-save failures" : "A death-save failure"} (${c.failures} of 3)`,
      };
    case "dying":
      return {
        label:
          c.reason === "massive"
            ? "Instant death? (massive damage)"
            : c.reason === "exhaustion"
              ? "Dead? (Exhaustion 6)"
              : "Mark dead? (three failed death saves)",
        choices: [
          { id: "dead", label: "Dead" },
          { id: "keep", label: c.reason === "failures" ? "Keep dying" : "Not dead" },
        ],
        choice: "dead",
      };
    case "npcAtZero":
      return {
        label: "At 0 HP",
        choices: [
          { id: "dead", label: "Dead" },
          { id: "unconscious", label: "Unconscious" },
          { id: "keep", label: "Keep at 0" },
        ],
        choice: c.choice,
      };
    case "concentrationSave":
      return { label: `Concentration save, DC ${c.dc}` };
    case "concentrationEnds":
      return { label: `Concentration ends (${c.reason})` };
    case "revive":
      return { label: "Conscious again; death saves cleared" };
    case "bloodied":
      return { label: c.on ? "Bloodied" : "No longer Bloodied" };
  }
}

/**
 * Which consequences apply now and which are put to the DM (§19.1): the DM's own decisions when they made them in the
 * preview; under Manual only the Bloodied marker (its own campaign toggle); under Auto everything but a death (the DM
 * still decides that); under Assist the marker and the concentration save (the owner's roll — its failure is what the
 * DM confirms), the rest asked.
 */
export function sortConsequences(
  all: readonly Consequence[],
  automation: "manual" | "assist" | "auto",
  decided?: { keep: readonly string[]; choices?: Record<string, string> | undefined },
): { apply: { consequence: Consequence; choice?: string }[]; ask: Consequence[] } {
  if (decided) {
    const apply = all
      .filter((c) => decided.keep.includes(c.kind))
      .map((c) => {
        const choice = decided.choices?.[c.kind];
        return choice ? { consequence: c, choice } : { consequence: c };
      });
    return { apply, ask: [] };
  }
  if (automation === "manual")
    return { apply: all.filter((c) => c.kind === "bloodied").map((c) => ({ consequence: c })), ask: [] };
  if (automation === "auto")
    return {
      apply: all.filter((c) => !isDecision(c)).map((c) => ({ consequence: c })),
      ask: all.filter(isDecision),
    };
  const now = (c: Consequence) => c.kind === "bloodied" || c.kind === "concentrationSave";
  return { apply: all.filter(now).map((c) => ({ consequence: c })), ask: all.filter((c) => !now(c)) };
}
