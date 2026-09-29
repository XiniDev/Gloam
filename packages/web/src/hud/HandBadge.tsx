/** A raised hand on a portrait (SPEC §8.18): a brass disc with an open hand, in its top-right corner. */
export function HandBadge({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`grid place-items-center rounded-full bg-accent ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label="Hand raised"
      data-testid="hand-badge"
    >
      <svg
        width={Math.round(size * 0.61)}
        height={Math.round(size * 0.61)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--ink-950)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13c0 4.5-2.5 8-6.5 8-2.5 0-4.2-1.3-5.4-3.4L3.4 14.4a1.6 1.6 0 0 1 2.6-1.8L8 15" />
      </svg>
    </span>
  );
}
