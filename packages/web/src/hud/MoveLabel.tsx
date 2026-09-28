import type { P } from "@gloam/shared/geometry";
import { formatDistance, formatDistanceValue } from "@gloam/shared/units";
import { useRef } from "react";
import { boardApi } from "../board/boardApi.ts";
import { useMove } from "../board/move/drag.ts";
import { useTable } from "../net/table.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { useSettings } from "../state/settings.ts";
import { useBesideLabel } from "./placement.ts";

/** Touch first: there is no Enter key to mention. */
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/**
 * The movement pill (SPEC §8.6 The path line): how far the planned move goes in the campaign's units (or the
 * viewer's override) — the number large, in the display face — with the difficult-terrain part, or "No path". It
 * sits beside the ghost at the end of the path, never over it or over a name plate. Budgets ("· 10 left", "· 5
 * over") join with combat.
 */
export function MoveLabel() {
  const screen = useMove((s) => s.screen);
  const preview = useMove((s) => s.preview);
  const waypoints = useMove((s) => s.waypoints.length);
  const tokenId = useMove((s) => s.tokenId);
  const sizeFt = useEntities((s) => (tokenId ? boardData(s).tokens.get(tokenId)?.sizeFt : undefined));
  const campaignUnits = useTable((s) => s.units);
  const pref = useSettings((s) => s.units);
  const ref = useRef<HTMLDivElement>(null);
  // Beside the ghost at the path's end, clear of the ghost, name plates, HP bars and the HUD (placement.ts).
  useBesideLabel(ref, () => {
    if (!screen || !preview) return null;
    const end = preview.points[preview.points.length - 1] as P | undefined;
    if (end && preview.ok) {
      const R = (sizeFt ?? 5) / 2;
      const c = boardApi.project(end.x, end.y);
      const rim = boardApi.project(end.x + R, end.y);
      if (c && rim) return { cx: c.sx, cy: c.sy, r: Math.max(12, Math.abs(rim.sx - c.sx)) };
    }
    return { cx: screen.x, cy: screen.y, r: 12 };
  });
  if (!screen || !preview) return null;
  const units = pref === "campaign" ? campaignUnits : pref;
  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      data-testid="move-label"
      className="pointer-events-none fixed z-40 whitespace-nowrap rounded-chip border border-[var(--brass-600)] bg-ink-950 px-3 py-1.5 shadow-[var(--shadow-float)]"
      style={{ left: -9999, top: -9999 }}
    >
      {preview.ok ? (
        <>
          <span className="font-display text-18 font-semibold leading-none text-bone tabular">
            {formatDistance(preview.cost, units)}
          </span>
          {preview.difficultFt >= 0.25 ? (
            // §8.6's copy: "35 ft (10 difficult)" — the number in the same units, without repeating them.
            <span className="text-12 text-muted tabular">
              {" "}
              ({formatDistanceValue(preview.difficultFt, units)} difficult)
            </span>
          ) : null}
        </>
      ) : (
        <span className="font-display text-18 font-semibold leading-none text-[var(--ember-400)]">
          No path
        </span>
      )}
      {waypoints ? (
        <span className="text-12 text-muted">
          {" · "}
          {waypoints} waypoint{waypoints === 1 ? "" : "s"} · {coarse() ? "tap again to go" : "Enter to go"}
        </span>
      ) : null}
    </div>
  );
}
