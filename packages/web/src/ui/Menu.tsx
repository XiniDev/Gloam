import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { IconButton } from "./Button.tsx";

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
}: {
  label: string;
  items: MenuItem[];
  align?: "start" | "end";
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
    <div className="relative">
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
      {open ? (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={`panel absolute top-full z-50 mt-1 min-w-[200px] py-1 ${align === "end" ? "right-0" : "left-0"}`}
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
