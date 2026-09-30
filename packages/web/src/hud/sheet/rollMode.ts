import { SKILLS } from "@gloam/shared";
import { findD20, parseFormula } from "@gloam/shared/dice";
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
  const save = formula.match(/@(str|dex|con|int|wis|cha)\.save\b/);
  if (save) return { kind: "save", ability: save[1] as string };
  const skill = formula.match(/@skill\.([a-zA-Z]+)/);
  if (skill) return { kind: "check", ability: (SKILLS as Record<string, string>)[skill[1] as string] ?? "" };
  if (/@init\b/.test(formula)) return { kind: "initiative" };
  const check = formula.match(/^\s*1d20\s*\+\s*@(str|dex|con|int|wis|cha)\s*$/);
  if (check) return { kind: "check", ability: check[1] as string };
  return null;
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
): { mode: RollMode; from: string[] } {
  if (!test) return { mode: "normal", from: [] };
  const h = rollHints(conditions, 0, test.kind, test.ability, creature);
  const mode = hintedMode(h);
  return {
    mode,
    from: mode === "adv" ? h.adv.map((x) => x.from) : mode === "dis" ? h.dis.map((x) => x.from) : [],
  };
}
