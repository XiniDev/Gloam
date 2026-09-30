import { DoorClosed, PenLine, Shapes, Square, Trash2 } from "lucide-react";
import { cameraRig } from "../../board/CameraRig.tsx";
import { setWallMode, type WallMode } from "../../board/tools/walls.ts";
import { useZoneTool } from "../../board/tools/zones.ts";
import { request } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Toggle } from "../../ui/controls.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { act } from "./tokenDm.tsx";

const H = "caps text-12 text-brass";

const ZONE_NAME: Record<string, string> = {
  difficult: "Difficult terrain",
  water: "Water",
  hazard: "Hazard",
  impassable: "Impassable",
  label: "Label",
};

/**
 * DM panel → Walls & Zones (SPEC §8.19): the drawing tools a click away (walls, doors, rooms, zones — each a board tool
 * with its own bar), how many walls and doors the scene has, 3D walls on or off, and the scene's zones — each found on
 * the board, opened in the zone editor, or deleted (undoable).
 */
export function WallsSection() {
  const scene = useBoard((d) => d.scene);
  const walls = useBoard((d) => d.walls);
  const zones = useBoard((d) => d.zones);
  if (!scene) return <EmptyState art="candle" title="No scene is showing yet." />;
  const all = [...walls.values()];
  const doors = all.filter((w) => (w.dmKind ?? w.kind) === "door").length;
  const secret = all.filter((w) => w.dmKind === "secret").length;
  const tool = (t: "walls" | "zones", extra: Record<string, unknown> = {}) =>
    useUi.getState().set({ tool: t, dock: null, ...extra });
  // Each button opens the wall tool in its own mode (Rooms opened it in whatever mode it was last left in).
  const wallTool = (mode: WallMode, wallKind: "wall" | "door") => {
    setWallMode(mode);
    tool("walls", { wallKind });
  };
  const list = [...zones.values()].sort((a, b) => (a.label || a.kind).localeCompare(b.label || b.kind));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" data-testid="walls-section">
      <section className="flex flex-col gap-2" aria-label="Walls">
        <h3 className={H}>Walls</h3>
        <p className="text-13 text-muted">
          {all.length} {all.length === 1 ? "wall" : "walls"} · {doors} {doors === 1 ? "door" : "doors"}
          {secret ? ` · ${secret} secret` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="S"
            variant="secondary"
            icon={<PenLine size={15} />}
            onClick={() => wallTool("draw", "wall")}
          >
            Draw walls (W)
          </Button>
          <Button
            size="S"
            variant="ghost"
            icon={<DoorClosed size={15} />}
            onClick={() => wallTool("draw", "door")}
          >
            Doors
          </Button>
          <Button
            size="S"
            variant="ghost"
            icon={<Square size={15} />}
            onClick={() => wallTool("room", "wall")}
          >
            Rooms
          </Button>
        </div>
        <Toggle
          checked={scene.walls3d}
          onChange={(walls3d) =>
            act(request("scene.update", { sceneId: scene.id, walls3d }), "Couldn't change the walls")
          }
          label="Walls in 3D"
          description="Stone walls stand up from the floor; off, they're drawn as lines."
        />
      </section>
      <section className="flex flex-col gap-2" aria-label="Zones">
        <div className="flex items-center justify-between gap-2">
          <h3 className={H}>Zones</h3>
          <Button size="S" variant="secondary" icon={<Shapes size={15} />} onClick={() => tool("zones")}>
            Draw zones (Z)
          </Button>
        </div>
        {list.length ? (
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {list.map((z) => {
              const cx = z.points.length ? z.points.reduce((a, p) => a + p.x, 0) / z.points.length : 0;
              const cy = z.points.length ? z.points.reduce((a, p) => a + p.y, 0) / z.points.length : 0;
              return (
                <li key={z.id} className="flex items-center gap-2 px-3 py-1.5" data-testid="zone-row">
                  <span
                    className="h-3 w-3 shrink-0 rounded-chip"
                    style={{ background: z.color }}
                    aria-hidden
                  />
                  <button
                    type="button"
                    className="flex min-h-[var(--touch-min)] min-w-0 flex-1 flex-col items-start py-1 text-left"
                    onClick={() => {
                      useUi.getState().set({ tool: "zones" });
                      useZoneTool.setState({ selected: z.id });
                      if (z.points.length) cameraRig.moveTargetTo(cx, cy);
                    }}
                  >
                    <span className="truncate text-14 text-bone">
                      {z.label || ZONE_NAME[z.kind] || z.kind}
                    </span>
                    <span className="text-12 text-muted">
                      {ZONE_NAME[z.kind] ?? z.kind}
                      {z.dmHidden ? " · hidden from players" : ""}
                    </span>
                  </button>
                  <IconButton
                    label={`Delete ${z.label || ZONE_NAME[z.kind] || "the zone"}`}
                    tone="danger"
                    onClick={() => act(request("zone.delete", { zoneIds: [z.id] }), "Couldn't delete it")}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-13 text-muted">
            No zones. Water, difficult ground and hazards are zones you draw.
          </p>
        )}
      </section>
    </div>
  );
}
