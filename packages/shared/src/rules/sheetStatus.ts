/**
 * A character's status has one home: the actor's `status` (SPEC §8.5 Linked tokens — conditions with where they came
 * from and how long they last, exhaustion, death saves, concentration), which the token pipeline (conditions, damage,
 * effects) works on for linked and unlinked tokens alike. The sheet document (Appendix F.3) carries the same four
 * fields in its plain form; they're a view of that status: filled in from it for whoever reads the sheet (and for
 * export), turned back into status when a sheet is edited or imported, and kept at their defaults in the stored sheet
 * so the two can never disagree.
 */
import { EMPTY_STATUS, type TokenStatusT } from "../schemas/entities.ts";
import type { Sheet } from "../schemas/sheet.ts";

/** The sheet's fields that are status. */
export const STATUS_FIELDS = ["conditions", "exhaustion", "deathSaves", "concentration"] as const;

/** The sheet as it's read: its status fields from the actor's status. */
export function projectSheet(sheet: Sheet, status: TokenStatusT): Sheet {
  const core = { ...sheet.core };
  core.conditions = [...new Set(status.conditions.map((c) => c.id))];
  core.exhaustion = status.exhaustion;
  core.deathSaves = {
    successes: status.deathSaves?.successes ?? 0,
    failures: status.deathSaves?.failures ?? 0,
  };
  const spell = status.concentration?.spellName;
  if (spell) core.concentration = spell;
  else delete core.concentration;
  return { ...sheet, core };
}

/** The sheet as it's stored: its status fields at their defaults. */
export function storedSheet(sheet: Sheet): Sheet {
  const core = { ...sheet.core, conditions: [], exhaustion: 0, deathSaves: { successes: 0, failures: 0 } };
  delete core.concentration;
  return { ...sheet, core };
}

/**
 * The status a sheet's fields describe, keeping what the status already knew: a condition still listed keeps its
 * source and duration, death saves keep whether the character is stable or dead, concentration keeps its effect.
 */
export function statusFromSheet(sheet: Sheet, prev: TokenStatusT = EMPTY_STATUS): TokenStatusT {
  const c = sheet.core;
  const conditions = [...new Set(c.conditions)].map(
    (id) => prev.conditions.find((k) => k.id === id) ?? { id },
  );
  const saves = c.deathSaves;
  const deathSaves =
    prev.deathSaves || saves.successes || saves.failures
      ? {
          successes: saves.successes as 0 | 1 | 2 | 3,
          failures: saves.failures as 0 | 1 | 2 | 3,
          stable: prev.deathSaves?.stable ?? false,
          dead: prev.deathSaves?.dead ?? false,
        }
      : undefined;
  const concentration = c.concentration
    ? prev.concentration?.spellName === c.concentration
      ? prev.concentration
      : { spellName: c.concentration }
    : undefined;
  const next: TokenStatusT = {
    ...prev,
    conditions,
    exhaustion: c.exhaustion as TokenStatusT["exhaustion"],
  };
  if (deathSaves) next.deathSaves = deathSaves;
  else delete next.deathSaves;
  if (concentration) next.concentration = concentration;
  else delete next.concentration;
  return next;
}
