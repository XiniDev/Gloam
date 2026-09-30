import { findD20, parseFormula, sheetTestOf } from "@gloam/shared/dice";
import { hintedMode, type RollKind, rollHints } from "@gloam/shared/rules";

export type RollMode = "normal" | "adv" | "dis";

/** Advantage from Alt, disadvantage from Ctrl/Cmd (SPEC §8.9 Rolling from anywhere). */
export function modeOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): RollMode {
  if (e.altKey) return "adv";
  if (e.ctrlKey || e.metaKey) return "dis";
  return "normal";
}

/**
 * A formula with advantage or disadvantage — when it has a plain 1d20 to double (the parser's own rule) and no
 * advantage of its own; anything else rolls as it is.
 */
export function withMode(formula: string, mode: RollMode): string {
  if (mode === "normal") return formula;
  try {
    const p = parseFormula(formula);
    if (p.adv || !findD20(p.expr)) return formula;
  } catch {
    return formula;
  }
  return `${formula} ${mode}`;
}

/** What kind of D20 Test a sheet roll is (for its conditions' hints), from its formula or as the caller says. */
export interface RollTest {
  kind: RollKind;
  ability?: string;
}

/** A sheet roll's test from its formula: a save (`@dex.save`), a skill or ability check, initiative; else none. */
export function testOf(formula: string): RollTest | null {
  return sheetTestOf(formula);
}

/**
 * The mode a sheet roll takes by default: what its character's conditions suggest (AC-DICE-11) — the roller may set it
 * aside (Normal) or choose otherwise before rolling. With the conditions it comes from.
 */
export function hintFor(
  conditions: readonly string[],
  test: RollTest | null,
  /** Its token's markers and Speed, where it has a token (Dodging: advantage on Dexterity saves). */
  creature?: { markers: readonly string[]; speedFt?: number },
  pack?: string,
  exhaustion = 0,
): { mode: RollMode; from: string[] } {
  if (!test) return { mode: "normal", from: [] };
  const h = rollHints(conditions, exhaustion, test.kind, test.ability, creature, pack);
  const mode = hintedMode(h);
  return {
    mode,
    from: mode === "adv" ? h.adv.map((x) => x.from) : mode === "dis" ? h.dis.map((x) => x.from) : [],
  };
}
