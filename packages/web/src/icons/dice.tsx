import type { SVGProps } from "react";

/**
 * Dice glyphs (SPEC §30.1 grammar: 24 × 24, 1.75 strokes, round caps and joins, currentColor; §27.6: dice are game
 * concepts, never a stock icon). The d20 is an icosahedron seen point-on — its hexagonal outline, the face turned to
 * you, the edges running out to the rim — and reads as a d20 by its outline alone at 16 px. The spark marks an exploded
 * die: a four-pointed star, filled (a silhouette reads better than strokes at chip size).
 */
type P = SVGProps<SVGSVGElement> & { size?: number };

/** The d20's outline, front face and rim edges (shared by the icon and the spinner). */
export const D20_OUTLINE = "M12 2.4 20.4 7.2v9.6L12 21.6l-8.4-4.8V7.2z";
export const D20_FACE = "M12 7.6 16.3 15H7.7z";
export const D20_EDGES =
  "M12 2.4v5.2M20.4 7.2 16.3 15M3.6 7.2 7.7 15M20.4 16.8 16.3 15M3.6 16.8 7.7 15M12 21.6 16.3 15M12 21.6 7.7 15";

export function D20Icon({ size = 18, ...rest }: P) {
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
      <path d={D20_OUTLINE} />
      <path d={D20_FACE} strokeWidth={1.5} />
      <path d={D20_EDGES} strokeWidth={1.1} opacity={0.75} />
    </svg>
  );
}

export function SparkIcon({ size = 12, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden {...rest}>
      <path d="M12 1.5c.9 5.6 3.2 8.7 10.5 10.5-7.3 1.8-9.6 4.9-10.5 10.5-.9-5.6-3.2-8.7-10.5-10.5C8.8 10.2 11.1 7.1 12 1.5z" />
    </svg>
  );
}

/**
 * A roll made by hand (SPEC §8.9 "a hand icon for manual entries"; "I rolled physically…"): a cupped hand holding a
 * die — a cube seen corner-on, so it isn't the d20 and the hand isn't the Pan tool's open palm.
 */
export function HandDieIcon({ size = 16, ...rest }: P) {
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
      <path d="M14.2 2.6 18.6 5.1v5L14.2 12.6 9.8 10.1v-5z" />
      <path d="M9.8 5.1 14.2 7.6l4.4-2.5M14.2 7.6v5" strokeWidth={1.2} opacity={0.75} />
      <path d="M2.5 14h3c1 0 1.9.3 2.6.9l1.4 1h3.2a1.5 1.5 0 0 1 0 3H9" />
      <path d="M2.5 21h9.4c1.3 0 2.5-.5 3.4-1.3l5.1-4.6a1.5 1.5 0 0 0-2-2.3l-3.4 2.8" />
    </svg>
  );
}

/** A pushpin (pinning a roll to the tray's chips; §27.4's brass pin for pinned items), in the current colour. */
export function PinGlyph({ size = 16, ...rest }: P) {
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
      <circle cx="14.5" cy="8.5" r="4.2" />
      <path d="M11.6 11.4 6 17M5 19l1-2" />
      <path d="M12.9 4.6c-1 .1-1.9.6-2.5 1.3" strokeWidth={1.2} opacity={0.7} />
    </svg>
  );
}
