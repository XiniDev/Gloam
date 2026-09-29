/**
 * Rolling a parsed formula (SPEC §18.1–18.2) with an injected die: the server passes `crypto.randomInt`, tests a
 * seeded generator; the client never rolls. Rerolls, explosions, min/max, keep/drop, `@` references, advantage and
 * damage-type tags; the dice limits (≤ 100 per term, ≤ 500 in all, depth ≤ 20) are enforced as the dice fall.
 */

import { formatNode } from "./format.ts";
import {
  compareMatches,
  DICE_LIMITS,
  DiceError,
  type DiceNode,
  findD20,
  type Modifier,
  type ParsedFormula,
  parseFormula,
} from "./parse.ts";

export interface RolledDie {
  /** The face counted (after min/max). */
  value: number;
  kept: boolean;
  /** This die exploded (another was rolled for it). */
  exploded: boolean;
  /** Faces rolled before a reroll, oldest first. */
  rerolledFrom?: number[];
}

/**
 * One term of a roll as rolled. `sign: -1` marks a term the formula subtracts ("1d20 - 4": the 4; "1d20 - 1d4": the
 * d4) — its value is as written, its contribution the opposite.
 */
export type RollTerm =
  | {
      kind: "dice";
      count: number;
      sides: number;
      tag?: string;
      dice: RolledDie[];
      subtotal: number;
      sign?: -1;
    }
  | { kind: "const"; value: number; sign?: -1 }
  | { kind: "ref"; ref: string; value: number; sign?: -1 };

/** What a term adds to the total (its value, with the formula's sign). */
export const termContribution = (t: RollTerm): number =>
  (t.kind === "dice" ? t.subtotal : t.value) * (t.sign === -1 ? -1 : 1);

export interface RollOutcome {
  formula: string;
  /** The formula as rolled (advantage expanded, spacing normalised). */
  normalized: string;
  terms: RollTerm[];
  total: number;
  /** Totals per damage type; terms without one are `untyped`. */
  byTag: Record<string, number>;
  /** The first kept d20 of a d20 roll. */
  natural?: number;
  crit?: boolean;
  fumble?: boolean;
}

export interface RollInput {
  /** A die: an integer in 1..sides, uniformly. */
  die: (sides: number) => number;
  /** `@` references (the roller's sheet or the unit's stats); undefined for an unknown one. */
  resolve?: (path: readonly string[]) => number | undefined;
}

/** Rolls a formula (a string, or one already parsed). Throws DiceError for invalid formulas and exceeded limits. */
export function roll(formula: string, input: RollInput): RollOutcome {
  const parsed = parseFormula(formula);
  return rollParsed(formula, parsed, input);
}

/** A parsed formula's expression with its advantage word applied: its d20 rolled twice, keeping one. */
function withAdvantage(formula: string, parsed: ParsedFormula): DiceNode {
  const expr = parsed.expr;
  if (!parsed.adv) return expr;
  const d20 = findD20(expr);
  if (!d20) throw new DiceError("Advantage needs a single d20 (1d20) in the formula.", 0, formula.length);
  const mod: Modifier = { k: "keep", high: parsed.adv === "adv", n: 1 };
  return replaceNode(expr, d20, { ...d20, count: { k: "num", v: 2, at: d20.at }, mods: [mod] });
}

/**
 * A formula as it will roll, without rolling it — "1d20 - 4 dis" → "2d20kl1 - 4" (the roll feed's normalized form).
 * Throws DiceError for an invalid formula.
 */
export function normalizeFormula(formula: string): string {
  const parsed = parseFormula(formula);
  return formatNode(withAdvantage(formula, parsed)) + (parsed.tag ? ` [${parsed.tag}]` : "");
}

