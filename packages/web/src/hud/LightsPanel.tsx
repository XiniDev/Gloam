import { BOARD_COLORS, LIGHT_PRESETS } from "@gloam/shared";
import { Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { boardApi } from "../board/boardApi.ts";
import { useLightTool } from "../board/tools/lights.ts";
import { request, useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { CompactSelect } from "../ui/CompactSelect.tsx";
import { Toggle } from "../ui/controls.tsx";
import { toast } from "../ui/Toast.tsx";
import { underTopBar, useHudInsets, useIsPhone } from "./insets.ts";
import { ToolBar } from "./ToolBar.tsx";

/** Light colours (tokens only, SPEC §27): flame, candle, lamplight, moonlight, arcane, fey, and plain white. */
const LIGHT_COLORS = [
  { hex: BOARD_COLORS.flameOuter, name: "Torch flame" },
  { hex: BOARD_COLORS.candle, name: "Candle" },
  { hex: BOARD_COLORS.keyLight, name: "Lamplight" },
  { hex: BOARD_COLORS.ice300, name: "Moonlight" },
  { hex: BOARD_COLORS.arcane400, name: "Arcane" },
  { hex: BOARD_COLORS.verdigris400, name: "Fey" },
  { hex: BOARD_COLORS.bone100, name: "White" },
];
const ANIMATIONS = [
  { value: "none", label: "Steady" },
  { value: "torch", label: "Torch flicker" },
  { value: "candle", label: "Candle flicker" },
  { value: "pulse", label: "Pulse" },
  { value: "shimmer", label: "Magical shimmer" },
];

const input =
  "h-9 w-full rounded-[var(--radius-control)] border border-line bg-ink-900 px-2 text-14 text-bone tabular hover:border-line-strong focus:border-brass";

/**
 * The Lights tool's bar (SPEC §8.8 Light; Appendix H: I): the light source a click places; the selected light's
 * editor beside it.
 */
export function LightsPanel() {
  const tool = useUi((s) => s.tool);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const preset = useLightTool((s) => s.preset);
  if (tool !== "lights" || !dm) return null;
  return (
    <>
      <ToolBar
        label="Lights"
        testId="lights-panel"
        hint="Click to place · drag a light to move it · Delete removes it"
      >
        <CompactSelect<string>
          label="Light to place"
          testId="light-preset"
          value={preset}
          onChange={(v) => useLightTool.setState({ preset: v })}
          options={LIGHT_PRESETS.map((p) => ({ value: p.id, label: `${p.name} · ${p.bright}/${p.dim} ft` }))}
        />
      </ToolBar>
      <LightEditor />
    </>
  );
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="block">
      <span className="caps mb-1.5 block text-12 text-fog">{label}</span>
      <input
        aria-label={label}
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number(text);
          if (Number.isFinite(n) && n >= 0 && n <= 1000 && n !== value) onCommit(n);
          else setText(String(value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={input}
      />
    </label>
  );
}

function LightEditor() {
  const selected = useLightTool((s) => s.selected);
  const light = useBoard((d) => (selected ? d.lights.get(selected) : undefined));
  const banner = useHudInsets((s) => s.banner);
  const left = useHudInsets((s) => s.left);
  const right = useHudInsets((s) => s.right);
  const phone = useIsPhone();
  // Never over the light being edited: on the side of the screen away from it.
  const onLeft = useMemo(() => {
    if (!light) return false;
    const at = boardApi.project(light.x, light.y);
    return !!at && at.sx < window.innerWidth / 2;
  }, [light]);
  if (!light) return null;
  const update = (patch: Record<string, unknown>) =>
    void request("light.update", { lightId: light.id, ...patch }).catch((e) =>
      toast.danger("Couldn't change the light", (e as Error).message),
    );
  const name = LIGHT_PRESETS.find((p) => p.id === light.preset)?.name ?? "Light";
  const cone = light.coneDeg > 0 && light.coneDeg < 360;
  return (
    <section
      aria-label="Light"
      data-testid="light-editor"
      className="panel pointer-events-auto absolute z-30 flex max-h-[calc(100dvh-160px)] flex-col gap-3 overflow-y-auto p-3"
      style={
        phone
          ? { top: underTopBar(banner), left: 12, right }
          : onLeft
            ? { top: underTopBar(banner), right, width: "min(300px, calc(100vw - 96px))" }
            : { top: underTopBar(banner), left, width: "min(300px, calc(100vw - 96px))" }
      }
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-display text-18 font-semibold leading-tight text-bone">{name}</h2>
        <IconButton label="Close" onClick={() => useLightTool.setState({ selected: null })}>
          <X size={16} />
        </IconButton>
      </header>
      {light.link?.tokenId ? (
        <p className="text-13 text-muted">Carried: it goes where its token goes.</p>
      ) : null}
      <CompactSelect<string>
        label="Source"
        value={light.preset}
        onChange={(v) => update({ preset: v })}
        options={[
          ...(light.preset ? [] : [{ value: "", label: "Custom" }]),
          ...LIGHT_PRESETS.map((p) => ({ value: p.id, label: p.name })),
        ]}
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Bright (ft)" value={light.bright} onCommit={(bright) => update({ bright })} />
        <NumberField label="+ Dim (ft)" value={light.dim} onCommit={(dim) => update({ dim })} />
      </div>
      <div>
        <span className="caps mb-1.5 block text-12 text-fog">Colour</span>
        <div role="radiogroup" aria-label="Light colour" className="flex gap-1">
          {LIGHT_COLORS.map((c) => {
            const active = c.hex.toLowerCase() === light.color.toLowerCase();
            return (
              <button
                key={c.hex}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={c.name}
                title={c.name}
                onClick={() => update({ color: c.hex })}
                // The 28-px ring drawn inside a touch-sized hit area.
                className="group grid min-h-[var(--touch-min)] min-w-[var(--touch-min)] place-items-center"
              >
                <span
                  className={`grid h-7 w-7 place-items-center rounded-[var(--radius-control)] border-2 ${active ? "border-bone" : "border-transparent group-hover:border-line-strong"}`}
                  aria-hidden
                >
                  <span className="block h-5 w-5 rounded-chip" style={{ background: c.hex }} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <CompactSelect<string>
        label="Animation"
        value={light.anim}
        onChange={(animation) => update({ animation })}
        options={ANIMATIONS}
      />
      <Toggle
        label="Cone"
        description={cone ? `${Math.round(light.coneDeg)}° — turns with its bearer` : "All around"}
        checked={cone}
        onChange={(v) => update({ coneDeg: v ? 53.13 : null })}
      />
      {cone && !light.link?.tokenId ? (
        <NumberField
          label="Facing (°)"
          value={Math.round(((light.dirDeg % 360) + 360) % 360)}
          onCommit={(directionDeg) => update({ directionDeg })}
        />
      ) : null}
      <Toggle label="Magical" checked={light.magical} onChange={(magical) => update({ magical })} />
      <Toggle
        label="Only for me"
        description="A DM aid: players don't see it or its light"
        checked={light.dmOnly}
        onChange={(dmOnly) => update({ dmOnly })}
      />
      <Toggle label="Lit" checked={light.on} onChange={(enabled) => update({ enabled })} />
      <Button
        size="S"
        variant="danger"
        icon={<Trash2 size={16} />}
        onClick={() => {
          useLightTool.setState({ selected: null });
          void request("light.delete", { lightIds: [light.id] }).catch((e) =>
            toast.danger("Couldn't remove the light", (e as Error).message),
          );
        }}
      >
        Remove light
      </Button>
    </section>
  );
}
