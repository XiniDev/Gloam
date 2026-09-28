/** Brass ornaments (SPEC §27.4): engraved divider, corner filigree, wax-seal DM badge, candle glyph. */

export function Divider({ className = "" }: { className?: string }) {
  return <div role="separator" className={`engraved-divider ${className}`} />;
}

/** Corner filigree for modals and parchment cards. Place inside a `relative` container. */
export function Filigree({ tone = "brass" }: { tone?: "brass" | "ink" }) {
  const stroke = tone === "brass" ? "var(--brass-600)" : "var(--parchment-ink-muted)";
  const corner = (rot: number, pos: string) => (
    <svg
      aria-hidden
      width="34"
      height="34"
      viewBox="0 0 34 34"
      className={`pointer-events-none absolute ${pos}`}
      style={{ transform: `rotate(${rot}deg)` }}
      fill="none"
      stroke={stroke}
      strokeWidth="1"
    >
      <path d="M2 18V6a4 4 0 0 1 4-4h12" />
      <path d="M6 22V10a4 4 0 0 1 4-4h12" opacity=".55" />
      <path d="M2 6c5 0 8 3 8 8" opacity=".7" />
      <circle cx="10.5" cy="10.5" r="1.4" fill={stroke} stroke="none" />
    </svg>
  );
  return (
    <>
      {corner(0, "left-1.5 top-1.5")}
      {corner(90, "right-1.5 top-1.5")}
      {corner(180, "bottom-1.5 right-1.5")}
      {corner(270, "bottom-1.5 left-1.5")}
    </>
  );
}

/**
 * The "DM" wax seal (SPEC §27.4). Its letters only where they're legible (≥ 22 px, 12-px caps or near it); smaller, an
 * embossed star in the wax — the role is its accessible name either way.
 */
export function WaxSeal({ label = "DM", size = 26 }: { label?: string; size?: number }) {
  const lettered = size >= 22;
  return (
    <span
      className="relative inline-grid place-items-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden>
        <path
          d="M13 1.5c1.6 0 2.2 1.4 3.6 1.9 1.5.5 3-.3 4 .8 1 1.1.4 2.6 1 4 .6 1.3 2 1.9 2 3.4 0 1.6-1.4 2.2-1.9 3.6-.5 1.5.3 3-.8 4-1.1 1-2.6.4-4 1-1.3.6-1.9 2-3.4 2s-2.2-1.4-3.6-1.9c-1.5-.5-3 .3-4-.8-1-1.1-.4-2.6-1-4-.6-1.3-2-1.9-2-3.4 0-1.6 1.4-2.2 1.9-3.6.5-1.5-.3-3 .8-4 1.1-1 2.6-.4 4-1C10.8 2.9 11.4 1.5 13 1.5z"
          fill="var(--wax-500)"
        />
        <circle
          cx="13"
          cy="13"
          r="7.2"
          fill="none"
          stroke="var(--glow-ember)"
          strokeWidth={lettered ? 1 : 1.4}
        />
        {lettered ? null : (
          <path
            d="M13 8.4c.35 2.6 1.1 3.9 4.6 4.6-3.5.7-4.25 2-4.6 4.6-.35-2.6-1.1-3.9-4.6-4.6 3.5-.7 4.25-2 4.6-4.6z"
            fill="var(--parchment-100)"
            opacity=".9"
          />
        )}
        {lettered ? (
          <text
            x="13"
            y="15.6"
            textAnchor="middle"
            fontFamily="var(--font-caps)"
            fontWeight="700"
            fontSize={label.length > 2 ? 5.4 : 7.5}
            letterSpacing=".4"
            fill="var(--parchment-100)"
          >
            {label.toUpperCase()}
          </text>
        ) : null}
      </svg>
    </span>
  );
}

/** The ✦ mark used next to the wordmark. */
export function Sparkle({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="var(--brass-400)">
      <path d="M12 1.5c.6 5.2 2.3 7.9 10.5 10.5-8.2 2.6-9.9 5.3-10.5 10.5C11.4 17.3 9.7 14.6 1.5 12 9.7 9.4 11.4 6.7 12 1.5z" />
    </svg>
  );
}

/** The brass pin (SPEC §27.4 ornaments: "a brass pin for pinned items"): a domed brass head on a short needle. */
export function BrassPin({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M11 13 5 19" stroke="var(--brass-600)" strokeWidth="2.2" strokeLinecap="round" />
      <circle
        cx="14.5"
        cy="9.5"
        r="5.5"
        fill="var(--brass-400)"
        stroke="var(--brass-600)"
        strokeWidth="1.2"
      />
      <path
        d="M12.3 6.7c.8-.7 1.8-1 2.9-.9"
        stroke="var(--brass-300)"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
