import { type SyntheticEvent, useEffect, useState } from "react";
import { useHudInsets } from "../hud/insets.ts";
import { Button } from "../ui/Button.tsx";
import { D20Spinner } from "../ui/Spinner.tsx";
import { useGpu } from "./gpu.ts";
import { useWarmup } from "./warmup/state.ts";

/** How long a restoration may take before the board offers a reload. */
const SLOW_MS = 8000;

/** The board is being given back its graphics (gpu.ts): lost, or restored and not yet warmed up again. */
export function useRestoring(): boolean {
  const lost = useGpu((s) => s.lost);
  const everLost = useGpu((s) => s.losses > 0);
  const warmed = useWarmup((s) => s.phase === "done");
  return lost || (everLost && !warmed);
}

/**
 * "Restoring board…" (SPEC §40): over the board — the HUD stays in use round it — while its WebGL context is lost and
 * until everything is drawn and compiled again. A browser may never give a context back (after too many losses it
 * stops): after a while the board offers to reload the page (§2 P2: nothing automatic without a way out).
 */
export function BoardRestoring() {
  const show = useRestoring();
  const insets = useHudInsets();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!show) return;
    const t = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(t);
  }, [show]);
  if (!show) return null;
  // Nothing done over it reaches the board beneath (it lies inside the board's element): a press there started a pan
  // and captured the pointer, and the Reload button never got its click.
  const keep = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="board-restoring"
      className="absolute inset-0 grid place-items-center bg-bg"
      onPointerDown={keep}
      onPointerMove={keep}
      onPointerUp={keep}
      onDoubleClick={keep}
      onContextMenu={keep}
      onWheel={keep}
      onDragOver={keep}
      onDrop={keep}
      // Centred in the board the HUD leaves free.
      style={{
        paddingTop: insets.top,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        paddingBottom: insets.bottom,
      }}
    >
      <div className="flex max-w-[34ch] flex-col items-center gap-3 px-4 text-center">
        <span className="text-brass">
          <D20Spinner size={22} />
        </span>
        <span className="caps text-12 text-fog">Restoring board…</span>
        {slow ? (
          <>
            <p className="text-14 text-bone">
              The browser hasn't given the board its graphics back yet. Reloading the page brings it back.
            </p>
            <Button size="S" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
