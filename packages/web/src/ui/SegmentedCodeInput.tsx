import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef } from "react";

const CROCKFORD = /[0-9A-HJKMNP-TV-Z]/;

/** Crockford normalisation: uppercase, I/L → 1, O → 0, drop everything else. */
export function normaliseCode(s: string): string {
  return s
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .split("")
    .filter((c) => CROCKFORD.test(c))
    .join("");
}

/**
 * SPEC §28 SegmentedCodeInput: one box per character, a dash between groups, paste-aware, auto-uppercase.
 * `kind="invite"` → 10 Crockford characters as XXXXX-XXXXX; `kind="pin"` → digits, masked, 4–8 long.
 */
export function SegmentedCodeInput({
  value,
  onChange,
  onComplete,
  kind = "invite",
  length = kind === "invite" ? 10 : 4,
  label,
  autoFocus = false,
  invalid = false,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  kind?: "invite" | "pin";
  length?: number;
  label: string;
  autoFocus?: boolean;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const clean = (s: string) => (kind === "pin" ? s.replace(/\D/g, "") : normaliseCode(s));
  const chars = value.slice(0, length).split("");

  // Focus the first empty box once, on mount only (re-running on every keystroke would steal focus).
  const initialFocus = useRef({ autoFocus, index: Math.min(value.length, length - 1) });
  useEffect(() => {
    if (initialFocus.current.autoFocus) refs.current[initialFocus.current.index]?.focus();
  }, []);

  const setFrom = (next: string, focusAt: number) => {
    const v = clean(next).slice(0, length);
    onChange(v);
    refs.current[Math.min(focusAt, length - 1)]?.focus();
    if (v.length === length) onComplete?.(v);
  };

  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (chars[i]) setFrom(value.slice(0, i) + value.slice(i + 1), i);
      else if (i > 0) setFrom(value.slice(0, i - 1) + value.slice(i), i - 1);
    } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < length - 1) refs.current[i + 1]?.focus();
    else if (e.key === "Enter" && value.length === length) onComplete?.(value);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = clean(e.clipboardData.getData("text"));
    setFrom(pasted, pasted.length);
  };

  const box = (i: number) => (
    <input
      key={i}
      ref={(el) => {
        refs.current[i] = el;
      }}
      aria-label={`${label} character ${i + 1} of ${length}`}
      inputMode={kind === "pin" ? "numeric" : "text"}
      autoComplete={kind === "pin" ? "off" : "one-time-code"}
      autoCapitalize="characters"
      spellCheck={false}
      disabled={disabled}
      type={kind === "pin" ? "password" : "text"}
      value={chars[i] ?? ""}
      onChange={(e) => {
        const typed = clean(e.target.value);
        if (!typed) return;
        const next = (value.slice(0, i) + typed + value.slice(i + 1)).slice(0, length);
        setFrom(next, i + typed.length);
      }}
      onKeyDown={(e) => onKey(i, e)}
      onPaste={onPaste}
      onFocus={(e) => e.currentTarget.select()}
      className={`mono h-12 w-9 rounded-[var(--radius-control)] border bg-ink-900 text-center text-22 font-semibold text-bone shadow-[var(--shadow-inset)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus:border-brass focus:shadow-[var(--ring-focus)] sm:w-10 ${
        invalid ? "border-danger" : chars[i] ? "border-brass-deep" : "border-line"
      }`}
    />
  );

  return (
    <fieldset className="border-0 p-0" aria-label={label}>
      <legend className="sr-only">{label}</legend>
      <div className="flex items-center justify-center gap-1.5 sm:gap-2">
        {kind === "invite" ? (
          <>
            {Array.from({ length: 5 }, (_, i) => box(i))}
            <span aria-hidden className="mx-0.5 h-[2px] w-3 bg-brass-deep" />
            {Array.from({ length: 5 }, (_, i) => box(i + 5))}
          </>
        ) : (
          Array.from({ length }, (_, i) => box(i))
        )}
      </div>
    </fieldset>
  );
}
