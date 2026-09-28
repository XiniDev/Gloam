/**
 * The dice formula grammar (SPEC §18.1): a hand-written recursive-descent parser. It gives each error the place in
 * the formula it was found (for the tray's inline errors) and enforces the limits that can be known before rolling.
 */

/** Limits (SPEC §18.1, AC-DICE-09). */
export const DICE_LIMITS = {
  formulaLength: 200,
  countPerTerm: 100,
  diceTotal: 500,
  sidesMin: 1,
  sidesMax: 1000,
  explodeDepth: 20,
  rerollRepeats: 20,
} as const;

export type CompareOp = "<" | ">" | "<=" | ">=" | "=";
export interface Compare {
  op: CompareOp;
  n: number;
}

export type Modifier =
  | { k: "keep"; high: boolean; n: number }
  | { k: "drop"; high: boolean; n: number }
  | { k: "reroll"; once: boolean; cmp: Compare }
  | { k: "explode"; cmp: Compare | null }
  | { k: "min"; n: number }
  | { k: "max"; n: number };

export type DiceNode =
  | { k: "num"; v: number; at: number }
  | {
      k: "dice";
      /** The count: a number, or a parenthesised expression rolled first. */
      count: DiceNode;
      sides: number;
      /** Written as d%. */
      percent: boolean;
      mods: Modifier[];
      tag?: string;
      at: number;
      end: number;
    }
  | { k: "ref"; path: string[]; at: number; end: number }
  | { k: "neg"; x: DiceNode }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: DiceNode; b: DiceNode }
  | { k: "group"; x: DiceNode };

export interface ParsedFormula {
  expr: DiceNode;
  /** A trailing tag: types every term without a tag of its own. */
  tag?: string;
  adv?: "adv" | "dis";
}

/** A formula error, with where it is (character offsets into the formula). */
export class DiceError extends Error {
  readonly at: number;
  readonly end: number;
  constructor(message: string, at: number, end = at + 1) {
    super(message);
    this.name = "DiceError";
    this.at = at;
    this.end = end;
  }
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /[0-9]+/y;
const TAG = /\[([^\]\n]*)\]/y;

class Parser {
  readonly s: string;
  i = 0;
  constructor(s: string) {
    this.s = s;
  }

  ws(): boolean {
    const start = this.i;
    while (this.i < this.s.length && /\s/.test(this.s[this.i] as string)) this.i++;
    return this.i > start;
  }
  peek(n = 1): string {
    return this.s.slice(this.i, this.i + n);
  }
  eat(t: string): boolean {
    if (this.s.startsWith(t, this.i)) {
      this.i += t.length;
      return true;
    }
    return false;
  }
  number(): number | null {
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    const v = Number(m[0]);
    if (!Number.isSafeInteger(v))
      throw new DiceError("That number is too large.", this.i - m[0].length, this.i);
    return v;
  }
  tag(): string | null {
    TAG.lastIndex = this.i;
    const m = TAG.exec(this.s);
    if (!m) {
      if (this.peek() === "[")
        throw new DiceError("A type is written in square brackets, like [fire].", this.i);
      return null;
    }
    this.i += m[0].length;
    const t = (m[1] as string).trim();
    if (!t) throw new DiceError("The type in brackets is empty.", this.i - m[0].length, this.i);
    if (t.length > 40) throw new DiceError("A type is at most 40 characters.", this.i - m[0].length, this.i);
    return t.toLowerCase();
  }

  formula(): ParsedFormula {
    this.ws();
    if (this.i >= this.s.length) throw new DiceError("Type a formula, like 1d20+5.", 0);
    const expr = this.expr();
    const out: ParsedFormula = { expr };
    this.ws();
    const tag = this.tag();
    if (tag !== null) out.tag = tag;
    this.ws();
    const kw = this.s.slice(this.i).match(/^(adv|dis)\b/i);
    if (kw) {
      out.adv = (kw[1] as string).toLowerCase() as "adv" | "dis";
      this.i += (kw[0] as string).length;
      this.ws();
    }
    if (this.i < this.s.length) {
      const c = this.s[this.i] as string;
      if (c === "[" && out.adv)
        throw new DiceError("adv or dis goes at the very end, after the type.", this.i);
      if (c === "[") throw new DiceError("A type goes right after its dice, like 1d8[fire].", this.i);
      throw new DiceError(`Unexpected “${c}”.`, this.i);
    }
    return out;
  }

