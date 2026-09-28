import { type ReactNode, useId, useState } from "react";

/** Brass-thumb switch (SPEC §28 Toggle). */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-16 font-medium text-bone">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-13 text-muted">{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`hit relative mt-0.5 inline-flex shrink-0 items-center justify-center disabled:opacity-45`}
      >
        <span
          className={`relative block h-6 w-11 rounded-full border transition-colors duration-[var(--dur-base)] ${
            checked ? "border-brass-deep bg-brass-dark" : "border-line bg-ink-900"
          }`}
        >
          <span
            className={`absolute top-[3px] block h-4 w-4 rounded-full transition-[left,background-color] duration-[var(--dur-base)] ease-[var(--ease-out)] ${
              checked
                ? "left-[22px] bg-brass-bright shadow-[0_0_10px_var(--glow-brass)]"
                : "left-[3px] bg-fog-dim"
            }`}
          />
        </span>
      </button>
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
}

/** Segmented control (radio group) with a brass underline on the active segment. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "M",
  phoneColumns,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  label: string;
  size?: "S" | "M";
  /** On phones, lay the segments out in this many even columns instead of letting the row wrap unevenly. */
  phoneColumns?: 2 | 3 | 4;
}) {
  const layout =
    phoneColumns === 2
      ? "grid grid-cols-2 sm:inline-flex sm:flex-wrap"
      : phoneColumns === 3
        ? "grid grid-cols-3 sm:inline-flex sm:flex-wrap"
        : phoneColumns === 4
          ? "grid grid-cols-4 sm:inline-flex sm:flex-wrap"
          : "inline-flex flex-wrap";
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`${layout} gap-1 rounded-[var(--radius-control)] border border-line bg-ink-900 p-1`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={`relative inline-flex min-h-[var(--touch-min)] min-w-[var(--touch-min)] items-center justify-center whitespace-nowrap rounded-chip px-3 font-bold transition-colors duration-[var(--dur-fast)] disabled:opacity-40 ${
              size === "S" ? "h-8 text-13" : "h-9 text-14"
            } ${active ? "bg-raised text-brass-bright shadow-[inset_0_-2px_0_var(--brass-400)]" : "text-muted hover:text-bone"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Native select styled for the ink chrome (keyboard and screen-reader friendly by default). */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  id,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  id?: string;
}) {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <div>
      <label htmlFor={sid} className="caps mb-1.5 block truncate text-12 text-fog" title={label}>
        {label}
      </label>
      <select
        id={sid}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-11 w-full appearance-none rounded-[var(--radius-control)] border border-line bg-ink-900 bg-[length:12px] bg-[right_12px_center] bg-no-repeat px-3 pr-8 text-14 text-bone hover:border-line-strong focus:border-brass"
        style={{
          backgroundImage:
            "linear-gradient(45deg, transparent 50%, var(--brass-400) 50%), linear-gradient(135deg, var(--brass-400) 50%, transparent 50%)",
          backgroundPosition: "calc(100% - 16px) 50%, calc(100% - 11px) 50%",
          backgroundSize: "5px 5px, 5px 5px",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-ink-900">
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Slider (SPEC §28): a native range input (keyboard and screen-reader friendly) with a brass thumb on an ink track and
 * a value bubble while it's being moved or focused.
 */
export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  format = (v) => `${Math.round(v * 100)}%`,
  disabled = false,
  className = "",
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (v: number) => string;
  disabled?: boolean;
  className?: string;
}) {
  const [active, setActive] = useState(false);
  const f = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  return (
    <div className={`relative flex items-center ${className}`}>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={format(value)}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={() => setActive(true)}
        onPointerUp={() => setActive(false)}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        className="gloam-range w-full"
        style={{ ["--fill" as string]: `${f * 100}%` }}
      />
      {active ? (
        <span
          aria-hidden
          className="tabular pointer-events-none absolute -top-6 -translate-x-1/2 rounded-chip border border-line bg-ink-950 px-1.5 text-12 text-brass-bright"
          style={{ left: `calc(8px + ${f} * (100% - 16px))` }}
        >
          {format(value)}
        </span>
      ) : null}
    </div>
  );
}
