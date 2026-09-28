/**
 * Editing a dice formula as text (the tray's quick buttons and steppers, SPEC §8.9): the text is the truth, so a
 * formula typed by hand and one built from buttons are the same thing. Plus the tokens for highlighting and the `@`
 * references offered while typing.
 */

const TERM = (sides: number) => new RegExp(`(^|[+\\-\\s(])(\\d*)d${sides}(?![0-9%a-z!\\[])`, "i");

/** Adds one die of a size: `2d6` → `3d6`, or a new `+ 1d6` term. */
export function addDie(formula: string, sides: number | "%"): string {
  const s = sides === "%" ? "%" : String(sides);
  const f = stripAdv(formula).trim();
  const m = sides === "%" ? f.match(/(^|[+\-\s(])(\d*)d%/) : f.match(TERM(sides as number));
  if (m) {
    const at = (m.index ?? 0) + (m[1] as string).length;
    const n = Number(m[2] || "1") + 1;
    if (n > 100) return formula;
    return withAdv(
      `${f.slice(0, at)}${n}d${s}${f.slice(at + (m[2] as string).length + 1 + s.length)}`,
      formula,
    );
  }
  return withAdv(f ? `${f} + 1d${s}` : `1d${s}`, formula);
}

/** Takes one die of a size away (the term goes when it's the last). */
export function removeDie(formula: string, sides: number | "%"): string {
  const s = sides === "%" ? "%" : String(sides);
  const f = stripAdv(formula).trim();
  const m = sides === "%" ? f.match(/(^|[+\-\s(])(\d*)d%/) : f.match(TERM(sides as number));
  if (!m) return formula;
  const at = (m.index ?? 0) + (m[1] as string).length;
  const n = Number(m[2] || "1") - 1;
  const rest = f.slice(at + (m[2] as string).length + 1 + s.length);
  if (n >= 1) return withAdv(`${f.slice(0, at)}${n}d${s}${rest}`, formula);
  // Drop the term and the operator joining it.
  const before = f.slice(0, at).replace(/\s*[+]\s*$/, "");
  const after = before ? rest : rest.replace(/^\s*\+\s*/, "");
  return withAdv(`${before}${after}`.trim(), formula);
}

/** The count of the last dice term, stepped (1…100). */
export function stepCount(formula: string, delta: number): string {
  const f = stripAdv(formula);
  const re = /(\d*)d(\d+|%)/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(f); m; m = re.exec(f)) last = m;
  if (!last) return formula;
  const n = Math.min(100, Math.max(1, Number(last[1] || "1") + delta));
  return withAdv(`${f.slice(0, last.index)}${n}d${last[2]}${f.slice(last.index + last[0].length)}`, formula);
}

/** The dice term the count stepper steps (the last one), for its display: `2d6 + 1d20` → 1 × d20; none → null. */
export function countOf(formula: string): { count: number; die: string } | null {
  const re = /(\d*)d(\d+|%)/gi;
  let last: RegExpExecArray | null = null;
  const f = stripAdv(formula);
  for (let m = re.exec(f); m; m = re.exec(f)) last = m;
  if (!last) return null;
  return { count: Number(last[1] || "1"), die: `d${last[2] === "%" ? "100" : last[2]}` };
}

/** The trailing modifier stepped: `1d20 + 5` → `1d20 + 6`; a new one added, a zero one removed. */
export function stepModifier(formula: string, delta: number): string {
  const f = stripAdv(formula).trim();
  const m = f.match(/\s*([+-])\s*(\d+)$/);
  let base = f;
  let value = 0;
  if (m && /d/i.test(f.slice(0, m.index))) {
    base = f.slice(0, m.index);
    value = (m[1] === "-" ? -1 : 1) * Number(m[2]);
  }
  const v = value + delta;
  if (!base) return withAdv(String(v), formula);
  return withAdv(v === 0 ? base : `${base} ${v > 0 ? "+" : "-"} ${Math.abs(v)}`, formula);
}

/** The modifier at the end, for the stepper's display. */
export function modifierOf(formula: string): number {
  const f = stripAdv(formula).trim();
  const m = f.match(/\s*([+-])\s*(\d+)$/);
  if (!m || !/d/i.test(f.slice(0, m.index))) return 0;
  return (m[1] === "-" ? -1 : 1) * Number(m[2]);
}

export function advOf(formula: string): "adv" | "dis" | null {
  const m = formula.trim().match(/\s(adv|dis)$/i);
  return m ? ((m[1] as string).toLowerCase() as "adv" | "dis") : null;
}

/** Sets (or clears) advantage: a trailing `adv` / `dis`. */
export function setAdv(formula: string, adv: "adv" | "dis" | null): string {
  const f = stripAdv(formula).trim();
  return adv ? `${f} ${adv}` : f;
}

function stripAdv(f: string): string {
  return f.replace(/\s+(adv|dis)\s*$/i, "");
}
function withAdv(next: string, was: string): string {
  const a = advOf(was);
  return a ? `${next} ${a}` : next;
}

export type TokenKind = "dice" | "number" | "op" | "ref" | "tag" | "keyword" | "space" | "other";

/** The formula as coloured pieces (not a parser: the parser says what's wrong, this only colours). */
export function tokenize(f: string): { text: string; kind: TokenKind; at: number }[] {
  const out: { text: string; kind: TokenKind; at: number }[] = [];
  const re =
    /(\s+)|(\d*d(?:\d+|%)(?:kh|kl|k|dh|dl|ro|r|!|min|max|[<>=]{1,2}|\d)*)|(@[a-z_][a-z0-9_.]*)|(\[[^\]]*\]?)|\b(adv|dis)\b|(\d+)|([+\-*/()])|(.)/gi;
  for (let m = re.exec(f); m; m = re.exec(f)) {
    const kind: TokenKind = m[1]
      ? "space"
      : m[2]
        ? "dice"
        : m[3]
          ? "ref"
          : m[4]
            ? "tag"
            : m[5]
              ? "keyword"
              : m[6]
                ? "number"
                : m[7]
                  ? "op"
                  : "other";
    out.push({ text: m[0], kind, at: m.index });
  }
  return out;
}

/** `@` references a roller may use before character sheets (the token's own numbers); sheets add the rest (P6). */
export const REFS = [
  { ref: "@dex", hint: "Dexterity modifier" },
  { ref: "@init", hint: "Initiative bonus" },
  { ref: "@str.save", hint: "Strength save" },
  { ref: "@dex.save", hint: "Dexterity save" },
  { ref: "@con.save", hint: "Constitution save" },
  { ref: "@int.save", hint: "Intelligence save" },
  { ref: "@wis.save", hint: "Wisdom save" },
  { ref: "@cha.save", hint: "Charisma save" },
];

/** The `@…` being typed at the caret, if any. */
export function refAt(f: string, caret: number): { start: number; text: string } | null {
  const m = f.slice(0, caret).match(/@[a-z_][a-z0-9_.]*$|@$/i);
  return m ? { start: caret - m[0].length, text: m[0] } : null;
}
