import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { KeyHint } from "./KeyHint.tsx";

/** SPEC §28 Tooltip: 400 ms delay, shows a shortcut hint; positioned above the trigger, clamped to the viewport. */
export function Tooltip({
  label,
  shortcut,
  children,
}: {
  label: ReactNode;
  shortcut?: string;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  const ref = useRef<HTMLElement | null>(null);
  const id = useId();

  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    // Touch screens have no hover: a tooltip there only lingers over the thing just tapped.
    if (typeof matchMedia === "function" && matchMedia("(hover: none)").matches) return;
    timer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = r.top < 56;
      setPos({ x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
      setOpen(true);
    }, 400);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!isValidElement(children)) return <>{children}</>;
  // The trigger keeps its own ref and handlers (a Menu measures its button through its ref): composed, not replaced.
  const own = children.props as {
    ref?: Ref<HTMLElement>;
    onPointerEnter?: (e: unknown) => void;
    onPointerLeave?: (e: unknown) => void;
    onFocus?: (e: unknown) => void;
    onBlur?: (e: unknown) => void;
  };
  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: (el: HTMLElement | null) => {
      ref.current = el;
      if (typeof own.ref === "function") own.ref(el);
      else if (own.ref) (own.ref as { current: HTMLElement | null }).current = el;
    },
    onPointerEnter: (e: unknown) => {
      own.onPointerEnter?.(e);
      show();
    },
    onPointerLeave: (e: unknown) => {
      own.onPointerLeave?.(e);
      hide();
    },
    // Keyboard focus only: a dialog focusing its close button, or a click, isn't a request for the tooltip.
    onFocus: (e: { currentTarget: HTMLElement }) => {
      own.onFocus?.(e);
      if (e.currentTarget.matches(":focus-visible")) show();
    },
    onBlur: (e: unknown) => {
      own.onBlur?.(e);
      hide();
    },
    "aria-describedby": open ? id : undefined,
  });
  return (
    <>
      {child}
      {open &&
        pos &&
        createPortal(
          // The placement on an outer box, the rise-in animation on the inner one: an animated transform would
          // override the placement's while it runs (the tooltip drew over its own trigger, then jumped).
          <div
            className="pointer-events-none fixed z-[1000]"
            style={{
              left: Math.min(window.innerWidth - 140, Math.max(140, pos.x)),
              top: pos.y,
              transform: `translate(-50%, ${pos.below ? "0" : "-100%"})`,
            }}
          >
            <div
              id={id}
              role="tooltip"
              className="w-max max-w-[260px] rounded-[var(--radius-chip)] border border-line bg-ink-800 px-2.5 py-1.5 text-13 text-bone shadow-[var(--shadow-float)] animate-[rise-in_var(--dur-fast)_var(--ease-out)]"
            >
              <span className="flex items-center gap-2">
                {label}
                {shortcut ? <KeyHint keys={shortcut} /> : null}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
