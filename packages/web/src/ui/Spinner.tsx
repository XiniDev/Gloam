/** A small spinning d20 outline (SPEC §28 Button loading state). */
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
      strokeLinejoin="round"
    >
      <path d="M12 2.5 20.6 7.4v9.2L12 21.5 3.4 16.6V7.4z" />
      <path
        d="M12 2.5 7.4 10h9.2zM7.4 10 3.4 16.6M16.6 10l4 6.6M7.4 10 12 21.5 16.6 10"
        strokeWidth="1.2"
        opacity=".7"
      />
    </svg>
  );
}
