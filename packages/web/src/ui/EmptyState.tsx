import type { ReactNode } from "react";

type Art = "candle" | "map" | "die" | "door" | "scroll";

function Illustration({ art }: { art: Art }) {
  const stroke = "var(--brass-600)";
  const common = {
    fill: "none",
    stroke,
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (art) {
    case "candle":
      return (
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <path
            d="M32 10c4 5.5 6.5 9 6.5 13a6.5 6.5 0 0 1-13 0c0-4 2.5-7.5 6.5-13z"
            {...common}
            fill="var(--glow-candle)"
          />
          <path
            d="M32 18c1.8 2.5 2.8 4 2.8 5.8a2.8 2.8 0 0 1-5.6 0c0-1.8 1-3.3 2.8-5.8z"
            fill="var(--ember-400)"
            stroke="none"
            opacity=".8"
          />
          <rect x="25" y="32" width="14" height="22" rx="2" {...common} />
          <path d="M20 54h24" {...common} />
        </svg>
      );
    case "map":
      return (
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <path d="M10 16l14-5 16 5 14-5v37l-14 5-16-5-14 5z" {...common} />
          <path d="M24 11v37M40 16v37" {...common} opacity=".6" />
          <path d="M16 30c5-3 8 3 14 0s8-4 14 1" {...common} strokeDasharray="2 3" />
          <path d="M44 38l3 3m0-3l-3 3" {...common} />
        </svg>
      );
    case "die":
      return (
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <path d="M32 8l20 11.5v25L32 56 12 44.5v-25z" {...common} />
          <path d="M32 8L21 27h22zM21 27l-9 17.5M43 27l9 17.5M21 27l11 29 11-29" {...common} opacity=".6" />
        </svg>
      );
    case "door":
      return (
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <path d="M18 56V20a14 14 0 0 1 28 0v36" {...common} />
          <path d="M14 56h36M32 8v48" {...common} opacity=".55" />
          <circle cx="38" cy="36" r="1.6" fill={stroke} />
        </svg>
      );
    case "scroll":
      return (
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <path d="M18 12h28a4 4 0 0 1 4 4v32a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z" {...common} />
          <path d="M24 22h20M24 29h20M24 36h14" {...common} opacity=".6" />
        </svg>
      );
  }
}

/** SPEC §28 EmptyState: a small line illustration, one sentence, one action (no blank panels, AC-DS-05). */
export function EmptyState({
  art = "candle",
  title,
  action,
}: {
  art?: Art;
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    // A short screen on its side keeps the words and the action, not the picture (critic RSP-01 r1: at 844 × 390 the
    // sheet's Quick create was cut off below a candle).
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center short:gap-2 short:py-3">
      <span className="contents short:hidden">
        <Illustration art={art} />
      </span>
      <p className="max-w-[34ch] text-14 text-muted">{title}</p>
      {action}
    </div>
  );
}
