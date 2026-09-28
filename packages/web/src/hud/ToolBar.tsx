import type { ReactNode } from "react";
import { useHudInsets, useIsPhone } from "./insets.ts";

/**
 * A board tool's options bar (Measure, Walls, Zones): a compact strip along the bottom of the board, anchored at its
 * left beside the toolbar it belongs to — so when a mode adds or drops a control the bar grows or shrinks to the
 * right and nothing already under the pointer moves (centred, every button slid as the width changed). Never over
 * the top of the map, where the prep banner, the top bar and a tool's work usually are. On a phone it takes the whole
 * width of the bottom edge and leaves out the hint, so it stays one or two short rows over the board.
 */
export function ToolBar({
  label,
  testId,
  hint,
  children,
}: {
  label: string;
  testId?: string;
  hint?: string;
  children: ReactNode;
}) {
  const left = useHudInsets((s) => s.left);
  const right = useHudInsets((s) => s.right);
  const phone = useIsPhone();
  return (
    <div
      className={`pointer-events-none absolute bottom-3 z-30 flex px-3 ${phone ? "justify-center" : "justify-start"}`}
      style={phone ? { left: 0, right: 0 } : { left, right }}
    >
      <section
        aria-label={label}
        data-testid={testId}
        className={`panel pointer-events-auto flex max-w-full flex-col gap-1.5 px-2 py-2 ${phone ? "items-center" : "items-start"}`}
      >
        <div className={`flex flex-wrap items-center gap-2 ${phone ? "justify-center" : "justify-start"}`}>
          {children}
        </div>
        {hint && !phone ? <p className="truncate px-1 text-12 text-faint">{hint}</p> : null}
      </section>
    </div>
  );
}