  expr(): DiceNode {
    let a = this.term();
    for (;;) {
      const save = this.i;
      this.ws();
      const c = this.peek();
      if (c === "+" || c === "-") {
        this.i++;
        this.ws();
        a = { k: "bin", op: c, a, b: this.term() };
      } else {
        this.i = save;
        return a;
      }
    }
  }

  term(): DiceNode {
    let a = this.factor();
    for (;;) {
      const save = this.i;
      this.ws();
      const c = this.peek();
      if (c === "*" || c === "/") {
        this.i++;
        this.ws();
        a = { k: "bin", op: c, a, b: this.factor() };
      } else {
        this.i = save;
        return a;
      }
    }
  }

  factor(): DiceNode {
    if (this.eat("-")) {
      this.ws();
      return { k: "neg", x: this.factor() };
    }
    return this.primary();
  }

  primary(): DiceNode {
    const at = this.i;
    const c = this.peek();
    if (c === "(") {
      this.i++;
      this.ws();
      const x = this.expr();
      this.ws();
      if (!this.eat(")")) throw new DiceError("A bracket “(” isn't closed.", at, this.i);
      const group: DiceNode = { k: "group", x };
      // A parenthesised count: (1d4+1)d6.
      if (this.peek() === "d" || this.peek() === "D") return this.dice(group, at);
      return group;
    }
    if (c === "@") {
      this.i++;
      const path: string[] = [];
      for (;;) {
        IDENT.lastIndex = this.i;
        const m = IDENT.exec(this.s);
        if (!m)
          throw new DiceError("A reference is a name after @, like @str or @skill.stealth.", at, this.i + 1);
        path.push(m[0].toLowerCase());
        this.i += m[0].length;
        if (this.peek() === "." && /[A-Za-z_]/.test(this.s[this.i + 1] ?? "")) this.i++;
        else break;
      }
      return { k: "ref", path, at, end: this.i };
    }
    if (c === "d" || c === "D") return this.dice({ k: "num", v: 1, at }, at);
    const n = this.number();
    if (n !== null) {
      if (this.peek() === "d" || this.peek() === "D") return this.dice({ k: "num", v: n, at }, at);
      return { k: "num", v: n, at };
    }
    if (this.i >= this.s.length)
      throw new DiceError("The formula ends too soon.", Math.max(0, this.i - 1), this.i);
    throw new DiceError(`Unexpected “${c}”.`, this.i);
  }

