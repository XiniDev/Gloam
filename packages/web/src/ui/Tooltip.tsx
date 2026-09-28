import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
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
  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: (el: HTMLElement | null) => {
      ref.current = el;
    },
    onPointerEnter: show,
    onPointerLeave: hide,
    onFocus: show,
    onBlur: hide,
    "aria-describedby": open ? id : undefined,
  });
  return (
    <>
      {child}
      {open &&
        pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-[1000] w-max max-w-[260px] rounded-[var(--radius-chip)] border border-line bg-ink-800 px-2.5 py-1.5 text-13 text-bone shadow-[var(--shadow-float)] animate-[rise-in_var(--dur-fast)_var(--ease-out)]"
            style={{
              left: Math.min(window.innerWidth - 140, Math.max(140, pos.x)),
              top: pos.y,
              transform: `translate(-50%, ${pos.below ? "0" : "-100%"})`,
            }}
          >
            <span className="flex items-center gap-2">
              {label}
              {shortcut ? <KeyHint keys={shortcut} /> : null}
            </span>
          </div>,
          document.body,
        )}
    </>
  );
}