export function rollParsed(formula: string, parsed: ParsedFormula, input: RollInput): RollOutcome {
  const expr = withAdvantage(formula, parsed);
  const ctx = new Ctx(input);
  const total = ctx.eval(expr);
  // Damage types: each top-level summand's value goes to its type (its dice's, else the trailing one).
  const byTag: Record<string, number> = {};
  for (const [sign, node] of summands(expr, 1)) {
    const own = firstTag(node);
    const tag = own ?? parsed.tag ?? "untyped";
    byTag[tag] = (byTag[tag] ?? 0) + sign * (ctx.values.get(node) as number);
  }
  // Every term's own tag, the trailing one filling in (for display).
  if (parsed.tag) for (const t of ctx.terms) if (t.kind === "dice" && t.tag === undefined) t.tag = parsed.tag;
  const out: RollOutcome = {
    formula,
    normalized: formatNode(expr) + (parsed.tag ? ` [${parsed.tag}]` : ""),
    terms: ctx.terms,
    total,
    byTag,
  };
  const first20 = ctx.terms.find((t) => t.kind === "dice" && t.sides === 20);
  if (first20 && first20.kind === "dice") {
    const kept = first20.dice.find((d) => d.kept);
    if (kept) {
      out.natural = kept.value;
      out.crit = kept.value === 20;
      out.fumble = kept.value === 1;
    }
  }
  return out;
}

class Ctx {
  readonly input: RollInput;
  rolled = 0;
  readonly terms: RollTerm[] = [];
  /** Each node's value (for the damage-type split). */
  readonly values = new Map<DiceNode, number>();
  /** Whether what's being evaluated is subtracted (a "-" or a negation above it; two cancel). */
  sign: 1 | -1 = 1;
  constructor(input: RollInput) {
    this.input = input;
  }

  signed(): { sign?: -1 } {
    return this.sign === -1 ? { sign: -1 } : {};
  }

  die(sides: number, at: number, end: number): number {
    if (++this.rolled > DICE_LIMITS.diceTotal)
      throw new DiceError(
        `At most ${DICE_LIMITS.diceTotal} dice in one roll (rerolls and explosions count).`,
        at,
        end,
      );
    const v = this.input.die(sides);
    if (!Number.isInteger(v) || v < 1 || v > sides) throw new Error(`die(${sides}) gave ${v}`);
    return v;
  }

  eval(n: DiceNode): number {
    const v = this.evalInner(n);
    this.values.set(n, v);
    return v;
  }

  evalInner(n: DiceNode): number {
    switch (n.k) {
      case "num":
        this.terms.push({ kind: "const", value: n.v, ...this.signed() });
        return n.v;
      case "ref": {
        const v = this.input.resolve?.(n.path);
        const name = `@${n.path.join(".")}`;
        if (v === undefined || !Number.isFinite(v))
          throw new DiceError(`${name} isn't something this roller has.`, n.at, n.end);
        this.terms.push({ kind: "ref", ref: name, value: v, ...this.signed() });
        return v;
      }
      case "neg": {
        this.sign = this.sign === 1 ? -1 : 1;
        const v = -this.eval(n.x);
        this.sign = this.sign === 1 ? -1 : 1;
        return v;
      }
      case "group":
        return this.eval(n.x);
      case "bin": {
        const a = this.eval(n.a);
        // What's subtracted is recorded with its sign (the feed shows "1d20 − 4", not "+4").
        if (n.op === "-") this.sign = this.sign === 1 ? -1 : 1;
        const b = this.eval(n.b);
        if (n.op === "-") this.sign = this.sign === 1 ? -1 : 1;
        switch (n.op) {
          case "+":
            return a + b;
          case "-":
            return a - b;
          case "*":
            return a * b;
          default:
            if (b === 0) throw new DiceError("Division by zero.", 0);
            return Math.floor(a / b);
        }
      }
      case "dice":
        return this.dice(n);
    }
  }

