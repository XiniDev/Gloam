/**
 * D20 Tests (SRD 5.2.1: attack rolls, ability checks, saving throws): a formula with a plain 1d20 to roll. Exhaustion
 * takes 2 × its level off every one (§8.11, AC-HP-05); conditions add advantage or disadvantage, which the roller may
 * set aside (AC-DICE-11). Pure text transforms on formulas the parser accepts.
 */
import { SKILLS } from "../constants.ts";
import { findD20, parseFormula } from "./parse.ts";

/** Whether a formula is a D20 Test (it has a plain 1d20). */
export function isD20Test(formula: string): boolean {
  try {
    return findD20(parseFormula(formula).expr) !== null;
  } catch {
    return false;
  }
}

/** A formula's text and its advantage word ("1d20 + 5", "dis"). */
function split(formula: string): { body: string; adv: "adv" | "dis" | null } {
  const m = formula.match(/^(.*?)\s+(adv|dis)\s*$/i);
  return m
    ? { body: (m[1] as string).trim(), adv: (m[2] as string).toLowerCase() as "adv" | "dis" }
    : { body: formula.trim(), adv: null };
}

/** A D20 Test with a flat penalty (Exhaustion: −2 × level) — before any advantage word; anything else as it is. */
export function withPenalty(formula: string, penalty: number): string {
  const n = Math.trunc(penalty);
  if (!n || !isD20Test(formula)) return formula;
  const { body, adv } = split(formula);
  return `${body} ${n < 0 ? "-" : "+"} ${Math.abs(n)}${adv ? ` ${adv}` : ""}`;
}

/**
 * A D20 Test with terms joined before its advantage (rules audit Q6: Bless "+1d4", Bane "-1d4", Slow "-2"), each as
 * "+ 1d4" or "- 2". Anything else as it is.
 */
export function withTerms(formula: string, terms: readonly string[]): string {
  if (!terms.length || !isD20Test(formula)) return formula;
  const { body, adv } = split(formula);
  const joined = terms.map((t) => {
    const m = t.trim().match(/^([+-])\s*(.+)$/);
    return m ? `${m[1]} ${m[2]}` : `+ ${t.trim()}`;
  });
  return `${body} ${joined.join(" ")}${adv ? ` ${adv}` : ""}`;
}

/**
 * A D20 Test with a hinted advantage or disadvantage joined to the one it has: the same stays; the other cancels it
 * (any advantage and any disadvantage roll one die); none takes the hint. Anything else as it is.
 */
export function withHint(formula: string, hint: "adv" | "dis" | "normal"): string {
  if (hint === "normal" || !isD20Test(formula)) return formula;
  const { body, adv } = split(formula);
  if (!adv) return `${body} ${hint}`;
  return adv === hint ? formula : body;
}

/**
 * A sheet roll's D20 Test from its formula (for its creature's hints, and on the server what its markers add to it —
 * rules audit Q6): a save (`@dex.save`), a skill or ability check, initiative; else none.
 */
export function sheetTestOf(
  formula: string,
): { kind: "save" | "check" | "initiative"; ability?: string } | null {
  const save = formula.match(/@(str|dex|con|int|wis|cha)\.save\b/);
  if (save) return { kind: "save", ability: save[1] as string };
  const skill = formula.match(/@skill\.([a-zA-Z]+)/);
  if (skill) return { kind: "check", ability: (SKILLS as Record<string, string>)[skill[1] as string] ?? "" };
  if (/@init\b/.test(formula)) return { kind: "initiative" };
  const check = formula.match(/^\s*1d20\s*\+\s*@(str|dex|con|int|wis|cha)\s*$/);
  if (check) return { kind: "check", ability: check[1] as string };
  return null;
}