  dice(count: DiceNode, at: number): DiceNode {
    this.i++; // the d
    if (count.k === "num" && count.v > DICE_LIMITS.countPerTerm)
      throw new DiceError(`At most ${DICE_LIMITS.countPerTerm} dice in one term.`, at, this.i - 1);
    if (count.k === "num" && count.v < 1) throw new DiceError("Roll at least one die.", at, this.i - 1);
    let sides: number;
    let percent = false;
    const sidesAt = this.i;
    if (this.eat("%")) {
      sides = 100;
      percent = true;
    } else {
      const n = this.number();
      if (n === null) throw new DiceError("How many sides? For example d20.", sidesAt);
      sides = n;
      if (sides < DICE_LIMITS.sidesMin || sides > DICE_LIMITS.sidesMax)
        throw new DiceError(
          `Dice have ${DICE_LIMITS.sidesMin} to ${DICE_LIMITS.sidesMax} sides.`,
          sidesAt,
          this.i,
        );
    }
    const mods: Modifier[] = [];
    for (;;) {
      const mAt = this.i;
      const two = this.peek(2).toLowerCase();
      const three = this.peek(3).toLowerCase();
      if (three === "min" || three === "max") {
        this.i += 3;
        const n = this.number();
        if (n === null) throw new DiceError(`${three} needs a number, like ${three}3.`, mAt, this.i);
        if (n < 1 || n > sides) throw new DiceError(`${three}${n} is outside the die's faces.`, mAt, this.i);
        mods.push({ k: three, n });
      } else if (two === "kh" || two === "kl") {
        this.i += 2;
        mods.push({ k: "keep", high: two === "kh", n: this.number() ?? 1 });
      } else if (two === "dh" || two === "dl") {
        this.i += 2;
        mods.push({ k: "drop", high: two === "dh", n: this.number() ?? 1 });
      } else if (two === "ro") {
        this.i += 2;
        mods.push({ k: "reroll", once: true, cmp: this.compare() ?? { op: "=", n: 1 } });
      } else if (this.peek().toLowerCase() === "k") {
        this.i += 1;
        mods.push({ k: "keep", high: true, n: this.number() ?? 1 });
      } else if (this.peek().toLowerCase() === "r") {
        this.i += 1;
        mods.push({ k: "reroll", once: false, cmp: this.compare() ?? { op: "=", n: 1 } });
      } else if (this.peek() === "!") {
        this.i += 1;
        mods.push({ k: "explode", cmp: this.compare() });
      } else break;
      const last = mods[mods.length - 1] as Modifier;
      if (last.k === "reroll" && matchesAll(last.cmp, sides))
        throw new DiceError("That reroll matches every face.", mAt, this.i);
    }
    const node: DiceNode = { k: "dice", count, sides, percent, mods, at, end: this.i };
    // A tag right after its dice (no space): 1d8[fire].
    const tag = this.peek() === "[" ? this.tag() : null;
    if (tag !== null) node.tag = tag;
    else {
      // Written with a space but followed by more formula: still this term's type (1d8 [fire] + 1d6).
      const save = this.i;
      if (this.ws() && this.peek() === "[") {
        const tAt = this.i;
        const t = this.tag() as string;
        const after = this.i;
        this.ws();
        const rest = this.s.slice(this.i);
        // More formula after it (an operator or a closing bracket): this term's; otherwise the formula's trailing tag.
        if (!/^[-+*/)]/.test(rest)) this.i = tAt;
        else {
          node.tag = t;
          this.i = after;
          return { ...node, end: after };
        }
      }
      this.i = save;
    }
    return { ...node, end: this.i };
  }

  compare(): Compare | null {
    const at = this.i;
    let op: CompareOp = "=";
    if (this.eat("<=")) op = "<=";
    else if (this.eat(">=")) op = ">=";
    else if (this.eat("<")) op = "<";
    else if (this.eat(">")) op = ">";
    else if (this.eat("=")) op = "=";
    const n = this.number();
    if (n === null) {
      if (this.i > at) throw new DiceError("A comparison needs a number, like >5.", at, this.i);
      return null;
    }
    return { op, n };
  }
}

export function compareMatches(c: Compare, v: number): boolean {
  switch (c.op) {
    case "<":
      return v < c.n;
    case ">":
      return v > c.n;
    case "<=":
      return v <= c.n;
    case ">=":
      return v >= c.n;
    default:
      return v === c.n;
  }
}

function matchesAll(c: Compare, sides: number): boolean {
  for (let v = 1; v <= sides; v++) if (!compareMatches(c, v)) return false;
  return true;
}

/** Parses a formula; throws DiceError with the place of the problem. */
export function parseFormula(formula: string): ParsedFormula {
  if (formula.length > DICE_LIMITS.formulaLength)
    throw new DiceError(
      `A formula is at most ${DICE_LIMITS.formulaLength} characters.`,
      DICE_LIMITS.formulaLength,
      formula.length,
    );
  return new Parser(formula).formula();
}

/** Validation for the tray (no throw): null when the formula is fine, else the error. */
export function checkFormula(formula: string): DiceError | null {
  try {
    const p = parseFormula(formula);
    if (p.adv && !findD20(p.expr))
      return new DiceError(
        "Advantage needs a single d20 (1d20) in the formula.",
        formula.length - 3,
        formula.length,
      );
    return null;
  } catch (e) {
    if (e instanceof DiceError) return e;
    throw e;
  }
}

/** The first plain 1d20 term (the one advantage turns into 2d20kh1). */
export function findD20(n: DiceNode): (DiceNode & { k: "dice" }) | null {
  switch (n.k) {
    case "dice":
      if (n.sides === 20 && !n.percent && n.count.k === "num" && n.count.v === 1 && n.mods.length === 0)
        return n;
      return null;
    case "neg":
    case "group":
      return findD20(n.x);
    case "bin":
      return findD20(n.a) ?? findD20(n.b);
    default:
      return null;
  }
}
