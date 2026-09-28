import { Box, Check, EyeOff, Link2, MousePointer2, PenLine, Square, Trash2, Undo2 } from "lucide-react";
import { WALL_COLORS } from "../board/colors.ts";
import {
  applyToSelection,
  canJoin,
  closeRoom,
  deleteSelected,
  finishChain,
  joinSelected,
  removeLastPoint,
  setWallMode,
  useWallTool,
  type WallMode,
} from "../board/tools/walls.ts";
import { request, useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi, type WallDrawKind } from "../state/ui.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { CompactSelect } from "../ui/CompactSelect.tsx";
import { Segmented } from "../ui/controls.tsx";
import { useCompactBar } from "./insets.ts";
import { ToolBar } from "./ToolBar.tsx";

const KINDS: { value: WallDrawKind; label: string; hint: string }[] = [
  { value: "wall", label: "Wall", hint: "Blocks movement, sight and light" },
  { value: "door", label: "Door", hint: "Players within 5 ft open and close it" },
  { value: "window", label: "Window", hint: "Glass: sight and light pass, bodies don't" },
  { value: "curtain", label: "Curtain", hint: "Walk through; blocks sight and light" },
  { value: "invisible", label: "Invisible", hint: "A force field: blocks bodies only" },
  { value: "secret", label: "Secret", hint: "A door that looks like a wall to players until you open it" },
];

/**
 * The Walls tool's bar (SPEC §8.7 Editor tools; Appendix H): Select / Draw / Room, the kind drawn next (or of the
 * selection), "hidden from players", and while drawing the tablet's Undo-point and Done buttons; with walls selected,
 * Join and Delete.
 */
export function WallsPanel() {
  const tool = useUi((s) => s.tool);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const mode = useWallTool((s) => s.mode);
  const chain = useWallTool((s) => s.chain.length);
  const selected = useWallTool((s) => s.selected);
  const walls = useBoard((d) => d.walls);
  const drawKind = useUi((s) => s.wallKind);
  const drawHidden = useUi((s) => s.wallHidden);
  const compact = useCompactBar();
  const sceneId = useBoard((d) => d.scene?.id);
  const walls3d = useBoard((d) => d.scene?.walls3d === true);
  if (tool !== "walls" || !dm) return null;

  const editing = mode === "select" && selected.length > 0;
  // With a selection the controls show (and set) the selection's kind and visibility.
  const kinds = new Set(selected.map((id) => walls.get(id)).map((w) => w?.dmKind ?? w?.kind));
  const kind = editing
    ? kinds.size === 1
      ? ([...kinds][0] as WallDrawKind)
      : ("" as WallDrawKind)
    : drawKind;
  const hidden = editing ? selected.every((id) => walls.get(id)?.dmHidden) : drawHidden;

  return (
    <ToolBar label="Walls" testId="walls-panel" hint={hintFor(mode, chain > 0, selected.length)}>
      <Segmented<WallMode>
        label="Walls mode"
        size="S"
        value={mode}
        onChange={setWallMode}
        options={[
          {
            value: "select",
            label: <MousePointer2 size={16} aria-label="Select walls" />,
            hint: "Select and edit",
          },
          { value: "draw", label: <PenLine size={16} aria-label="Draw walls" />, hint: "Draw wall chains" },
          {
            value: "room",
            label: <Square size={16} aria-label="Room" />,
            hint: "Room: drag a rectangle or click a polygon",
          },
        ]}
      />
      {compact ? (
        <CompactSelect<WallDrawKind>
          label="Wall kind"
          value={kind}
          onChange={(k) => void applyToSelection({ kind: k })}
          options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
      ) : (
        <Segmented<WallDrawKind>
          label="Wall kind"
          size="S"
          value={kind}
          onChange={(k) => void applyToSelection({ kind: k })}
          options={KINDS.map((k) => ({
            value: k.value,
            hint: k.hint,
            label: (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: WALL_COLORS[k.value] }}
                />
                {k.label}
              </span>
            ),
          }))}
        />
      )}
      <IconButton
        label={walls3d ? "Walls in 3D: on" : "Walls in 3D: off"}
        active={walls3d}
        onClick={() => {
          if (sceneId) void request("scene.update", { sceneId, walls3d: !walls3d }).catch(() => {});
        }}
      >
        <Box size={16} />
      </IconButton>
      <IconButton
        label={hidden ? "Hidden from players" : "Players see these walls"}
        active={hidden}
        onClick={() => void applyToSelection({ hidden: !hidden })}
      >
        <EyeOff size={16} />
      </IconButton>
      {mode !== "select" && chain > 0 ? (
        <>
          <IconButton label="Remove the last segment (Backspace)" onClick={removeLastPoint}>
            <Undo2 size={16} />
          </IconButton>
          <Button
            size="S"
            variant="secondary"
            icon={<Check size={16} />}
            onClick={() => (mode === "draw" ? finishChain() : closeRoom())}
          >
            Done
          </Button>
        </>
      ) : null}
      {editing ? (
        <>
          <span className="px-1 text-13 text-muted tabular" data-testid="walls-selected">
            {selected.length === 1 ? "1 wall" : `${selected.length} walls`}
          </span>
          <IconButton
            label="Join the two walls"
            disabled={!canJoin(selected)}
            onClick={() => void joinSelected()}
          >
            <Link2 size={16} />
          </IconButton>
          <IconButton label="Delete (Del)" tone="danger" onClick={() => void deleteSelected()}>
            <Trash2 size={16} />
          </IconButton>
        </>
      ) : null}
    </ToolBar>
  );
}

function hintFor(mode: WallMode, drawing: boolean, selected: number): string {
  if (mode === "draw")
    return drawing
      ? "Click to add · double-click, Enter or Esc finishes · Backspace removes the last · Shift 15° · Ctrl no snap"
      : "Click to start a wall · ends snap within 1 ft · Shift snaps to 15° · Ctrl turns snapping off";
  if (mode === "room")
    return drawing
      ? "Click corners · click the first corner (or Enter) closes the room"
      : "Drag a rectangle, or click the corners of a polygon";
  return selected
    ? "Drag an end to move its joint (Alt pulls it free) · drag a wall to move · double-click splits · Del removes"
    : "Click a wall (Shift adds) or drag a box · double-click a wall to split it";
}
