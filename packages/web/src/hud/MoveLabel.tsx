import { formatDistance } from "@gloam/shared/units";
import { useMove } from "../board/move/drag.ts";
import { useTable } from "../net/table.ts";
import { useSettings } from "../state/settings.ts";

/**
 * The movement pill at the pointer (SPEC §8.6 The path line): how far the planned move goes in the campaign's units
 * (or the viewer's override), with the difficult-terrain part, or "No path". Budgets ("· 10 left", "· 5 over") join
 * with combat.
 */
export function MoveLabel() {
  const screen = useMove((s) => s.screen);
  const preview = useMove((s) => s.preview);
  const waypoints = useMove((s) => s.waypoints.length);
  const campaignUnits = useTable((s) => s.units);
  const pref = useSettings((s) => s.units);
  if (!screen || !preview) return null;
  const units = pref === "campaign" ? campaignUnits : pref;
  const text = preview.ok
    ? `${formatDistance(preview.cost, units)}${
        preview.difficultFt >= 0.25 ? ` (${formatDistance(preview.difficultFt, units)} difficult)` : ""
      }`
    : "No path";
  const vw = typeof window === "undefined" ? 1e4 : window.innerWidth;
  const vh = typeof window === "undefined" ? 1e4 : window.innerHeight;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="move-label"
      className="pointer-events-none fixed z-40 whitespace-nowrap rounded-chip border border-line bg-ink-950 px-2 py-1 shadow-[var(--shadow-float)]"
      style={{ left: Math.min(screen.x + 16, vw - 180), top: Math.min(screen.y + 16, vh - 40) }}
    >
      <span className={`tabular text-13 font-bold ${preview.ok ? "text-bone" : "text-[var(--ember-400)]"}`}>
        {text}
      </span>
      {waypoints ? (
        <span className="ml-2 text-12 text-muted">
          {waypoints} waypoint{waypoints === 1 ? "" : "s"} · Enter to go
        </span>
      ) : null}
    </div>
  );
}
