import { forwardRef, type InputHTMLAttributes, type ReactNode, useId } from "react";

export function Label({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between gap-3">
      <span className="caps text-12 text-fog">{children}</span>
      {hint ? <span className="text-12 text-faint">{hint}</span> : null}
    </label>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  help?: ReactNode;
  mono?: boolean;
}

/** Text input on ink with a brass focus hairline (SPEC §27.4); errors inline, never modal. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, hint, error, help, mono = false, id, className = "", ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errId = `${inputId}-err`;
  const helpId = `${inputId}-help`;
  return (
    <div className={className}>
      {label ? (
        <Label htmlFor={inputId} hint={hint}>
          {label}
        </Label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errId : null, help ? helpId : null].filter(Boolean).join(" ") || undefined}
        className={`h-11 w-full rounded-[var(--radius-control)] border bg-ink-900 px-3 text-16 text-bone shadow-[var(--shadow-inset)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-faint focus:border-brass focus:shadow-[var(--ring-focus)] ${
          error ? "border-danger" : "border-line hover:border-line-strong"
        } ${mono ? "mono tracking-[0.12em]" : ""}`}
        {...rest}
      />
      {help && !error ? (
        <p id={helpId} className="mt-1.5 text-13 text-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="mt-1.5 text-13 text-[var(--ember-400)]">
          {error}
        </p>
      ) : null}
    </div>
  );
});
