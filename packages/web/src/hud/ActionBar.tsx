import { Dices } from "lucide-react";
import { useEffect, useRef } from "react";
import { prefetchDice } from "../dice/throws.ts";
import { useTable } from "../net/table.ts";
import { useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";
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
      <div
        ref={ref}
        data-testid="action-bar"
        className="panel pointer-events-auto flex items-center gap-1 p-1"
      >
        <ElevationControl />
        <IconButton
          label="Dice tray"
          shortcut="D"
          active={tray}
          data-testid="dice-button"
          onClick={() => useUi.getState().set({ diceTray: !tray })}
        >
          <Dices size={18} />
        </IconButton>
      </div>
    </div>
  );
}
