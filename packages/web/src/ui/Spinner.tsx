import { D20_EDGES, D20_FACE, D20_OUTLINE } from "../icons/dice.tsx";

/** A small spinning d20 (SPEC §28 Button loading state; a roll waiting on its dice): the d20 glyph, turning. */
export function D20Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="animate-[d20-spin_1.1s_linear_infinite]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={D20_OUTLINE} />
      <path d={D20_FACE} strokeWidth="1.5" />
      <path d={D20_EDGES} strokeWidth="1.1" opacity=".7" />
    </svg>
  );
}
