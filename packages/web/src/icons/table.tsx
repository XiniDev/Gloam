import type { SVGProps } from "react";

/**
 * The table's own glyphs for its game concepts where the DM finds them — the DM panel's sections and the board's tools
 * (SPEC §27.6: no stock icon for a game concept; §30.1 grammar: 24 × 24, 1.75 strokes, round caps and joins,
 * currentColor): health (a heart, its lower part filled like a gauge), an effect (a spark over its patch of ground), a
 * spellbook (a book with a star on its cover), and walls (a wall in plan with its door swung open).
 */
type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Hit points (§8.11): a heart, filled to a level like the HP bar — not a pulse line. */
export function HealthIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 20.5s-7.8-4.7-7.8-10.4A4.4 4.4 0 0 1 12 7.5a4.4 4.4 0 0 1 7.8 2.6c0 5.7-7.8 10.4-7.8 10.4Z" />
      <path
        d="M5.3 14h13.4C16.7 17.7 12 20.5 12 20.5S7.3 17.7 5.3 14Z"
        fill="currentColor"
        stroke="none"
        opacity={0.45}
      />
      <path d="M5.3 14h13.4" />
    </Svg>
  );
}

/** A lasting effect on the board (§12.3: Web, Moonbeam, a wall of fire): a spark over the patch of ground it holds. */
export function EffectIcon(p: P) {
  return (
    <Svg {...p}>
      <ellipse cx="12" cy="17.5" rx="8.5" ry="3.2" strokeDasharray="3 2.2" />
      <path d="M12 3.2l1.3 3.4 3.4 1.3-3.4 1.3L12 12.6l-1.3-3.4-3.4-1.3 3.4-1.3Z" />
    </Svg>
  );
}

/** Spells (§8.13, the campaign's homebrew): a spellbook, a star on its cover. */
export function SpellbookIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M5 5.2A2.2 2.2 0 0 1 7.2 3h11.3v15.2H7.2A2.2 2.2 0 0 0 5 20.4Z" />
      <path d="M5 20.4A2.2 2.2 0 0 0 7.2 22.6h11.3v-4.4" />
      <path d="M11.8 6.8l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9Z" />
    </Svg>
  );
}

/** Walls and doors (§11): a wall seen from above, broken by a door swung open on its hinge. */
export function WallsIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M2.5 14.5h6.2M15.3 14.5h6.2" strokeWidth={3.2} strokeLinecap="square" />
      <path d="M15.3 14.5V7.9" strokeWidth={2.4} />
      <path d="M15.3 7.9a6.6 6.6 0 0 0-6.6 6.6" strokeWidth={1.1} strokeDasharray="1.4 1.6" />
    </Svg>
  );
}
