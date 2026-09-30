import { Eye, Paintbrush, RotateCcw } from "lucide-react";
import { useState } from "react";
import { paintAll, useFogTool } from "../../board/tools/fog.ts";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { useViewAs } from "../../state/viewAs.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented, Select } from "../../ui/controls.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { toast } from "../../ui/Toast.tsx";
import { act, overridesOf } from "./tokenDm.tsx";

const H = "caps text-12 text-brass";

/**
 * DM panel → Vision & Fog (SPEC §8.19): the scene's fog mode and ambient light, the fog tools (reveal and hide by
 * brush, box, polygon or room), reveal or hide everything, reset explored memory (for everyone or one player), whose
 * sight is shared with whom, and View as a player.
 */
export function VisionSection() {
  const scene = useBoard((d) => d.scene);
  const tokens = useBoard((d) => d.tokens);
  const presence = useTable((s) => s.presence);
  const viewAs = useViewAs((s) => s.userId);
  const target = useFogTool((s) => s.target);
  const [resetFor, setResetFor] = useState("all");
  if (!scene) return <EmptyState art="candle" title="No scene is showing yet." />;
  const players = presence.filter((p) => p.role === "player");
  const name = (id: string) => presence.find((p) => p.userId === id)?.name ?? "someone";
  const update = (patch: Record<string, unknown>) =>
    act(request("scene.update", { sceneId: scene.id, ...patch }), "Couldn't change the scene");
  const sharing = [...tokens.values()]
    .map((t) => ({ t, with: overridesOf(t).shareVisionWith ?? [] }))
    .filter((x) => x.with.length > 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" data-testid="vision-section">
      <section className="flex flex-col gap-2" aria-label="Fog of war">
        <h3 className={H}>Fog of war</h3>
        <Segmented
          label="Fog of war"
          fill
          value={scene.fogMode as "off" | "painted" | "dynamic"}
          onChange={(fogMode) => update({ fogMode })}
          options={[
            { value: "off", label: "Off", hint: "Everyone sees the whole map" },
            { value: "painted", label: "Painted", hint: "Players see what you reveal" },
            { value: "dynamic", label: "Dynamic", hint: "Players see what their characters perceive" },
          ]}
        />
        <p className="text-13 text-muted">
          {scene.fogMode === "dynamic"
            ? "Players see what their characters see now, and remember what they've seen."
            : scene.fogMode === "painted"
              ? "Players see what you reveal with the fog tools."
              : "Everyone sees the whole map."}
        </p>
      </section>
      <section className="flex flex-col gap-2" aria-label="Ambient light">
        <h3 className={H}>Ambient light</h3>
        <Segmented
          label="Ambient light"
          fill
          value={scene.ambient as "bright" | "dim" | "dark"}
          onChange={(ambientLevel) => update({ ambientLevel })}
          options={[
            { value: "bright", label: "Bright", hint: "Daylight" },
            { value: "dim", label: "Dim", hint: "Twilight, a lit hall" },
            { value: "dark", label: "Dark", hint: "Only lights and darkvision show anything" },
          ]}
        />
      </section>
      {scene.fogMode !== "off" ? (
        <section className="flex flex-col gap-2" aria-label="Fog tools">
          <h3 className={H}>Reveal and hide</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              size="S"
              variant="secondary"
              icon={<Paintbrush size={15} />}
              onClick={() => useUi.getState().set({ tool: "fog", dock: null })}
            >
              Fog tools (B)
            </Button>
            <Button size="S" variant="ghost" onClick={() => void paintAll(true)}>
              Reveal all{target === "all" ? "" : ` to ${name(target)}`}
            </Button>
            <Button size="S" variant="ghost" onClick={() => void paintAll(false)}>
              Hide all{target === "all" ? "" : ` from ${name(target)}`}
            </Button>
          </div>
          <Select
            label="Painting and revealing for"
            value={target}
            onChange={(v) => useFogTool.setState({ target: v })}
            options={[
              { value: "all", label: "All players" },
              ...players.map((p) => ({ value: p.userId, label: p.name })),
            ]}
          />
        </section>
      ) : null}
      {scene.fogMode === "dynamic" ? (
        <section className="flex flex-col gap-2" aria-label="Explored memory">
          <h3 className={H}>Explored memory</h3>
          <p className="text-13 text-muted">
            What the players remember of places they've seen but can't see now.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px] flex-1">
              <Select
                label="Forget for"
                value={resetFor}
                onChange={setResetFor}
                options={[
                  { value: "all", label: "Everyone" },
                  ...players.map((p) => ({ value: p.userId, label: p.name })),
                ]}
              />
            </div>
            <Button
              size="S"
              variant="secondary"
              icon={<RotateCcw size={15} />}
              onClick={() =>
                void request("fog.resetExplored", {
                  sceneId: scene.id,
                  ...(resetFor === "all" ? {} : { userId: resetFor }),
                })
                  .then(() =>
                    toast.info(
                      "Explored map reset",
                      resetFor === "all" ? "For everyone." : `For ${name(resetFor)}.`,
                    ),
                  )
                  .catch((e) => toast.danger("Couldn't reset it", (e as Error).message))
              }
            >
              Reset explored
            </Button>
          </div>
        </section>
      ) : null}
      <section className="flex flex-col gap-2" aria-label="Vision sharing">
        <h3 className={H}>Shared sight</h3>
        {sharing.length ? (
          <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
            {sharing.map(({ t, with: w }) => (
              <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-14">
                <span className="min-w-0 flex-1 truncate text-bone">{t.name}</span>
                <span className="truncate text-13 text-muted">with {w.map(name).join(", ")}</span>
                <Button
                  size="S"
                  variant="ghost"
                  onClick={() => useUi.getState().set({ tokenSettings: t.id })}
                >
                  Change
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-13 text-muted">
            No creature shares its sight. A token's DM settings choose whose sight it shares.
          </p>
        )}
      </section>
      <section className="flex flex-col gap-2" aria-label="View as">
        <h3 className={H}>View as</h3>
        <p className="text-13 text-muted">
          See the board exactly as one player does — their fog, their lights.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[180px] flex-1">
            <Select
              label="View as"
              value={viewAs ?? "dm"}
              onChange={(v) => {
                const p = players.find((x) => x.userId === v);
                useViewAs.getState().set({ userId: p ? p.userId : null, name: p?.name ?? "", data: null });
              }}
              options={[
                { value: "dm", label: "The DM (everything)" },
                ...players.map((p) => ({ value: p.userId, label: p.name })),
              ]}
            />
          </div>
          {viewAs ? (
            <Button
              size="S"
              variant="ghost"
              icon={<Eye size={15} />}
              onClick={() => useViewAs.getState().set({ userId: null, name: "", data: null })}
            >
              Back to mine
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
