import { WaxSeal } from "./ornaments.tsx";

/** Up to two initials of a name. */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/**
 * A person's or creature's portrait (SPEC §27.4: circles only for portraits, pips and the dice button): their picture,
 * or their initials, in a ring of their colour; a DM's wax seal on its lower-right edge.
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
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size, marginRight: dm && sealRoom ? Math.round(size * 0.34) : undefined }}
    >
      <span
        className="grid h-full w-full place-items-center overflow-hidden rounded-full bg-ink-800 font-caps text-bone"
        style={{
          boxShadow: `0 0 0 ${size >= 28 ? 2 : 1.5}px var(--ink-950), 0 0 0 ${(size >= 28 ? 2 : 1.5) + ring}px ${color || "var(--border)"}`,
          opacity: dim ? 0.45 : 1,
          fontSize: Math.max(10, Math.round(size * 0.38)),
        }}
        aria-hidden
      >
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          initialsOf(name)
        )}
      </span>
      {dm ? (
        <span className="absolute" style={{ right: -size * 0.3, bottom: -size * 0.18 }}>
          <WaxSeal size={Math.max(14, Math.round(size * 0.56))} label={dm} />
        </span>
      ) : null}
    </span>
  );
}
