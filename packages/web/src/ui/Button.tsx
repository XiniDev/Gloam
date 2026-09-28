import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { D20Spinner } from "./Spinner.tsx";
import { Tooltip } from "./Tooltip.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "S" | "M" | "L";

const BASE =
  "relative inline-flex min-h-[var(--touch-min)] select-none items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] font-ui font-bold tracking-[0.01em] transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)] active:translate-y-px disabled:pointer-events-none disabled:opacity-45";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-[var(--on-accent)] shadow-[inset_0_1px_0_var(--brass-300),0_6px_16px_var(--glow-brass-soft)] hover:bg-brass-bright",
  secondary: "border border-brass-deep/70 bg-raised text-text hover:border-brass hover:bg-ink-700",
  ghost: "text-muted hover:bg-raised hover:text-text",
  danger: "border border-danger text-danger-text hover:bg-danger hover:text-bone",
};

const SIZE: Record<ButtonSize, string> = {
  S: "h-8 px-3 text-13",
  M: "h-10 px-4 text-14",
  L: "h-12 px-6 text-16",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

/** SPEC §28 Button: primary (brass fill, ink text), secondary, ghost, danger; S/M/L; d20 loading spinner. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "M",
    loading = false,
    icon,
    className = "",
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <D20Spinner size={size === "L" ? 18 : 15} /> : icon}
      <span>{children}</span>
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  active?: boolean;
  tone?: "default" | "danger" | "accent";
}

/** SPEC §28 IconButton: 36 px (44 px on touch), tooltip with a shortcut hint, always an accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, active = false, tone = "default", className = "", children, type = "button", ...rest },
  ref,
) {
  const toneCls =
    tone === "danger"
      ? "text-danger-text hover:bg-[var(--danger-soft)]"
      : tone === "accent"
        ? "text-accent hover:bg-[var(--glow-brass-soft)]"
        : // Selected (§27.4): a brass icon inside a 1-px brass hairline with a 2-px outer glow — louder than a hover,
          // which only raises the tile and lights the icon bone.
          active
          ? "bg-[var(--glow-brass-soft)] text-brass shadow-[inset_0_0_0_1px_var(--brass-400),0_0_0_2px_var(--glow-brass)]"
          : "text-muted hover:bg-raised hover:text-bone";
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active || undefined}
        className={`hit inline-flex items-center justify-center rounded-[var(--radius-control)] transition-colors duration-[var(--dur-fast)] ${toneCls} ${className}`}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});
