import { useEffect, useRef } from "react";
import { prefetchDice } from "../dice/throws.ts";
import { D20Icon } from "../icons/dice.tsx";
import { useTable } from "../net/table.ts";
import { useUi } from "../state/ui.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import { ElevationControl } from "./ElevationControl.tsx";
import { insetMeasures, useMeasuredInset } from "./insets.ts";

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
};

/**
 * The bottom action bar (SPEC §29.3): centred along the bottom — the selected creature's controls (its height, for
 * now; its turn's pips and moves arrive with combat) and the dice. A tool with its own options bar owns the bottom
 * edge while it's picked; the tray still opens with D.
 */
export function ActionBar() {
  const tool = useUi((s) => s.tool);
  const tray = useUi((s) => s.diceTray);
  const me = useTable((s) => s.me);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyD" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || typing(e.target)) return;
      e.preventDefault();
      useUi.getState().set({ diceTray: !useUi.getState().diceTray });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The dice physics loads while the table is idle, so the first roll doesn't wait for it (§18.4).
  const seated = me !== null;
  useEffect(() => {
    if (seated) prefetchDice();
  }, [seated]);
  if (!me || (tool !== "select" && tool !== "pan" && tool !== "ping")) return null;
  return <Bar tray={tray} />;
}

function Bar({ tray }: { tray: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Its band along the bottom is the HUD's: the camera frames above it.
  useMeasuredInset("bottom", ref, insetMeasures.bottom);
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-end gap-2">
      {/* The creature's controls in their own panel; the dice button stands on its own, round (no tile round it). */}
      <div ref={ref} data-testid="action-bar" className="flex items-center gap-2">
        <ElevationControl />
        <DiceButton open={tray} />
      </div>
    </div>
  );
}

/** The dice button (SPEC §27.4: the one round button — circles are for portraits, pips and the dice), a d20 on it. */
function DiceButton({ open }: { open: boolean }) {
  return (
    <Tooltip label="Dice tray" shortcut="D">
      <button
        type="button"
        aria-label="Dice tray"
        aria-pressed={open || undefined}
        data-testid="dice-button"
        onClick={() => useUi.getState().set({ diceTray: !open })}
        className={`hit pointer-events-auto grid h-12 w-12 place-items-center rounded-full border shadow-[var(--shadow-float)] transition-[background-color,color,border-color,box-shadow] duration-[var(--dur-fast)] ${
          open
            ? "border-brass bg-ink-850 text-brass-bright shadow-[0_0_0_2px_var(--glow-brass),var(--shadow-float)]"
            : "border-brass-deep/70 bg-ink-850 text-brass hover:border-brass hover:text-brass-bright"
        }`}
      >
        <D20Icon size={24} />
      </button>
    </Tooltip>
  );
}
