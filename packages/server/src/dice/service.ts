/**
 * Dice on the server (SPEC §8.9, §18): every result is decided here — `crypto.randomInt` per die, or a seeded
 * generator in test mode only (`GLOAM_TEST_SEED`, AC-DICE-10) — written to SQLite, then sent to each client as its
 * visibility row allows (§18.3): the whole roll, a masked card, or nothing.
 */
import { randomInt } from "node:crypto";
import {
  DEFAULT_SKIN,
  DiceError,
  type DiceSkin,
  type MaskedRoll,
  normalizeFormula,
  type ParsedFormula,
  parseFormula,
  type Roller,
  type RollOutcome,
  type RollRecord,
  type RollVisibility,
  rollParsed,
  seededDie,
  tumbleOf,
  viewOfRoll,
  xoshiro128ss,
} from "@gloam/shared/dice";

export type { DiceSkin, MaskedRoll, RollRecord, RollVisibility };
export { DEFAULT_SKIN, viewOfRoll };

import { GloamError } from "@gloam/shared/protocol";
import { sheetRefs } from "@gloam/shared/rules";
import type { Sheet, TokenEntity } from "@gloam/shared/schemas";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { rolls } from "../db/schema.ts";
import { newId } from "../ids.ts";

/** The dice source: the operating system's CSPRNG, or (tests only) one seeded stream for the process. */
export class DiceSource {
  private readonly die: (sides: number) => number;
  private readonly seeds: () => number;
  constructor(testSeed: number | undefined) {
    if (testSeed === undefined) {
      this.die = (sides) => randomInt(1, sides + 1);
      this.seeds = () => randomInt(0, 2 ** 32);
    } else {
      this.die = seededDie(testSeed);
      const s = xoshiro128ss(testSeed ^ 0x9e3779b9);
      this.seeds = () => s();
    }
  }
  roll(sides: number): number {
    return this.die(sides);
  }
  seed(): number {
    return this.seeds() >>> 0;
  }
}

/**
 * `@` references for a roll made for a creature (§18.1): its character sheet's values (`sheetRefs`: abilities,
 * saves, skills, proficiency, level, spellcasting — derived, overrides included), with an unlinked token's own numbers
 * (its saves, Dexterity and initiative) first where it has them — a unit without a sheet answers from those alone.
 */
export function creatureRefs(
  t: TokenEntity | undefined,
  sheet: Sheet | undefined,
): (path: readonly string[]) => number | undefined {
  const own = tokenRefs(t);
  const fromSheet = sheet ? sheetRefs(sheet.core) : () => undefined;
  return (path) => own(path) ?? fromSheet(path);
}

/** `@` references from a token's own stats (an unlinked token or a unit). */
export function tokenRefs(t: TokenEntity | undefined): (path: readonly string[]) => number | undefined {
  return (path) => {
    if (!t) return undefined;
    const s = t.stats;
    if (!s) return undefined;
    const key = path.join(".");
    if (key === "dex") return s.dexMod;
    // Its initiative modifier, as a sheet's `@init` is: Dex modifier plus any bonus (§19.5).
    if (key === "init") return s.dexMod + s.initBonus;
    const save = key.match(/^(str|dex|con|int|wis|cha)\.save$/);
    if (save) return s.saves[save[1] as keyof typeof s.saves];
    return undefined;
  };
}

export class DiceService {
  private readonly db: Db;
  private readonly source: DiceSource;
  private readonly now: () => number;
  constructor(db: Db, testSeed: number | undefined, now: () => number = Date.now) {
    this.db = db;
    this.source = new DiceSource(testSeed);
    this.now = now;
  }

  /** Rolls a formula for someone and records it. */
  roll(
    campaignId: string,
    sceneId: string | null,
    roller: Roller,
    p: {
      formula: string;
      label?: string;
      visibility: RollVisibility;
      purpose?: string;
      token?: TokenEntity;
      /** The creature's character sheet (a linked token's, or the character itself), for `@` references. */
      sheet?: Sheet;
    },
  ): RollRecord {
    let parsed: ParsedFormula;
    let outcome: RollOutcome;
    try {
      parsed = parseFormula(p.formula);
      outcome = rollParsed(p.formula, parsed, {
        die: (sides) => this.source.roll(sides),
        resolve: creatureRefs(p.token, p.sheet),
      });
    } catch (e) {
      if (e instanceof DiceError) throw new GloamError("INVALID", e.message, { at: e.at, end: e.end });
      throw e;
    }
    return this.record(campaignId, sceneId, roller, outcome, { ...p, manual: false });
  }

  /**
   * A physical roll entered by hand (AC-DICE-05): one value per die of the formula, in order, or just its total.
   * Recorded like any roll, with its hand.
   */
  manual(
    campaignId: string,
    sceneId: string | null,
    roller: Roller,
    p: {
      formula: string;
      values?: number[];
      total?: number;
      label?: string;
      visibility: RollVisibility;
      purpose?: string;
      /** The creature it was rolled for (the feed shows its portrait, as for an app roll). */
      token?: TokenEntity;
    },
  ): RollRecord {
    let outcome: RollOutcome;
    try {
      const parsed = parseFormula(p.formula);
      if (p.values) {
        const values = p.values;
        let i = 0;
        outcome = rollParsed(p.formula, parsed, {
          die: (sides) => {
            const v = values[i++];
            if (v === undefined) throw new DiceError("One value for every die.", 0, p.formula.length);
            if (!Number.isInteger(v) || v < 1 || v > sides)
              throw new DiceError(`${v} isn't a face of a d${sides}.`, 0, p.formula.length);
            return v;
          },
        });
        if (i !== values.length) throw new DiceError("One value for every die.", 0, p.formula.length);
      } else if (p.total !== undefined && Number.isInteger(p.total)) {
        outcome = {
          formula: p.formula,
          // As it was rolled at the table ("2d20kl1 - 4" for "1d20 - 4 dis").
          normalized: normalizedOr(p.formula),
          terms: [],
          total: p.total,
          byTag: { untyped: p.total },
        };
      } else throw new DiceError("Enter each die or the total.", 0, p.formula.length);
    } catch (e) {
      if (e instanceof DiceError) throw new GloamError("INVALID", e.message, { at: e.at, end: e.end });
      throw e;
    }
    return this.record(campaignId, sceneId, roller, outcome, { ...p, manual: true });
  }

