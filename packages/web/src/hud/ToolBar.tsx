import type { ReactNode } from "react";
import { useHudInsets, useIsPhone } from "./insets.ts";

/**
 * A board tool's options bar (Measure, Walls, Zones): a compact strip at the bottom of the board, centred in the area
 * the HUD leaves free — never over the top of the map, where the prep banner, the top bar and a tool's work usually
 * are. On a phone it takes the whole width of the bottom edge (the toolbar and the dock's rail sit higher up) and
 * leaves out the hint, so it stays one or two short rows instead of a tall block over the board.
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
      className="pointer-events-none absolute bottom-3 z-30 flex justify-center px-3"
      style={phone ? { left: 0, right: 0 } : { left, right }}
    >
      <section
        aria-label={label}
        data-testid={testId}
        className="panel pointer-events-auto flex max-w-full flex-col items-center gap-1.5 px-2 py-2"
      >
        <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>
        {hint && !phone ? <p className="px-1 text-center text-12 text-faint">{hint}</p> : null}
      </section>
    </div>
  );
}
