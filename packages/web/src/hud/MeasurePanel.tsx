import { Box, Circle, Cone, Minus, Ruler, Share2 } from "lucide-react";
import { useMeasure } from "../board/tools/measure.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";
import { Segmented } from "../ui/controls.tsx";
import { ToolBar } from "./ToolBar.tsx";

/**
 * The Measure tool's options (SPEC §8.6 Measurement tools), in the tool bar at the bottom of the board: which shape,
 * the line's width, and whether a finished measurement is shared with the table for 3 s.
 */
export function MeasurePanel() {
  const tool = useUi((s) => s.tool);
  const shape = useUi((s) => s.measureShape);
  const width = useUi((s) => s.lineWidthFt);
  const share = useSettings((s) => s.shareRulers !== false);
  const active = useMeasure((s) => s.points.length > 0);
  if (tool !== "measure") return null;
  return (
    <ToolBar label="Measure" testId="measure-panel" hint={hintFor(shape, active)}>
      <Segmented
        label="Measure shape"
        size="S"
        value={shape}
        onChange={(measureShape) => {
          useMeasure.setState({ points: [], pointer: null, done: false, dragging: false });
          useUi.getState().set({ measureShape });
        }}
        options={[
          { value: "ruler", label: <Ruler size={16} aria-label="Ruler" />, hint: "Ruler — click points" },
          { value: "radius", label: <Circle size={16} aria-label="Radius" />, hint: "Radius — drag out" },
          { value: "cone", label: <Cone size={16} aria-label="Cone" />, hint: "Cone (53°) — drag out" },
          { value: "line", label: <Minus size={16} aria-label="Line" />, hint: "Line — drag out" },
          { value: "cube", label: <Box size={16} aria-label="Cube" />, hint: "Cube — drag out" },
        ]}
      />
      {shape === "line" ? (
        <label className="flex items-center gap-1 text-13 text-muted">
          <input
            type="number"
            aria-label="Line width in feet"
            min={1}
            max={60}
            step={1}
            value={width}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 1 && v <= 60) useUi.getState().set({ lineWidthFt: v });
            }}
            className="tabular h-9 w-14 rounded-[var(--radius-control)] border border-line bg-ink-900 px-2 text-14 text-bone"
          />
          <span className="text-12 text-faint">ft wide</span>
        </label>
      ) : null}
      <IconButton
        label={share ? "Sharing finished measurements (3 s)" : "Not sharing measurements"}
        active={share}
        onClick={() => useSettings.getState().update({ shareRulers: !share })}
      >
        <Share2 size={16} />
      </IconButton>
    </ToolBar>
  );
}

function hintFor(shape: string, active: boolean): string {
  const how =
    shape === "ruler" ? "Click to add points · double-click or Enter finishes" : "Drag from the origin";
  return active ? `${how} · Esc clears` : how;
}
