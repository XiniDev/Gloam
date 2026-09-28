/** Formatting a parsed formula back to text (the normalized form a roll records). */
import type { Compare, DiceNode, Modifier } from "./parse.ts";

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2 } as const;

export function formatNode(n: DiceNode): string {
  switch (n.k) {
    case "num":
      return String(n.v);
    case "ref":
      return `@${n.path.join(".")}`;
    case "neg":
      return `-${wrap(n.x, 3)}`;
    case "group":
      return `(${formatNode(n.x)})`;
    case "bin": {
      const p = PREC[n.op];
      const sep = p === 1 ? ` ${n.op} ` : n.op;
      // The right side of - and / needs brackets at equal precedence.
      return `${wrap(n.a, p)}${sep}${wrap(n.b, n.op === "-" || n.op === "/" ? p + 1 : p)}`;
    }
    case "dice": {
      const count = n.count.k === "num" ? String(n.count.v) : formatNode(n.count);
      const sides = n.percent ? "%" : String(n.sides);
      return `${count}d${sides}${n.mods.map(formatMod).join("")}${n.tag ? `[${n.tag}]` : ""}`;
    }
  }
}

function wrap(n: DiceNode, min: number): string {
  const p = n.k === "bin" ? PREC[n.op] : 3;
  return p < min ? `(${formatNode(n)})` : formatNode(n);
}

function formatCmp(c: Compare): string {
  return `${c.op === "=" ? "=" : c.op}${c.n}`;
}

function formatMod(m: Modifier): string {
  switch (m.k) {
    case "keep":
      return `k${m.high ? "h" : "l"}${m.n}`;
    case "drop":
      return `d${m.high ? "h" : "l"}${m.n}`;
    case "reroll":
      return `${m.once ? "ro" : "r"}${m.cmp.op === "=" ? "" : m.cmp.op}${m.cmp.n}`;
    case "explode":
      return m.cmp ? `!${formatCmp(m.cmp)}` : "!";
    case "min":
      return `min${m.n}`;
    case "max":
      return `max${m.n}`;
  }
}