  private record(
    campaignId: string,
    sceneId: string | null,
    roller: Roller,
    outcome: RollOutcome,
    p: {
      label?: string;
      visibility: RollVisibility;
      purpose?: string;
      token?: TokenEntity;
      manual: boolean;
    },
  ): RollRecord {
    const at = this.now();
    const r: RollRecord = {
      ...outcome,
      id: newId("rol"),
      userId: roller.userId,
      name: roller.name,
      color: roller.color,
      skin: roller.skin,
      visibility: p.visibility,
      manual: p.manual,
      seed: this.source.seed(),
      tumble: p.manual ? [] : tumbleOf(outcome.terms),
      at,
    };
    if (p.token) r.tokenId = p.token.id;
    if (roller.actingAs) r.actingAs = roller.actingAs;
    if (p.label) r.label = p.label;
    if (p.purpose) r.purpose = p.purpose;
    // Written before anyone hears of it (SPEC §5 "Nothing is lost").
    this.db
      .insert(rolls)
      .values({
        id: r.id,
        campaignId,
        sceneId,
        userId: r.userId,
        tokenId: r.tokenId ?? null,
        formula: r.formula,
        resultJson: JSON.stringify({ ...r, rollerIsDm: roller.dm }),
        total: r.total,
        visibility: r.visibility,
        purpose: r.purpose ?? null,
        requestId: null,
        manual: r.manual,
        seed: r.seed,
        createdAt: at,
      })
      .run();
    return r;
  }

  /** A roll as recorded (its roller's copy), or null. */
  get(campaignId: string, id: string): RollRecord | null {
    const row = this.db.select().from(rolls).where(eq(rolls.id, id)).get();
    if (!row || row.campaignId !== campaignId) return null;
    const { rollerIsDm: _dm, ...rec } = JSON.parse(row.resultJson) as RollRecord & { rollerIsDm?: boolean };
    return rec;
  }

  /**
   * One die of a roll rolled again (Heroic Inspiration, SRD 5.2.1 p. 183: "reroll any die immediately after rolling
   * it, and you must use the new roll"; rules audit C4): the same formula, its other dice and references as they fell,
   * that one die fresh from the dice source. Recorded as a roll of its own. Dice that exploded or were rerolled by the
   * formula can't be taken one by one: refused.
   */
  reroll(
    campaignId: string,
    sceneId: string | null,
    roller: Roller,
    original: RollRecord,
    index: number,
    p: { label?: string; visibility: RollVisibility; purpose?: string; token?: TokenEntity },
  ): RollRecord {
    const dice = rerollableDice(original);
    if (!dice) throw new GloamError("INVALID", "That roll's dice can't be rolled again one by one.");
    const pick = dice[index];
    if (!pick) throw new GloamError("INVALID", "That roll has no such die.");
    const values = dice.map((d) => d.value);
    values[index] = this.source.roll(pick.sides);
    const refs = new Map<string, number>();
    for (const t of original.terms) if (t.kind === "ref") refs.set(t.ref, t.value);
    let i = 0;
    let outcome: RollOutcome;
    try {
      const formula = original.normalized || original.formula;
      outcome = rollParsed(formula, parseFormula(formula), {
        die: () => values[i++] as number,
        resolve: (path) => refs.get(path.join(".")),
      });
    } catch (e) {
      if (e instanceof DiceError) throw new GloamError("INVALID", e.message);
      throw e;
    }
    return this.record(campaignId, sceneId, roller, outcome, { ...p, manual: false });
  }

  /** The campaign's latest rolls, newest first, as a viewer may see them (the feed on joining). */
  feed(campaignId: string, viewer: { userId: string; dm: boolean }, limit = 50): (RollRecord | MaskedRoll)[] {
    const rows = this.db
      .select()
      .from(rolls)
      .where(and(eq(rolls.campaignId, campaignId)))
      .orderBy(desc(rolls.createdAt))
      .limit(limit * 2)
      .all();
    const out: (RollRecord | MaskedRoll)[] = [];
    for (const row of rows) {
      const { rollerIsDm, ...rec } = JSON.parse(row.resultJson) as RollRecord & { rollerIsDm?: boolean };
      const v = viewOfRoll(rec, viewer, rollerIsDm === true);
      if (v) out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }
}

/**
 * A roll's dice in the order they were rolled, each with its sides — or null where one exploded or was rerolled by its
 * formula (the order of those can't be told from the result alone).
 */
export function rerollableDice(r: RollRecord): { sides: number; value: number; kept: boolean }[] | null {
  const out: { sides: number; value: number; kept: boolean }[] = [];
  for (const t of r.terms) {
    if (t.kind !== "dice") continue;
    for (const d of t.dice) {
      if (d.exploded || d.rerolledFrom?.length) return null;
      out.push({ sides: t.sides, value: d.value, kept: d.kept });
    }
  }
  return out.length ? out : null;
}

/** A formula as it rolls, or as written when it can't be read. */
function normalizedOr(formula: string): string {
  try {
    return normalizeFormula(formula);
  } catch {
    return formula;
  }
}
