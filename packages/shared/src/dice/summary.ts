/**
 * A formula as a sheet shows it (SPEC §8.10 Actions): its dice and one bonus, the `@` references resolved —
 * "1d20 + @str + @prof" with STR +3 and proficiency +3 is 1d20 and +6 ("Attack +6"); "1d8 + @str [bludgeoning]" is
 * "1d8 + 3 bludgeoning". Only for plain sums; anything else (multiplied, rerolls, dice counts from expressions) is
 * shown as written.
 */
import { type DiceNode, parseFormula } from "./parse.ts";

export interface FormulaSummary {
  dice: string[];
  bonus: number;
  /** The damage type it's tagged with (one at most: a formula of several types isn't summarised). */
  tags: string[];
}

export function summarizeFormula(
  formula: string,
  resolve: (path: readonly string[]) => number | undefined,
): FormulaSummary | null {
  let parsed: ReturnType<typeof parseFormula>;
  try {
    parsed = parseFormula(formula);
  } catch {
    return null;
  }
  const out: FormulaSummary = { dice: [], bonus: 0, tags: [] };
  const walk = (n: DiceNode, sign: 1 | -1): boolean => {
    switch (n.k) {
      case "num":
        out.bonus += sign * n.v;
        return true;
      case "ref": {
        const v = resolve(n.path);
        if (v === undefined) return false;
        out.bonus += sign * v;
        return true;
      }
      case "dice": {
        if (n.count.k !== "num" || n.mods.length) return false;
        out.dice.push(`${sign < 0 ? "−" : ""}${n.count.v}d${n.percent ? "%" : n.sides}`);
        if (n.tag && !out.tags.includes(n.tag)) out.tags.push(n.tag);
        return true;
      }
      case "neg":
        return walk(n.x, sign === 1 ? -1 : 1);
      case "group":
        return walk(n.x, sign);
      case "bin":
        if (n.op === "*" || n.op === "/") return false;
        return walk(n.a, sign) && walk(n.b, n.op === "+" ? sign : sign === 1 ? -1 : 1);
    }
  };
  if (!walk(parsed.expr, 1)) return null;
  if (parsed.tag && !out.tags.includes(parsed.tag)) out.tags.push(parsed.tag);
  // Parts of different types aren't one line ("which die is the fire?"): shown as written.
  return out.tags.length > 1 ? null : out;
}

/** "1d8 + 3 bludgeoning", "2d6 − 1", "+6" (a lone d20 with its bonus), or null for what isn't a plain sum. */
export function formulaText(s: FormulaSummary | null, opts: { toHit?: boolean } = {}): string | null {
  if (!s) return null;
  const sign = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
  if (opts.toHit && s.dice.length === 1 && s.dice[0] === "1d20") return sign(s.bonus);
  const parts = [...s.dice];
  const text = parts.join(" + ").replace(/\+ −/g, "− ");
  const bonus = s.bonus === 0 ? "" : ` ${s.bonus > 0 ? "+" : "−"} ${Math.abs(s.bonus)}`;
  return `${text || "0"}${bonus}${s.tags[0] ? ` ${s.tags[0]}` : ""}`;
}
