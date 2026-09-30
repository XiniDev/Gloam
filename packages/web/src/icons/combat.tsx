import type { SVGProps } from "react";

/**
 * Combat glyphs (SPEC §30.1 grammar: 24 × 24, 1.75 strokes, round caps and joins, currentColor), each its own
 * silhouette so none reads as another at 16 px: the movement range (a creature's base with the dashed limit of how far
 * it reaches round it), free movement (a boot with speed lines: no turn holds anyone back), stop combat (crossed swords
 * with a bar struck across them), begin (the die's outline, going on), and held (two links of a chain).
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

/**
 * How far a creature can go: its base, the dashed limit round it (the range overlay, §8.6), and the reach measured
 * out to it — no crown on top, so it never reads as a stopwatch (critic P8 r2 N5).
 */
export function ReachIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.2" strokeDasharray="3.6 2.6" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <path d="M13.8 13.8 18.4 18.4" />
      <path d="M16.2 19.6 19.6 16.2" />
    </Svg>
  );
}

/** Everyone moves freely (the DM's switch, §8.12): a boot with speed lines behind it (critic P8 r2 N11: not a flag). */
export function FreeMoveIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M9.5 3.5h5v8.2l4.9 2.4a2.2 2.2 0 0 1 1.2 2V19.5H9.5Z" />
      <path d="M9.5 16.5h11.1" />
      <path d="M2.5 8h4.5M3.5 11.5h3.5M2.5 15h4.5" />
    </Svg>
  );
}

/** Crossed swords with their hilts — guards across the blades, grips and pommels — so they never read as an ×. */
function Swords() {
  return (
    <>
      <path d="M4 4 15.2 15.2" />
      <path d="M12.6 17.8 17.8 12.6" />
      <path d="M15.2 15.2 18.6 18.6" />
      <circle cx="19.6" cy="19.6" r="1.1" />
      <path d="M20 4 8.8 15.2" />
      <path d="M6.2 12.6 11.4 17.8" />
      <path d="M8.8 15.2 5.4 18.6" />
      <circle cx="4.4" cy="19.6" r="1.1" />
    </>
  );
}

/** Combat (§8.12): the crossed swords, hilts and all (the DM panel's section). */
export function CombatIcon(p: P) {
  return (
    <Svg {...p}>
      <Swords />
    </Svg>
  );
}

/** Stop combat (§8.12, AC-CMB-11): the crossed swords, a bar struck across their blades. */
export function StopCombatIcon(p: P) {
  return (
    <Svg {...p}>
      <Swords />
      <path d="M3 9.5h18" strokeWidth={2.4} />
    </Svg>
  );
}

/** Begin the fight (§8.12: round 1 from the initiative order): the die's outline, a mark of going on inside it. */
export function BeginIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 2.5 20.2 7.2v9.6L12 21.5l-8.2-4.7V7.2Z" />
      <path d="M10 8.6v6.8l5.6-3.4Z" fill="currentColor" />
    </Svg>
  );
}

/** Held where it stands (Grappled, Restrained, Speed 0; §8.6 "Can't move — Grappled"): two links of a chain. */
export function HeldIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="2.6" y="8.6" width="11" height="6.8" rx="3.4" transform="rotate(-45 8.1 12)" />
      <rect x="10.4" y="8.6" width="11" height="6.8" rx="3.4" transform="rotate(-45 15.9 12)" />
    </Svg>
  );
}
