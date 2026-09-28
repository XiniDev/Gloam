import { findD20, parseFormula } from "@gloam/shared/dice";

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
