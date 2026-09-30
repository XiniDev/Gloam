import type { CSSProperties } from "react";
import { initialsOf, shortInitialsOf } from "./initials.ts";
import { WaxSeal } from "./ornaments.tsx";

/**
 * A person's or creature's portrait (SPEC §27.4: circles only for portraits, pips and the dice button): their picture,
 * or their initials, in a ring of their colour — a DM's in brass, with the wax seal on the rim at four o'clock.
 */
export function Portrait({
  name,
  color,
  size = 32,
  src,
  dm,
  dim = false,
  sealRoom = false,
}: {
  name: string;
  color: string;
  size?: number;
  src?: string | null;
  /** "DM" or "Host": the seal. */
  dm?: "DM" | "Host";
  dim?: boolean;
  /** Keep the seal's overhang clear of what follows in a row (a name beside it). */
  sealRoom?: boolean;
}) {
  const ring = size >= 28 ? 1.5 : 1;
  const ringColor = dm ? "var(--brass-400)" : color || "var(--border)";
  // Big enough to read as a seal — its scalloped wax and embossed star — not a notification dot (critic P11 r2 N21).
  const seal = Math.max(18, Math.round(size * 0.56));
  // The seal's centre on a circle just outside the rim, at four o'clock (30° below the horizontal).
  const sealX = size / 2 + size * 0.56 * Math.cos(Math.PI / 6) - seal / 2;
  const sealY = size / 2 + size * 0.56 * Math.sin(Math.PI / 6) - seal / 2;
  return (
    <span
      className="relative inline-block shrink-0"
      style={{
        width: size,
        height: size,
        marginRight: dm && sealRoom ? Math.round(sealX + seal - size) : undefined,
      }}
    >
      <span
        data-part="face"
        className="grid h-full w-full place-items-center overflow-hidden rounded-full bg-ink-800 font-caps leading-none text-bone [font-size:var(--mono)] pointer-coarse:[font-size:max(13px,var(--mono))]"
        style={
          {
            boxShadow: `0 0 0 ${size >= 28 ? 2 : 1.5}px var(--ink-950), 0 0 0 ${(size >= 28 ? 2 : 1.5) + ring}px ${ringColor}`,
            opacity: dim ? 0.45 : 1,
            // Never under the HUD's 12 px (13 on touch; §27.3, critic P8 r2 B5).
            ["--mono" as string]: `${Math.max(12, Math.round(size * 0.38))}px`,
          } as CSSProperties
        }
        aria-hidden
      >
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <Monogram text={size < 28 ? shortInitialsOf(name) : initialsOf(name)} />
        )}
      </span>
      {dm ? (
        <span className="absolute" style={{ left: Math.round(sealX), top: Math.round(sealY) }}>
          <WaxSeal size={seal} label={dm} />
        </span>
      ) : null}
    </span>
  );
}

/** Initials with any figures in the UI face's lining numerals (Cinzel's small figures read "2" as "z"). */
function Monogram({ text }: { text: string }) {
  return (
    <span className="whitespace-nowrap">
      {text.split(/(\d+)/).map((part, i) =>
        /^\d+$/.test(part) ? (
          <span key={i} className="font-ui font-bold tabular">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}
