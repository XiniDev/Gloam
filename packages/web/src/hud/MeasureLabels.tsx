import { formatDistance } from "@gloam/shared/units";
import { useMemo, useRef } from "react";
import { boardApi } from "../board/boardApi.ts";
import { current, type Measurement, measuredFt, type P3, useMeasure } from "../board/tools/measure.ts";
import { useUnits } from "../board/useUnits.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { useBesideLabel } from "./placement.ts";

/**
 * The measurement totals (SPEC §8.6): the one being drawn and those others share, each a pill beside its end — clear
 * of name plates, tokens it ends on and the HUD, like the movement pill (the same face and size).
 */
export function MeasureLabels() {
  const points = useMeasure((s) => s.points);
  const pointer = useMeasure((s) => s.pointer);
  const done = useMeasure((s) => s.done);
  const shared = useMeasure((s) => s.shared);
  const shape = useUi((s) => s.measureShape);
  const width = useUi((s) => s.lineWidthFt);
  // biome-ignore lint/correctness/useExhaustiveDependencies: current() reads these stores
  const mine = useMemo(() => current(), [points, pointer, done, shape, width]);
  return (
    <>
      {mine ? <Label m={mine} testId="measure-label" /> : null}
      {shared.map((m) => (
        <Label key={`${m.by}:${m.at}`} m={m} who={m.name} testId="measure-shared-label" />
      ))}
    </>
  );
}

function Label({ m, who, testId }: { m: Measurement; who?: string; testId: string }) {
  const units = useUnits();
  const ref = useRef<HTMLDivElement>(null);
  useBesideLabel(ref, () => {
    const b = m.points[m.points.length - 1] as P3 | undefined;
    if (!b) return null;
    const c = boardApi.project(b.x, b.y, b.z);
    if (!c) return null;
    // Ending on a token: beside it, not over it.
    let r = 10;
    for (const t of boardData(useEntities.getState()).tokens.values())
      if (Math.hypot(t.pos.x - b.x, t.pos.y - b.y) < 0.1) {
        const rim = boardApi.project(b.x + t.sizeFt / 2, b.y, b.z);
        if (rim) r = Math.max(r, Math.abs(rim.sx - c.sx));
      }
    return { cx: c.sx, cy: c.sy, r };
  });
  return (
    <div
      ref={ref}
      data-testid={testId}
      className="pointer-events-none fixed z-40 whitespace-nowrap rounded-chip border border-[var(--brass-600)] bg-ink-950 px-3 py-1.5 shadow-[var(--shadow-float)]"
      style={{ left: -9999, top: -9999 }}
    >
      <span className="font-display text-18 font-semibold leading-none text-bone tabular">
        {formatDistance(measuredFt(m), units)}
      </span>
      {who ? <span className="text-12 text-muted">{` ${who}`}</span> : null}
    </div>
  );
}
