import { type HTMLAttributes, type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * A scrolling area whose edges say there's more (critic P7 r2 #9, P8 r1 #7): at an edge with more to scroll that way,
 * a hairline and the content fading into the surface over 16 px — a control under the fold is never a secret, and
 * never sliced through. The dialogs' body, the settings popover.
 */
export function ScrollFade({
  children,
  className = "",
  testId,
  outerClassName = "flex-1",
  scrollerProps,
}: {
  children: ReactNode;
  /** The scroller's own classes (its padding). */
  className?: string;
  testId?: string;
  /** The frame's own classes (its size in its parent: a column's height by default). */
  outerClassName?: string;
  /** The scroller's attributes (a rail's tablist role and its keys). */
  scrollerProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ up: false, down: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const up = el.scrollTop > 1;
      const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setMore((m) => (m.up === up && m.down === down ? m : { up, down }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);
  return (
    <div className={`relative flex min-h-0 flex-col ${outerClassName}`}>
      <div ref={ref} {...scrollerProps} className={`min-h-0 flex-1 overflow-y-auto ${className}`}>
        {children}
      </div>
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 transition-opacity duration-[var(--dur-fast)] ${more.up ? "opacity-100" : "opacity-0"}`}
      >
        <span className="block h-px bg-[var(--border)]" />
        <span className="block h-4 bg-gradient-to-b from-[var(--surface)] to-transparent" />
      </span>
      <span
        aria-hidden
        data-testid={testId}
        data-more={more.down}
        className={`pointer-events-none absolute inset-x-0 bottom-0 transition-opacity duration-[var(--dur-fast)] ${more.down ? "opacity-100" : "opacity-0"}`}
      >
        <span className="block h-4 bg-gradient-to-t from-[var(--surface)] to-transparent" />
        <span className="block h-px bg-[var(--border)]" />
      </span>
    </div>
  );
}
