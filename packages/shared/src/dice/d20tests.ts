/**
 * D20 Tests (SRD 5.2.1: attack rolls, ability checks, saving throws): a formula with a plain 1d20 to roll. Exhaustion
 * takes 2 × its level off every one (§8.11, AC-HP-05); conditions add advantage or disadvantage, which the roller may
 * set aside (AC-DICE-11). Pure text transforms on formulas the parser accepts.
 */
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
 * A D20 Test with a hinted advantage or disadvantage joined to the one it has: the same stays; the other cancels it
 * (any advantage and any disadvantage roll one die); none takes the hint. Anything else as it is.
 */
export function withHint(formula: string, hint: "adv" | "dis" | "normal"): string {
  if (hint === "normal" || !isD20Test(formula)) return formula;
  const { body, adv } = split(formula);
  if (!adv) return `${body} ${hint}`;
  return adv === hint ? formula : body;
}
