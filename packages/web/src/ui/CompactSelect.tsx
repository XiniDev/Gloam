/**
 * A native select for tight tool bars (phones): no label above it (the aria-label names it), 36 px tall (44 on touch),
 * the brass caret of the ink chrome. Keyboard and screen-reader friendly by default, and the platform's own picker on touch.
 */
export function CompactSelect<T extends string>({
  value,
  onChange,
  options,
  label,
  testId,
}: {
  value: T | "";
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  testId?: string;
}) {
  return (
    <select
      aria-label={label}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-9 min-h-[var(--touch-min)] appearance-none rounded-[var(--radius-control)] border border-line bg-ink-900 pl-3 pr-8 text-14 text-bone hover:border-line-strong focus:border-brass"
      style={{
        backgroundImage:
          "linear-gradient(45deg, transparent 50%, var(--brass-400) 50%), linear-gradient(135deg, var(--brass-400) 50%, transparent 50%)",
        backgroundPosition: "calc(100% - 16px) 50%, calc(100% - 11px) 50%",
        backgroundSize: "5px 5px, 5px 5px",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* "Mixed" only when the value is none of the options (a multi-selection with differing values). */}
      {!options.some((o) => o.value === value) ? (
        <option value={value} disabled className="bg-ink-900">
          Mixed
        </option>
      ) : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-ink-900">
          {o.label}
        </option>
      ))}
    </select>
  );
}
