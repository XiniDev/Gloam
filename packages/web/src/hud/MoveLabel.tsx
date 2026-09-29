import type { P } from "@gloam/shared/geometry";
import { formatDistance, formatDistanceValue } from "@gloam/shared/units";
import { useRef } from "react";
import { boardApi } from "../board/boardApi.ts";
import { useMove } from "../board/move/drag.ts";
import { useTable } from "../net/table.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { useSettings } from "../state/settings.ts";
import { useBesideLabel } from "./placement.ts";

/** A path's line on screen, a point every ~8 px (what the label keeps off). */
function pathOnScreen(points: readonly P[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let prev: { x: number; y: number } | null = null;
  for (const p of points) {
    const s = boardApi.project(p.x, p.y);
    if (!s) continue;
    const at = { x: s.sx, y: s.sy };
    if (prev) {
      const n = Math.min(200, Math.ceil(Math.hypot(at.x - prev.x, at.y - prev.y) / 8));
      for (let k = 1; k <= n; k++)
        out.push({ x: prev.x + ((at.x - prev.x) * k) / n, y: prev.y + ((at.y - prev.y) * k) / n });
    } else out.push(at);
    prev = at;
  }
  return out;
}

/** Touch first: there is no Enter key to mention. */
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/**
 * The movement pill (SPEC §8.6 The path line): how far the planned move goes in the campaign's units (or the
 * viewer's override) — the number large, in the display face — with the difficult-terrain part, or "No path"; in
 * combat on its turn, what's left of its movement ("· 10 left", "· 5 over"); and each opportunity attack the path
 * provokes ("Opportunity attack from Goblin 2", AC-MOV-15). It sits beside the ghost at the end of the path, never
 * over it or over a name plate.
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
  // Beside the ghost at the path's end, clear of the ghost, the path itself (every leg, and past its reach), its
  // marks, name plates, HP bars and the HUD (placement.ts).
  useBesideLabel(ref, () => {
    if (!screen || !preview) return null;
    const points = pathOnScreen(preview.points);
    const end = preview.points[preview.points.length - 1] as P | undefined;
    if (end && preview.ok) {
      const R = (sizeFt ?? 5) / 2;
      const c = boardApi.project(end.x, end.y);
      const rim = boardApi.project(end.x + R, end.y);
      if (c && rim) return { cx: c.sx, cy: c.sy, r: Math.max(12, Math.abs(rim.sx - c.sx)), points };
    }
    return { cx: screen.x, cy: screen.y, r: 12, points };
  });
  if (!screen || !preview) return null;
  const units = pref === "campaign" ? campaignUnits : pref;
  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      data-testid="move-label"
      // Never wider than the screen (critic P8 r2: a phone's cut off the second attack's name): the distance on its
      // line, the attacks wrapping under it.
      className="pointer-events-none fixed z-40 max-w-[min(360px,calc(100vw-24px))] whitespace-nowrap rounded-chip border border-[var(--brass-600)] bg-ink-950 px-3 py-1.5 shadow-[var(--shadow-float)]"
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
      {preview.ok && preview.budget !== undefined ? (
        <span
          className={`text-13 tabular ${preview.cost > preview.budget + 0.05 ? "text-[var(--ember-400)]" : "text-muted"}`}
          data-testid="move-left"
        >
          {" · "}
          {preview.cost > preview.budget + 0.05
            ? `${formatDistanceValue(preview.cost - preview.budget, units)} over`
            : `${formatDistanceValue(preview.budget - preview.cost, units)} left`}
        </span>
      ) : null}
      {preview.oa?.length ? (
        <span className="block whitespace-normal text-12 text-[var(--ember-400)]" data-testid="move-oa">
          {preview.oa.length === 1
            ? `Opportunity attack from ${preview.oa[0]?.byName}`
            : `Opportunity attacks from ${listOf(preview.oa.map((m) => m.byName))}`}
        </span>
      ) : null}
      {waypoints ? (
        <span className="text-12 text-muted">
          {" · "}
          {waypoints} waypoint{waypoints === 1 ? "" : "s"} · {coarse() ? "tap again to go" : "Enter to go"}
        </span>
      ) : null}
    </div>
  );
}

/** "A", "A and B", "A, B and C". */
function listOf(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
