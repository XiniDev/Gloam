import { lazy, Suspense } from "react";
import { hudOrder } from "../hud/Intro.tsx";
import { useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";

const Board = lazy(() => import("../board/Board.tsx"));

/**
 * The stage behind the HUD: the 3D board, mounted once and kept mounted while panels change (SPEC §23.1), inside
 * its own error boundary so a rendering fault never takes the rest of the table down (§23.6). With no scene active
 * the empty oak table shows, with a short line saying what's happening.
 */
export function TableStage() {
  const role = useTable((s) => s.me?.role);
  const hasScene = useBoard((d) => d.scene !== null);
  const dm = role === "admin" || role === "dm";
  return (
    <div className="absolute inset-0 bg-bg">
      <ErrorBoundary where="board">
        <Suspense fallback={null}>
          <Board />
        </Suspense>
      </ErrorBoundary>
      {!hasScene ? (
        <div
          {...hudOrder(3)}
          className="pointer-events-none absolute inset-x-0 bottom-[14%] flex justify-center px-4"
        >
          <p className="rounded-[var(--radius-control)] bg-[var(--scrim-soft)] px-4 py-2 text-center text-14 text-muted backdrop-blur-[3px]">
            {dm
              ? "No scene is active yet — open the DM panel to prepare one for your players."
              : "Waiting for the DM to set the scene…"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
