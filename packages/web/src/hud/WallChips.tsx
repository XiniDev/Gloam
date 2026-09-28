import type { P } from "@gloam/shared/geometry";
import { formatDistance } from "@gloam/shared/units";
import { useRef } from "react";
import { boardApi } from "../board/boardApi.ts";
import { useWallTool } from "../board/tools/walls.ts";
import { useUnits } from "../board/useUnits.ts";
import { useUi } from "../state/ui.ts";
import { useBesideLabel } from "./placement.ts";

const CHIP =
  "pointer-events-none fixed z-40 whitespace-nowrap rounded-chip border border-line bg-ink-950 px-1.5 text-12 font-bold text-bone tabular shadow-[var(--shadow-float)]";

/**
 * The Walls tool's measures (SPEC §8.7): the length of the wall being drawn, beside its middle, and a room's size,
 * beside its corner — placed clear of name plates and the HUD like the movement pill.
 */
export function WallChips() {
  const on = useUi((s) => s.tool === "walls");
  const mode = useWallTool((s) => s.mode);
  const chain = useWallTool((s) => s.chain);
  const pointer = useWallTool((s) => s.pointer);
  const rect = useWallTool((s) => s.rect);
  const units = useUnits();
  const last = chain[chain.length - 1];
  const live = on && mode !== "select" && last && pointer ? { a: last, b: pointer } : null;
  const len = live ? Math.hypot(live.b.x - live.a.x, live.b.y - live.a.y) : 0;
  return (
    <>
      {live && len >= 0.5 ? (
        <Chip testId="wall-length" at={{ x: (live.a.x + live.b.x) / 2, y: (live.a.y + live.b.y) / 2 }}>
          {formatDistance(len, units)}
        </Chip>
      ) : null}
      {on && rect ? (
        <Chip testId="room-size" at={rect.b}>
          {formatDistance(Math.abs(rect.b.x - rect.a.x), units)} ×{" "}
          {formatDistance(Math.abs(rect.b.y - rect.a.y), units)}
        </Chip>
      ) : null}
    </>
  );
}

function Chip({ testId, at, children }: { testId: string; at: P; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useBesideLabel(ref, () => {
    const s = boardApi.project(at.x, at.y);
    return s ? { cx: s.sx, cy: s.sy, r: 8 } : null;
  });
  return (
    <span ref={ref} data-testid={testId} className={CHIP} style={{ left: -9999, top: -9999 }}>
      {children}
    </span>
  );
}
