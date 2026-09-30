import { ChevronDown, MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ButtonVariant, buttonClass, IconButton } from "./Button.tsx";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/** Room kept between an open menu and the screen's edges (px). */
const EDGE = 8;

/** Where an open menu stands (fixed, in screen px) and how tall it may be. */
interface Place {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
}

/**
 * An inline overflow menu (a popover, never a modal; SPEC §27.6): arrow keys move, Enter/Space activate, Esc and
 * outside clicks close, focus returns to the button. It opens on the page itself (never clipped by a scrolling panel),
 * below its button — or above when there's more room there (or `up` asks for it and there's room) — and never taller
 * than the screen allows: past that its items scroll.
 */
export function Menu({
  label,
  items,
  align = "end",
  text,
  up = false,
  tone,
  wide = false,
  trigger,
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
  /** Its button drawn as the caller's (a phone tab bar's "More" tab): its classes and what's in it. */
  trigger?: { className: string; content: ReactNode; testId?: string };
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [placeKey, setPlaceKey] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  // Placed against its button in screen space, on the side with room (measured before it shows); again on a resize.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placeKey is the resize's cue to measure again
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const b = button.current?.getBoundingClientRect();
    const el = list.current;
    if (!b || !el) return;
    const want = el.scrollHeight;
    const below = window.innerHeight - b.bottom - EDGE - 4;
    const above = b.top - EDGE - 4;
    const goUp = up ? above >= Math.min(want, 160) || above > below : below < want && above > below;
    const horizontal =
      align === "end"
        ? { right: Math.max(EDGE, window.innerWidth - b.right) }
        : { left: Math.max(EDGE, Math.min(b.left, window.innerWidth - EDGE - el.offsetWidth)) };
    setPlace({
      ...horizontal,
      ...(goUp ? { bottom: window.innerHeight - b.top + 4 } : { top: b.bottom + 4 }),
      maxHeight: Math.max(96, goUp ? above : below),
    });
  }, [open, up, align, placeKey]);
  useEffect(() => {
    if (!open) return;
    // The panel it's anchored in scrolled: it follows its button — and closes once the button has scrolled out of the
    // panel's view, rather than float adrift. (Not at the first scroll: one still settling as it opened — a fling's
    // tail, a button scrolled into view to be clicked — would close it as it opens.) A scroll elsewhere — the page, the
    // feed — leaves it be; a resize places it again.
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      const b = button.current;
      if (!target || !b || list.current?.contains(target)) return;
      if (target === document || !(target instanceof Element) || !target.contains(b)) return;
      const r = b.getBoundingClientRect();
      const v = target.getBoundingClientRect();
      const gone = r.bottom <= v.top || r.top >= v.bottom || r.right <= v.left || r.left >= v.right;
      if (gone) setOpen(false);
      else setPlaceKey((k) => k + 1);
    };
    const onResize = () => setPlaceKey((k) => k + 1);
    window.addEventListener("resize", onResize);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const first = list.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    // (Without scrolling: a fixed menu needs none, and a phone page nudged by it would read as the menu moving.)
    first?.focus({ preventScroll: true });
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
    <div className={wide ? "relative w-full" : trigger ? "relative flex" : "relative"}>
      {trigger ? (
        <button
          ref={button}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          data-testid={trigger.testId}
          onClick={() => setOpen((o) => !o)}
          className={trigger.className}
        >
          {trigger.content}
        </button>
      ) : text ? (
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
      {open
        ? createPortal(
            <div
              ref={list}
              id={id}
              role="menu"
              aria-label={label}
              className="panel fixed z-[1000] min-w-[200px] overflow-y-auto py-1"
              style={
                place
                  ? {
                      top: place.top,
                      bottom: place.bottom,
                      left: place.left,
                      right: place.right,
                      maxHeight: place.maxHeight,
                    }
                  : { top: 0, left: 0, visibility: "hidden" }
              }
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
