import { useEffect, useState } from "react";
import { useLoading } from "../board/diag.ts";

/** Loads quicker than this never show a bar (SPEC §8.3 Scene activation). */
const SHOW_AFTER_MS = 400;

/**
 * The parchment progress bar for slow scene loads (SPEC §8.3, §27.7): appears once a batch of board assets has been
 * loading for 400 ms, fills as they arrive, and fades when the last one lands.
 */
export function LoadingBar() {
  const pending = useLoading((s) => s.pending);
  const total = useLoading((s) => s.total);
  const done = useLoading((s) => s.done);
  const since = useLoading((s) => s.since);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!pending || since === null) {
      setShown(false);
      return;
    }
    const wait = SHOW_AFTER_MS - (performance.now() - since);
    if (wait <= 0) {
      setShown(true);
      return;
    }
    const t = setTimeout(() => setShown(true), wait);
    return () => clearTimeout(t);
  }, [pending, since]);

  const f = total ? done / total : 0;
  return (
    <div
      role="progressbar"
      aria-label="Loading the scene"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-hidden={!shown}
      data-testid="loading-bar"
      className="pointer-events-none absolute bottom-[calc(24px+env(safe-area-inset-bottom))] left-1/2 z-30 w-[min(320px,calc(100vw-32px))] -translate-x-1/2"
      style={{ opacity: shown ? 1 : 0, transition: "opacity var(--dur-base) var(--ease-out)" }}
    >
      <div className="rounded-chip bg-[var(--parchment-200)] px-3 pb-2 pt-1.5 shadow-[var(--shadow-paper)]">
        <p className="caps mb-1 text-center text-12 text-[var(--parchment-ink-muted)]">
          Unrolling the map · {Math.min(done + 1, total)} of {total}
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--parchment-400)]">
          <div
            className="h-full rounded-full bg-[var(--parchment-ink)]"
            style={{ width: `${Math.max(6, f * 100)}%`, transition: "width var(--dur-base) var(--ease-out)" }}
          />
        </div>
      </div>
    </div>
  );
}
