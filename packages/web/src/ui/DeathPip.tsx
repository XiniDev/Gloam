/**
 * A death save's pip (SPEC §28 Pips: death saves are hearts and skulls; §30.2): a success a heart, a failure a skull —
 * drawn from the icon set's own heart ("stable") and skull ("dead"), filled when marked, an outline still to come.
 * Never a stock icon (§27.6) and never a diamond (the slot pip).
 */
export function DeathPip({
  kind,
  filled,
  size = 20,
}: {
  kind: "success" | "failure";
  filled: boolean;
  size?: number;
}) {
  const heart = kind === "success";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      data-filled={filled ? "" : undefined}
      className={filled ? (heart ? "text-[var(--verdigris-400)]" : "text-[var(--blood-500)]") : "text-faint"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {heart ? (
        <path
          d="M12 20.2C12 20.2 4.2 15.6 4.2 9.9A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7.8 1.9c0 5.7-7.8 10.3-7.8 10.3Z"
          fill={filled ? "currentColor" : "none"}
        />
      ) : (
        <>
          <path
            d="M6.2 11.2a5.8 5.8 0 0 1 11.6 0v2.6l-1.5 1.1v2.8H7.7v-2.8l-1.5-1.1z"
            fill={filled ? "currentColor" : "none"}
          />
          <circle
            cx="9.6"
            cy="11.6"
            r="1.55"
            fill={filled ? "var(--ink-950)" : "currentColor"}
            stroke="none"
          />
          <circle
            cx="14.4"
            cy="11.6"
            r="1.55"
            fill={filled ? "var(--ink-950)" : "currentColor"}
            stroke="none"
          />
          <path d="M10.3 17.7v2.4M13.7 17.7v2.4M8.4 20.1h7.2" />
        </>
      )}
    </svg>
  );
}
