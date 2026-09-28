import { Eye, EyeOff, Hexagon, House, Paintbrush, RotateCcw, Square } from "lucide-react";
import { type FogShapeMode, paintAll, setFogShape, useFogTool } from "../board/tools/fog.ts";
import { request, useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { useViewAs } from "../state/viewAs.ts";
import { Button } from "../ui/Button.tsx";
import { CompactSelect } from "../ui/CompactSelect.tsx";
import { Segmented, Slider } from "../ui/controls.tsx";
import { toast } from "../ui/Toast.tsx";
import { ToolBar, ToolGroup, ToolRow } from "./ToolBar.tsx";

const SHAPES: { value: FogShapeMode; label: React.ReactNode; hint: string }[] = [
  {
    value: "brush",
    label: <Paintbrush size={16} aria-label="Brush" />,
    hint: "Brush (B) — paint with a soft round brush",
  },
  { value: "rect", label: <Square size={16} aria-label="Rectangle" />, hint: "Rectangle — drag out" },
  {
    value: "polygon",
    label: <Hexagon size={16} aria-label="Polygon" />,
    hint: "Polygon — click corners, close on the first",
  },
  {
    value: "room",
    label: <House size={16} aria-label="Reveal room" />,
    hint: "Reveal room (R) — click inside a walled room",
  },
];

const HINTS: Record<FogShapeMode, string> = {
  brush: "Paint over the board · {[} {]} resize the brush",
  rect: "Drag a rectangle",
  polygon: "Click corners · click the first to close · Esc cancels",
  room: "Click inside a room bounded by walls",
};

/**
 * The Fog tool's bar (SPEC §8.8 DM fog tools): the scene's fog mode and ambient light (live for everyone, AC-SCN-07);
 * reveal or hide with a brush, rectangle, polygon or Reveal room, for all players or one; Reveal all / Hide all;
 * reset explored memory; and View as — the board as one player sees it, for the DM alone.
 */
export function FogPanel() {
  const tool = useUi((s) => s.tool);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const presence = useTable((s) => s.presence);
  const scene = useBoard((d) => d.scene);
  const shape = useFogTool((s) => s.shape);
  const reveal = useFogTool((s) => s.reveal);
  const target = useFogTool((s) => s.target);
  const radius = useFogTool((s) => s.radius);
  const viewAs = useViewAs((s) => s.userId);
  if (tool !== "fog" || !dm || !scene) return null;
  const players = presence.filter((p) => p.role === "player");
  const update = (patch: Record<string, unknown>) =>
    void request("scene.update", { sceneId: scene.id, ...patch }).catch((e) =>
      toast.danger("Couldn't change the scene", (e as Error).message),
    );
  return (
    <ToolBar label="Fog" testId="fog-panel" hint={HINTS[shape]}>
      <ToolRow>
        <ToolGroup label="Mode">
          <Segmented
            label="Fog of war"
            size="S"
            phoneColumns={3}
            value={scene.fogMode as "off" | "painted" | "dynamic"}
            onChange={(fogMode) => update({ fogMode })}
            options={[
              { value: "off", label: "Off", hint: "Everyone sees the whole map" },
              { value: "painted", label: "Painted", hint: "Players see what you reveal" },
              { value: "dynamic", label: "Dynamic", hint: "Players see what their characters perceive" },
            ]}
          />
        </ToolGroup>
        <ToolGroup label="Light">
          <Segmented
            label="Ambient light"
            size="S"
            phoneColumns={3}
            value={scene.ambient as "bright" | "dim" | "dark"}
            onChange={(ambientLevel) => update({ ambientLevel })}
            options={[
              { value: "bright", label: "Bright", hint: "Daylight" },
              { value: "dim", label: "Dim", hint: "Twilight, a lit hall" },
              { value: "dark", label: "Dark", hint: "Only lights and darkvision show anything" },
            ]}
          />
        </ToolGroup>
        <ToolGroup label="View">
          <CompactSelect<string>
            label="View as"
            testId="view-as"
            value={viewAs ?? "dm"}
            onChange={(v) => {
              const p = players.find((x) => x.userId === v);
              useViewAs.getState().set({ userId: p ? p.userId : null, name: p?.name ?? "", data: null });
            }}
            options={[
              { value: "dm", label: "View as: DM" },
              ...players.map((p) => ({ value: p.userId, label: `View as ${p.name}` })),
            ]}
          />
        </ToolGroup>
      </ToolRow>
      <ToolRow>
        <ToolGroup label="Paint">
          <Segmented
            label="Reveal or hide"
            size="S"
            phoneColumns={2}
            value={reveal ? "reveal" : "hide"}
            onChange={(v) => useFogTool.setState({ reveal: v === "reveal" })}
            options={[
              { value: "reveal", label: <Eye size={16} aria-label="Reveal" />, hint: "Reveal" },
              { value: "hide", label: <EyeOff size={16} aria-label="Hide" />, hint: "Hide" },
            ]}
          />
        </ToolGroup>
        <ToolGroup label="Shape">
          <Segmented
            label="Fog shape"
            size="S"
            phoneColumns={4}
            value={shape}
            onChange={setFogShape}
            options={SHAPES}
          />
        </ToolGroup>
        {shape === "brush" ? (
          <ToolGroup label="Brush">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <Slider
                label="Brush size"
                className="w-24 flex-1"
                min={1}
                max={20}
                step={0.5}
                value={radius}
                format={(v) => `${v} ft`}
                onChange={(v) => useFogTool.setState({ radius: v })}
              />
              <span className="tabular w-10 shrink-0 text-right text-12 text-muted" aria-hidden>
                {radius} ft
              </span>
            </span>
          </ToolGroup>
        ) : null}
        <ToolGroup label="For">
          <CompactSelect<string>
            label="For"
            testId="fog-target"
            value={target}
            onChange={(v) => useFogTool.setState({ target: v })}
            options={[
              { value: "all", label: "All players" },
              ...players.map((p) => ({ value: p.userId, label: p.name })),
            ]}
          />
        </ToolGroup>
        <ToolGroup label="All">
          <Button size="S" variant="secondary" onClick={() => void paintAll(true)}>
            Reveal all
          </Button>
          <Button size="S" variant="secondary" onClick={() => void paintAll(false)}>
            Hide all
          </Button>
          {scene.fogMode === "dynamic" ? (
            <Button
              size="S"
              variant="ghost"
              icon={<RotateCcw size={16} />}
              onClick={() =>
                void request("fog.resetExplored", {
                  sceneId: scene.id,
                  ...(target === "all" ? {} : { userId: target }),
                })
                  .then(() =>
                    toast.info("Explored map reset", target === "all" ? "For everyone." : "For one player."),
                  )
                  .catch((e) => toast.danger("Couldn't reset it", (e as Error).message))
              }
            >
              Reset explored
            </Button>
          ) : null}
        </ToolGroup>
      </ToolRow>
    </ToolBar>
  );
}
