import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useUi } from "../state/ui.ts";
import { BottomSheet } from "../ui/BottomSheet.tsx";
import { IconButton } from "../ui/Button.tsx";
import { KeyHint } from "../ui/KeyHint.tsx";
import { useHudInsets, useIsPhone } from "./insets.ts";

/**
 * A board tool's options bar (Measure, Walls, Zones): a compact strip along the bottom of the board, anchored at its
 * left beside the toolbar it belongs to — so when a mode adds or drops a control the bar grows or shrinks to the
 * right and nothing already under the pointer moves (centred, every button slid as the width changed). Never over
 * the top of the map, where the prep banner, the top bar and a tool's work usually are. On a phone it is a bottom sheet
 * (30 / 60 / 95 %, ui/BottomSheet.tsx) without the hint, headed by the tool's name and a Close that puts the tool down
 * (the tools button steps aside while a sheet is open — SPEC §29.4 panels open as bottom sheets).
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
  const left = useHudInsets((s) => s.left + s.feed);
  const right = useHudInsets((s) => s.right);
  const phone = useIsPhone();
  if (phone)
    return (
      <BottomSheet
        label={label}
        testId={testId}
        header={
          <header className="flex w-full items-center justify-between pb-1 pl-1">
            <h2 className="caps text-12 text-fog">{label}</h2>
            <IconButton
              label={`Close ${label.toLowerCase()}`}
              onClick={() => useUi.getState().set({ tool: "select" })}
            >
              <X size={18} />
            </IconButton>
          </header>
        }
      >
        <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>
      </BottomSheet>
    );
  return (
    <div
      className="pointer-events-none absolute bottom-3 z-30 flex justify-start px-3"
      style={{ left, right }}
    >
      <section
        aria-label={label}
        data-testid={testId}
        className="panel pointer-events-auto flex max-w-full flex-col items-start gap-1.5 px-2 py-2"
      >
        <div className="flex flex-wrap items-center justify-start gap-2">{children}</div>
        {hint ? (
          <p className="flex items-center gap-1 truncate px-1 text-12 text-faint">{hintParts(hint)}</p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * A labelled cluster inside a tool bar ("Mode", "Light", "Paint"): a 12-px caps label before its controls — on a
 * phone's sheet a row of its own, the labels in one column and the controls lined up after them.
 */
export function ToolGroup({ label, children }: { label: string; children: ReactNode }) {
  const phone = useIsPhone();
  return (
    <div
      className={phone ? "grid w-full grid-cols-[64px_1fr] items-center gap-2" : "flex items-center gap-1.5"}
      role="group"
      aria-label={label}
    >
      <span className="caps px-0.5 text-12 text-fog" aria-hidden>
        {label}
      </span>
      {phone ? <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div> : children}
    </div>
  );
}

/** One row of a two-row tool bar (scene settings above, the tool's own controls below); on a phone, stacked groups. */
export function ToolRow({ children }: { children: ReactNode }) {
  const phone = useIsPhone();
  return (
    <div className={phone ? "flex w-full flex-col gap-2.5" : "flex flex-wrap items-center gap-2"}>
      {children}
    </div>
  );
}

/** A hint's text with its keys as keycaps: `{[}` → [ ] in a keycap. */
function hintParts(hint: string): ReactNode[] {
  return hint
    .split(/(\{[^}]+\})/)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith("{") && part.endsWith("}") ? (
        <KeyHint key={i} keys={part.slice(1, -1)} />
      ) : (
        <span key={i}>{part}</span>
      ),
    );
}
