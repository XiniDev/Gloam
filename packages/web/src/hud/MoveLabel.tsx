import type { P } from "@gloam/shared/geometry";
import { formatDistance } from "@gloam/shared/units";
import { boardApi } from "../board/boardApi.ts";
import { useMove } from "../board/move/drag.ts";
import { useTable } from "../net/table.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { useSettings } from "../state/settings.ts";

/** Touch first: there is no Enter key to mention. */
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/**
 * The movement pill (SPEC §8.6 The path line): how far the planned move goes in the campaign's units (or the
 * viewer's override) — the number large, in the display face — with the difficult-terrain part, or "No path". It
 * sits just beyond the ghost at the end of the path, never over it. Budgets ("· 10 left", "· 5 over") join with
 * combat.
 */
export function MoveLabel() {
  const screen = useMove((s) => s.screen);
  const preview = useMove((s) => s.preview);
  const waypoints = useMove((s) => s.waypoints.length);
  const tokenId = useMove((s) => s.tokenId);
  const sizeFt = useEntities((s) => (tokenId ? boardData(s).tokens.get(tokenId)?.sizeFt : undefined));
  const campaignUnits = useTable((s) => s.units);
  const pref = useSettings((s) => s.units);
  if (!screen || !preview) return null;
  const units = pref === "campaign" ? campaignUnits : pref;
  const vw = typeof window === "undefined" ? 1e4 : window.innerWidth;
  const vh = typeof window === "undefined" ? 1e4 : window.innerHeight;
  // Beside the ghost: the path's end on screen, pushed out by the ghost's radius there.
  const end = preview.points[preview.points.length - 1] as P | undefined;
  let x = screen.x + 16;
  let y = screen.y + 16;
  if (end && preview.ok) {
    const R = (sizeFt ?? 5) / 2;
    const c = boardApi.project(end.x, end.y);
    const rim = boardApi.project(end.x + R, end.y);
    if (c && rim) {
      x = c.sx + Math.abs(rim.sx - c.sx) + 12;
      y = c.sy - 18;
    }
  }
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="move-label"
      className="pointer-events-none fixed z-40 flex items-baseline whitespace-nowrap rounded-chip border border-[var(--brass-600)] bg-ink-950 px-3 py-1.5 shadow-[var(--shadow-float)]"
      style={{ left: Math.max(8, Math.min(x, vw - 220)), top: Math.max(8, Math.min(y, vh - 48)) }}
    >
      {preview.ok ? (
        <>
          <span className="font-display text-18 font-semibold leading-none text-bone tabular">
            {formatDistance(preview.cost, units)}
          </span>
          {preview.difficultFt >= 0.25 ? (
            <span className="text-12 text-muted tabular">
              {` (${formatDistance(preview.difficultFt, units)} difficult)`}
            </span>
          ) : null}
        </>
      ) : (
        <span className="font-display text-18 font-semibold leading-none text-[var(--ember-400)]">
          No path
        </span>
      )}
      {waypoints ? (
        <span className="ml-2 text-12 text-muted">
          {waypoints} waypoint{waypoints === 1 ? "" : "s"} · {coarse() ? "tap again to go" : "Enter to go"}
        </span>
      ) : null}
    </div>
  );
}
