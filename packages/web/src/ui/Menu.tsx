import { ChevronDown, MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type ButtonVariant, buttonClass, IconButton } from "./Button.tsx";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/**
 * An inline overflow menu (a popover, never a modal; SPEC §27.6): arrow keys move, Enter/Space activate, Esc and
 * outside clicks close, focus returns to the button.
 */
export function Menu({
  label,
  items,
  align = "end",
  text,
  up = false,
  tone,
  wide = false,
}: {
  label: string;
  items: MenuItem[];
  align?: "start" | "end";
  /** Opens upward (a menu at the bottom of the screen). */
  up?: boolean;
  /** A short visible label for the button ("+4") instead of the "…" glyph. */
  text?: string;
  /** The labelled button drawn as a Button of this variant (a dialog's main action), instead of a quiet text button. */
  tone?: ButtonVariant;
  /** As wide as its container (a phone dialog's stacked actions). */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    first?.focus();
    const onDoc = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className={wide ? "relative w-full" : "relative"}>
      {text ? (
        <button
          ref={button}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((o) => !o)}
          className={
            tone
              ? `${buttonClass(tone, "M")} ${wide ? "w-full" : ""}`
              : "inline-flex h-9 min-h-[var(--touch-min)] items-center gap-1 rounded-[var(--radius-control)] px-2 text-13 font-bold text-muted hover:bg-raised hover:text-text"
          }
        >
          {text}
          <ChevronDown size={14} aria-hidden />
        </button>
      ) : (
        <IconButton
          ref={button}
          label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <MoreHorizontal size={17} />
        </IconButton>
      )}
      {open ? (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={`panel absolute z-50 min-w-[200px] py-1 ${up ? "bottom-full mb-1" : "top-full mt-1"} ${align === "end" ? "right-0" : "left-0"}`}
          onKeyDown={(e) => {
            const buttons = [
              ...(list.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []),
            ];
            const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              buttons[(i + 1) % buttons.length]?.focus();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.hint}
              onClick={() => {
                close();
                it.onSelect();
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-14 transition-colors duration-[var(--dur-fast)] disabled:opacity-40 ${
                it.danger ? "text-danger-text hover:bg-[var(--danger-soft)]" : "text-bone hover:bg-raised"
              }`}
            >
              {it.icon ? <span className="text-muted">{it.icon}</span> : null}
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
