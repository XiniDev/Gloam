import { DAMAGE_TYPES } from "@gloam/shared";

const KNOWN = new Set<string>([...DAMAGE_TYPES, "healing"]);

/** A damage type as a small chip in its own colour (§27.2 --dmg-*). */
export function TypeChip({ type }: { type: string }) {
  return (
    <span
      className="inline-flex items-center rounded-[var(--radius-chip)] px-1.5 align-baseline font-sans text-12 font-bold"
      style={{
        color: `var(--dmg-${type})`,
        background: `color-mix(in srgb, var(--dmg-${type}) 16%, transparent)`,
      }}
    >
      {type}
    </span>
  );
}

/**
 * A dice formula as the table reads it: its dice and numbers in mono, each damage-type tag a chip in its colour —
 * "1d4 + 2 [piercing]" never shows the parser's brackets (critic P9 r2). Inline, so a line that truncates still does;
 * a tag that isn't a damage type stays as written.
 */
export function FormulaText({ formula }: { formula: string }) {
  const parts = formula.split(/(\[[a-z]+\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[([a-z]+)\]$/.exec(p);
        const key = `${i}${p}`;
        if (m?.[1] && KNOWN.has(m[1])) return <TypeChip key={key} type={m[1]} />;
        const t = p.trim();
        return t ? (
          <span key={key} className="mono">
            {i ? " " : ""}
            {t}
            {i < parts.length - 1 ? " " : ""}
          </span>
        ) : null;
      })}
    </>
  );
}
