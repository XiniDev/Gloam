import { LIGHT_PRESETS } from "@gloam/shared";
import { Flame, Lightbulb, LightbulbOff, Trash2 } from "lucide-react";
import { cameraRig } from "../../board/CameraRig.tsx";
import { useLightTool } from "../../board/tools/lights.ts";
import { request } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented, Select } from "../../ui/controls.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { act } from "./tokenDm.tsx";

const H = "caps text-12 text-brass";

/**
 * DM panel → Lights (SPEC §8.19): the scene's ambient light; the lights on it — each found on the board and opened in
 * the light editor, put out or lit, deleted (undoable) — the carried ones named by their carrier; the preset the
 * Lights tool places next, and the tool itself.
 */
export function LightsSection() {
  const scene = useBoard((d) => d.scene);
  const lights = useBoard((d) => d.lights);
  const tokens = useBoard((d) => d.tokens);
  const preset = useLightTool((s) => s.preset);
  if (!scene) return <EmptyState art="candle" title="No scene is showing yet." />;
  const list = [...lights.values()].sort((a, b) => a.preset.localeCompare(b.preset) || a.x - b.x);
  const nameOf = (p: string) => LIGHT_PRESETS.find((x) => x.id === p)?.name ?? "Light";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" data-testid="lights-section">
      <section className="flex flex-col gap-2" aria-label="Ambient light">
        <h3 className={H}>Ambient light</h3>
        <Segmented
          label="Ambient light"
          fill
          value={scene.ambient as "bright" | "dim" | "dark"}
          onChange={(ambientLevel) =>
            act(request("scene.update", { sceneId: scene.id, ambientLevel }), "Couldn't change the light")
          }
          options={[
            { value: "bright", label: "Bright", hint: "Daylight" },
            { value: "dim", label: "Dim", hint: "Twilight, a lit hall" },
            { value: "dark", label: "Dark", hint: "Only lights and darkvision show anything" },
          ]}
        />
      </section>
      <section className="flex flex-col gap-2" aria-label="Add a light">
        <h3 className={H}>Add a light</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[180px] flex-1">
            <Select
              label="Preset"
              value={preset}
              onChange={(v) => useLightTool.setState({ preset: v })}
              options={LIGHT_PRESETS.map((p) => ({
                value: p.id,
                label: `${p.name} · ${p.bright}/${p.dim} ft`,
              }))}
            />
          </div>
          <Button
            size="S"
            variant="secondary"
            icon={<Flame size={15} />}
            onClick={() => useUi.getState().set({ tool: "lights", dock: null })}
          >
            Place on the board (I)
          </Button>
        </div>
      </section>
      <section className="flex flex-col gap-2" aria-label="Lights on the scene">
        <h3 className={H}>On this scene</h3>
        {list.length ? (
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {list.map((l) => {
              const carrier = l.link?.tokenId ? tokens.get(l.link.tokenId) : undefined;
              return (
                <li key={l.id} className="flex items-center gap-2 px-3 py-1.5" data-testid="light-row">
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ background: l.on ? l.color : "var(--ink-700)" }}
                    aria-hidden
                  />
                  <button
                    type="button"
                    className="flex min-h-[var(--touch-min)] min-w-0 flex-1 flex-col items-start py-1 text-left"
                    onClick={() => {
                      if (!carrier) {
                        useUi.getState().set({ tool: "lights" });
                        useLightTool.setState({ selected: l.id });
                      }
                      cameraRig.moveTargetTo(l.x, l.y);
                    }}
                  >
                    <span className="truncate text-14 text-bone">
                      {nameOf(l.preset)}
                      {carrier ? <span className="text-muted"> · carried by {carrier.name}</span> : null}
                    </span>
                    <span className="tabular text-12 text-muted">
                      {l.bright}/{l.dim} ft{l.dmOnly ? " · only you" : ""}
                      {l.on ? "" : " · out"}
                    </span>
                  </button>
                  <IconButton
                    label={
                      l.on
                        ? `Put out the ${nameOf(l.preset).toLowerCase()}`
                        : `Light the ${nameOf(l.preset).toLowerCase()}`
                    }
                    onClick={() =>
                      act(request("light.toggle", { lightId: l.id, enabled: !l.on }), "Couldn't change it")
                    }
                  >
                    {l.on ? <LightbulbOff size={15} /> : <Lightbulb size={15} />}
                  </IconButton>
                  {carrier ? null : (
                    <IconButton
                      label={`Delete the ${nameOf(l.preset).toLowerCase()}`}
                      tone="danger"
                      onClick={() => act(request("light.delete", { lightIds: [l.id] }), "Couldn't delete it")}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-13 text-muted">No lights. Torches, sconces and braziers are lights you place.</p>
        )}
      </section>
    </div>
  );
}