  dice(n: DiceNode & { k: "dice" }): number {
    // A literal count is a count, not a constant term.
    const count = n.count.k === "num" ? n.count.v : this.eval(n.count);
    if (!Number.isInteger(count) || count < 1) throw new DiceError("Roll at least one die.", n.at, n.end);
    if (count > DICE_LIMITS.countPerTerm)
      throw new DiceError(`At most ${DICE_LIMITS.countPerTerm} dice in one term.`, n.at, n.end);
    const { sides } = n;
    const reroll = n.mods.find((m) => m.k === "reroll");
    const explode = n.mods.find((m) => m.k === "explode");
    const min = n.mods.find((m) => m.k === "min");
    const max = n.mods.find((m) => m.k === "max");
    const dice: (RolledDie & { raw: number })[] = [];
    const rollOne = (depth: number): void => {
      let raw = this.die(sides, n.at, n.end);
      const from: number[] = [];
      if (reroll?.k === "reroll") {
        const limit = reroll.once ? 1 : DICE_LIMITS.rerollRepeats;
        while (from.length < limit && compareMatches(reroll.cmp, raw)) {
          from.push(raw);
          raw = this.die(sides, n.at, n.end);
        }
      }
      let value = raw;
      if (min?.k === "min") value = Math.max(value, min.n);
      if (max?.k === "max") value = Math.min(value, max.n);
      const d: RolledDie & { raw: number } = { value, kept: true, exploded: false, raw };
      if (from.length) d.rerolledFrom = from;
      dice.push(d);
      if (explode?.k === "explode" && depth < DICE_LIMITS.explodeDepth) {
        const hit = explode.cmp ? compareMatches(explode.cmp, raw) : raw === sides;
        if (hit) {
          d.exploded = true;
          rollOne(depth + 1);
        }
      }
    };
    for (let i = 0; i < count; i++) rollOne(0);
    // Keep / drop, in the order written.
    for (const m of n.mods) {
      if (m.k !== "keep" && m.k !== "drop") continue;
      const live = dice.filter((d) => d.kept);
      const order = live.slice().sort((a, b) => a.value - b.value || dice.indexOf(a) - dice.indexOf(b));
      const k = Math.min(m.n, live.length);
      // keep high n = drop the lowest (len − n); keep low n = drop the highest; drop high/low n directly.
      const toDrop =
        m.k === "keep"
          ? m.high
            ? order.slice(0, live.length - k)
            : order.slice(k)
          : m.high
            ? order.slice(live.length - k)
            : order.slice(0, k);
      for (const d of toDrop) d.kept = false;
    }
    const subtotal = dice.reduce((s, d) => s + (d.kept ? d.value : 0), 0);
    const term: RollTerm = {
      kind: "dice",
      count,
      sides,
      dice: dice.map(({ raw: _raw, ...d }) => d),
      subtotal,
      ...this.signed(),
    };
    if (n.tag) term.tag = n.tag;
    this.terms.push(term);
    return subtotal;
  }
}

/** The top-level summands of an expression with their signs. */
function summands(n: DiceNode, sign: number): [number, DiceNode][] {
  if (n.k === "bin" && (n.op === "+" || n.op === "-"))
    return [...summands(n.a, sign), ...summands(n.b, n.op === "-" ? -sign : sign)];
  return [[sign, n]];
}

function firstTag(n: DiceNode): string | undefined {
  switch (n.k) {
    case "dice":
      return n.tag;
    case "neg":
    case "group":
      return firstTag(n.x);
    case "bin":
      return firstTag(n.a) ?? firstTag(n.b);
    default:
      return undefined;
  }
}

function replaceNode(n: DiceNode, from: DiceNode, to: DiceNode): DiceNode {
  if (n === from) return to;
  switch (n.k) {
    case "neg":
      return { ...n, x: replaceNode(n.x, from, to) };
    case "group":
      return { ...n, x: replaceNode(n.x, from, to) };
    case "bin":
      return { ...n, a: replaceNode(n.a, from, to), b: replaceNode(n.b, from, to) };
    default:
      return n;
  }
}
