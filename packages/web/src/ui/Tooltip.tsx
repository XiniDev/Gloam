import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { KeyHint } from "./KeyHint.tsx";

/** Where a tooltip stands beside its trigger. */
export type Side = "above" | "below" | "left" | "right";
/** Room kept between a tooltip and the screen's edge, and between it and its trigger (px). */
const MARGIN = 8;
/** A trigger this close to the screen's left or right edge is on a rail: its tooltip stands beside it (px). */
const RAIL = 72;

/**
 * SPEC §28 Tooltip: 400 ms delay, shows a shortcut hint. Above the trigger — below one at the top of the screen, and
 * beside one on a rail at the screen's side (the dock's rail, the toolbar), centred on it — measured and clamped
 * inside the screen. It goes the moment the trigger is pressed, and stands under the toasts (critic P11 r1 B5).
 */
export function Tooltip({
  label,
  shortcut,
  side,
  children,
}: {
  label: ReactNode;
  shortcut?: string;
  /** Where it stands, when its trigger's place on screen doesn't say (a rail inside a panel: beside it). */
  side?: Side;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null);
  const tip = useRef<HTMLDivElement>(null);
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
      const cy = r.top + r.height / 2;
      const cx = r.left + r.width / 2;
      if (side === "left") setPos({ x: r.left - MARGIN, y: cy, side });
      else if (side === "right") setPos({ x: r.right + MARGIN, y: cy, side });
      else if (side === "above") setPos({ x: cx, y: r.top - MARGIN, side });
      else if (side === "below") setPos({ x: cx, y: r.bottom + MARGIN, side });
      else if (r.right > window.innerWidth - RAIL && r.top >= 56)
        setPos({ x: r.left - MARGIN, y: cy, side: "left" });
      else if (r.left < RAIL && r.top >= 56 && r.width < RAIL)
        setPos({ x: r.right + MARGIN, y: cy, side: "right" });
      else if (r.top < 56) setPos({ x: r.left + r.width / 2, y: r.bottom + MARGIN, side: "below" });
      else setPos({ x: r.left + r.width / 2, y: r.top - MARGIN, side: "above" });
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
  // Placed by its own measured size, wholly inside the screen.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!open || !pos || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = pos.side === "left" ? pos.x - w : pos.side === "right" ? pos.x : pos.x - w / 2;
    const y = pos.side === "above" ? pos.y - h : pos.side === "below" ? pos.y : pos.y - h / 2;
    const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(v, MARGIN), max - MARGIN));
    el.style.left = `${clamp(x, window.innerWidth - w)}px`;
    el.style.top = `${clamp(y, window.innerHeight - h)}px`;
    el.style.visibility = "visible";
  }, [open, pos]);

  if (!isValidElement(children)) return <>{children}</>;
  // The trigger keeps its own ref and handlers (a Menu measures its button through its ref): composed, not replaced.
  const own = children.props as {
    ref?: Ref<HTMLElement>;
    onPointerEnter?: (e: unknown) => void;
    onPointerLeave?: (e: unknown) => void;
    onPointerDown?: (e: unknown) => void;
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
    // Pressed: what it does is what's wanted now, not its name (the tooltip would stand over what opens).
    onPointerDown: (e: unknown) => {
      own.onPointerDown?.(e);
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
          // (Above dialogs, under the toasts and menus.)
          <div
            ref={tip}
            className="pointer-events-none fixed z-[940]"
            style={{ left: 0, top: 0, visibility: "hidden" }}
            data-side={pos.side}
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
