/**
 * Evaluates the small arithmetic formulas Foundry uses for sizes and counts (e.g. "20 * @item.level",
 * "@item.level - 1") without eval: numbers, + - * /, parentheses and the single variable @item.level.
 * Any other token makes the formula unsupported (null), which the merge reports.
 */

type Token = { kind: "num"; value: number } | { kind: "var" } | { kind: "op"; value: string };

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " ") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i));
      if (!m) return null;
      tokens.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (src.startsWith("@item.level", i)) {
      tokens.push({ kind: "var" });
      i += "@item.level".length;
      continue;
    }
    if ("+-*/()".includes(c)) {
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    return null;
  }
  return tokens;
}

/** Returns a function of the slot level, or null when the formula uses anything unsupported. */
export function compileLevelFormula(src: string): ((level: number) => number) | null {
  const tokens = tokenize(src.trim());
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;
  let ok = true;
  const peek = () => tokens[pos];
  type Node = (l: number) => number;
  const expr = (): Node => {
    let left = term();
    for (let t = peek(); t?.kind === "op" && (t.value === "+" || t.value === "-"); t = peek()) {
      pos++;
      const right = term();
      const l = left;
      left = t.value === "+" ? (x) => l(x) + right(x) : (x) => l(x) - right(x);
    }
    return left;
  };
  const term = (): Node => {
    let left = factor();
    for (let t = peek(); t?.kind === "op" && (t.value === "*" || t.value === "/"); t = peek()) {
      pos++;
      const right = factor();
      const l = left;
      left = t.value === "*" ? (x) => l(x) * right(x) : (x) => l(x) / right(x);
    }
    return left;
  };
  const factor = (): Node => {
    const t = tokens[pos++];
    if (!t) {
      ok = false;
      return () => 0;
    }
    if (t.kind === "num") return () => t.value;
    if (t.kind === "var") return (x) => x;
    if (t.value === "-") {
      const inner = factor();
      return (x) => -inner(x);
    }
    if (t.value === "(") {
      const inner = expr();
      if (tokens[pos]?.kind !== "op" || (tokens[pos] as { value: string }).value !== ")") ok = false;
      pos++;
      return inner;
    }
    ok = false;
    return () => 0;
  };
  const fn = expr();
  if (!ok || pos !== tokens.length) return null;
  return fn;
}

/** Value at the spell's own level and the growth per slot level above it (linear formulas only). */
export function linearAtLevel(src: string, level: number): { base: number; perSlot: number } | null {
  const fn = compileLevelFormula(src);
  if (!fn) return null;
  const base = fn(level);
  const perSlot = fn(level + 1) - base;
  // Linear check: the growth must be constant over the slot range.
  for (let l = level + 1; l < 9; l++) {
    if (Math.abs(fn(l + 1) - fn(l) - perSlot) > 1e-9) return null;
  }
  if (!Number.isFinite(base) || !Number.isFinite(perSlot)) return null;
  return { base, perSlot };
}
