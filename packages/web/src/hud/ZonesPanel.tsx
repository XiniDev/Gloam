import { ABILITIES, BOARD_COLORS, DAMAGE_TYPES, ZONE_COLORS } from "@gloam/shared";
import { zonePolygon } from "@gloam/shared/movement";
import { Check, Circle, Hexagon, MousePointer2, Plus, Square, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { boardApi } from "../board/boardApi.ts";
import { parseZoneShape } from "../board/map/zoneShape.ts";
import { closePolygon, deleteZone, setZoneMode, useZoneTool, type ZoneMode } from "../board/tools/zones.ts";
import { request, useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { CompactSelect } from "../ui/CompactSelect.tsx";
import { Segmented, Select, Toggle } from "../ui/controls.tsx";
import { toast } from "../ui/Toast.tsx";
import { useHudInsets, useIsPhone } from "./insets.ts";
import { ToolBar } from "./ToolBar.tsx";

type ZoneKind = keyof typeof ZONE_COLORS;
const KINDS: { value: ZoneKind; label: string; hint: string }[] = [
  { value: "difficult", label: "Difficult", hint: "Movement costs double" },
  { value: "water", label: "Water", hint: "Double cost without a swim speed" },
  {
    value: "hazard",
    label: "Hazard",
    hint: "Prompts you with a save or damage when creatures enter or turn in it",
  },
  { value: "impassable", label: "Impassable", hint: "Blocks movement like a wall" },
  { value: "label", label: "Label", hint: "A named area" },
];
const SWATCHES: { hex: string; name: string }[] = [
  { hex: BOARD_COLORS.brass600, name: "Brass" },
  { hex: BOARD_COLORS.arcane400, name: "Arcane blue" },
  { hex: BOARD_COLORS.ember400, name: "Ember" },
  { hex: BOARD_COLORS.blood500, name: "Blood" },
  { hex: BOARD_COLORS.bone100, name: "Bone" },
  { hex: BOARD_COLORS.verdigris400, name: "Verdigris" },
  { hex: BOARD_COLORS.hex400, name: "Hex violet" },
  { hex: BOARD_COLORS.ice300, name: "Ice" },
];
const WHEN = [
  { value: "enter", label: "On entering" },
  { value: "startTurn", label: "Start of turn inside" },
  { value: "endTurn", label: "End of turn inside" },
] as const;
const ABILITY_NAMES: Record<(typeof ABILITIES)[number], string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

interface Trigger {
  when: "enter" | "startTurn" | "endTurn";
  label: string;
  save?: { ability: (typeof ABILITIES)[number]; dc: number; onSuccess: "half" | "none" };
  damage?: { formula: string; type: (typeof DAMAGE_TYPES)[number] };
}

async function update(zoneId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    await request("zone.update", { zoneId, ...patch });
  } catch (err) {
    toast.danger("Couldn't change that zone", (err as Error).message);
  }
}

/**
 * The Zones tool's bar (SPEC §8.7 Zones): Select / Rectangle / Circle / Polygon, and the kind of the zone drawn next —
 * or of the selected zone.
 */
export function ZonesPanel() {
  const tool = useUi((s) => s.tool);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const mode = useZoneTool((s) => s.mode);
  const drawing = useZoneTool((s) => s.points.length);
  const selected = useZoneTool((s) => s.selected);
  const zone = useBoard((d) => (selected ? d.zones.get(selected) : undefined));
  const drawKind = useUi((s) => s.zoneKind);
  const phoneBar = useIsPhone();
  if (tool !== "zones" || !dm) return null;
  // In Select mode the kinds edit the selected zone; while drawing they set the next zone's kind.
  const editing = mode === "select" && zone ? zone : null;
  const kind = (editing?.kind as ZoneKind | undefined) ?? drawKind;
  return (
    <ToolBar label="Zones" testId="zones-panel" hint={hintFor(mode, drawing > 0, !!zone)}>
      <Segmented<ZoneMode>
        label="Zones mode"
        size="S"
        value={mode}
        onChange={setZoneMode}
        options={[
          {
            value: "select",
            label: <MousePointer2 size={16} aria-label="Select zones" />,
            hint: "Select and edit",
          },
          {
            value: "rect",
            label: <Square size={16} aria-label="Rectangle" />,
            hint: "Rectangle: drag corner to corner",
          },
          {
            value: "circle",
            label: <Circle size={16} aria-label="Circle" />,
            hint: "Circle: drag from the centre",
          },
          {
            value: "polygon",
            label: <Hexagon size={16} aria-label="Polygon" />,
            hint: "Polygon: click the corners",
          },
        ]}
      />
      {phoneBar ? (
        <CompactSelect<ZoneKind>
          label="Zone kind"
          value={kind}
          onChange={(k) => {
            if (editing) void update(editing.id, { kind: k, color: ZONE_COLORS[k] });
            else useUi.getState().set({ zoneKind: k });
          }}
          options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
      ) : (
        <Segmented<ZoneKind>
          label="Zone kind"
          size="S"
          value={kind}
          onChange={(k) => {
            if (editing) void update(editing.id, { kind: k, color: ZONE_COLORS[k] });
            else useUi.getState().set({ zoneKind: k });
          }}
          options={KINDS.map((k) => ({
            value: k.value,
            hint: k.hint,
            label: (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: ZONE_COLORS[k.value] }}
                />
                {k.label}
              </span>
            ),
          }))}
        />
      )}
      {mode === "polygon" && drawing > 0 ? (
        <Button size="S" variant="secondary" icon={<Check size={16} />} onClick={closePolygon}>
          Done
        </Button>
      ) : null}
    </ToolBar>
  );
}

function hintFor(mode: ZoneMode, drawing: boolean, selected: boolean): string {
  if (mode === "rect") return "Drag from one corner to the other · Ctrl turns snapping off";
  if (mode === "circle") return "Drag from the centre out";
  if (mode === "polygon")
    return drawing
      ? "Click corners · the first corner, double-click or Enter closes · Backspace removes the last"
      : "Click the corners of the zone";
  return selected
    ? "Drag to move · drag a handle to reshape · Del removes"
    : "Click a zone to edit it (the smallest one under the pointer)";
}

/**
 * The selected zone's details (SPEC §8.7 Zones): label, colour, whether players see it, a DM note and — for hazards —
 * its triggers (on entering, at the start or end of a turn inside) with an optional save and damage.
 */
export function ZoneEditor() {
  const tool = useUi((s) => s.tool);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
  const selected = useZoneTool((s) => s.selected);
  const zone = useBoard((d) => (selected ? d.zones.get(selected) : undefined));
  const banner = useHudInsets((s) => s.banner);
  const left = useHudInsets((s) => s.left);
  const right = useHudInsets((s) => s.right);
  const phone = useIsPhone();
  const zoneOnLeft = useMemo(() => {
    const shape = zone ? parseZoneShape(zone.shapeJson) : null;
    if (!shape) return false;
    const pts = shape.kind === "circle" ? [{ x: shape.x, y: shape.y }] : zonePolygon(shape);
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const at = boardApi.project(cx, cy);
    return !!at && at.sx < window.innerWidth / 2;
  }, [zone]);
  const dmData = parseDm(zone?.dmJson);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => setLabel(zone?.label ?? ""), [zone?.label]);
  useEffect(() => setNote(dmData.note), [dmData.note]);
  const labelId = useId();
  const noteId = useId();
  if (tool !== "zones" || !dm || !zone) return null;
  const hidden = zone.dmHidden === true;
  const triggers = dmData.triggers;
  const setTriggers = (next: Trigger[]) => void update(zone.id, { triggers: next });

  return (
    <section
      aria-label="Zone"
      data-testid="zone-editor"
      className="panel pointer-events-auto absolute z-30 flex max-h-[calc(100dvh-160px)] flex-col gap-3 overflow-y-auto p-3"
      // Never over the zone being edited: on the side of the screen away from it.
      style={
        phone
          ? { top: 68 + banner, left: 12, right }
          : zoneOnLeft
            ? { top: 68 + banner, right, width: "min(320px, calc(100vw - 96px))" }
            : { top: 68 + banner, left, width: "min(320px, calc(100vw - 96px))" }
      }
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="caps text-12 text-brass">
          {KINDS.find((k) => k.value === zone.kind)?.label ?? "Zone"}
        </h2>
        <IconButton label="Close" onClick={() => useZoneTool.setState({ selected: null })}>
          <X size={16} />
        </IconButton>
      </header>
      <div>
        <label htmlFor={labelId} className="caps mb-1 block text-12 text-fog">
          Label
        </label>
        <input
          id={labelId}
          value={label}
          maxLength={80}
          placeholder={zone.kind === "hazard" ? "Burning floor" : "Altar"}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            if (label.trim() !== zone.label) void update(zone.id, { label: label.trim() });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setLabel(zone.label);
          }}
          className="h-10 w-full rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-14 text-bone hover:border-line-strong focus:border-brass"
        />
      </div>
      <div role="radiogroup" aria-label="Zone colour" className="flex flex-wrap gap-1.5">
        {SWATCHES.map((c) => {
          const active = zone.color.toLowerCase() === c.hex.toLowerCase();
          return (
            <button
              key={c.hex}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={c.name}
              title={c.name}
              onClick={() => void update(zone.id, { color: c.hex })}
              className={`grid h-8 w-8 place-items-center rounded-full border-2 ${active ? "border-bone" : "border-transparent hover:border-line-strong"}`}
            >
              <span className="block h-5 w-5 rounded-full" style={{ background: c.hex }} aria-hidden />
            </button>
          );
        })}
      </div>
      <Toggle
        checked={!hidden}
        onChange={(v) => void update(zone.id, { visible: v })}
        label="Players see it"
        description={hidden ? "Hidden: its effects still apply" : undefined}
      />
      <div>
        <label htmlFor={noteId} className="caps mb-1 block text-12 text-fog">
          Note (DM only)
        </label>
        <textarea
          id={noteId}
          value={note}
          maxLength={2000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== dmData.note) void update(zone.id, { note });
          }}
          className="w-full resize-y rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 py-2 text-14 text-bone hover:border-line-strong focus:border-brass"
        />
      </div>
      {zone.kind === "hazard" ? (
        <div
          className="flex flex-col gap-2 border-t border-[var(--line-soft)] pt-3"
          data-testid="zone-triggers"
        >
          <h3 className="caps text-12 text-fog">Triggers</h3>
          {triggers.map((t, i) => (
            <TriggerCard
              key={i}
              trigger={t}
              onChange={(next) => setTriggers(triggers.map((x, k) => (k === i ? next : x)))}
              onRemove={() => setTriggers(triggers.filter((_, k) => k !== i))}
            />
          ))}
          {triggers.length < 6 ? (
            <Button
              size="S"
              variant="ghost"
              icon={<Plus size={16} />}
              onClick={() =>
                setTriggers([
                  ...triggers,
                  {
                    when: "enter",
                    label: zone.label || "Hazard",
                    save: { ability: "dex", dc: 12, onSuccess: "half" },
                    damage: { formula: "1d6", type: "fire" },
                  },
                ])
              }
            >
              Add trigger
            </Button>
          ) : null}
        </div>
      ) : null}
      <Button size="S" variant="danger" icon={<Trash2 size={16} />} onClick={() => void deleteZone(zone.id)}>
        Delete zone
      </Button>
    </section>
  );
}

function TriggerCard({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: Trigger;
  onChange: (t: Trigger) => void;
  onRemove: () => void;
}) {
  const [label, setLabel] = useState(trigger.label);
  const [formula, setFormula] = useState(trigger.damage?.formula ?? "1d6");
  const [dc, setDc] = useState(String(trigger.save?.dc ?? 12));
  useEffect(() => setLabel(trigger.label), [trigger.label]);
  useEffect(() => setFormula(trigger.damage?.formula ?? "1d6"), [trigger.damage?.formula]);
  useEffect(() => setDc(String(trigger.save?.dc ?? 12)), [trigger.save?.dc]);
  const input =
    "h-9 w-full rounded-[var(--radius-control)] border border-line bg-ink-900 px-2 text-14 text-bone hover:border-line-strong focus:border-brass";
  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line p-2"
      data-testid="zone-trigger"
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Select
            label="When"
            value={trigger.when}
            onChange={(when) => onChange({ ...trigger, when })}
            options={WHEN.map((w) => ({ value: w.value, label: w.label }))}
          />
        </div>
        <IconButton label="Remove trigger" tone="danger" onClick={onRemove}>
          <Trash2 size={16} />
        </IconButton>
      </div>
      <input
        aria-label="Trigger label"
        value={label}
        maxLength={80}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => {
          const v = label.trim() || trigger.label;
          if (v !== trigger.label) onChange({ ...trigger, label: v });
          else setLabel(trigger.label);
        }}
        className={input}
      />
      <Toggle
        checked={!!trigger.save}
        onChange={(v) => {
          const { save: _s, ...rest } = trigger;
          onChange(v ? { ...rest, save: { ability: "dex", dc: 12, onSuccess: "half" } } : rest);
        }}
        label="Saving throw"
      />
      {trigger.save ? (
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <Select
            label="Ability"
            value={trigger.save.ability}
            onChange={(ability) =>
              onChange({ ...trigger, save: { ...(trigger.save as NonNullable<Trigger["save"]>), ability } })
            }
            options={ABILITIES.map((a) => ({ value: a, label: ABILITY_NAMES[a] }))}
          />
          <div>
            <span className="caps mb-1.5 block text-12 text-fog">DC</span>
            <input
              aria-label="Save DC"
              inputMode="numeric"
              value={dc}
              onChange={(e) => setDc(e.target.value)}
              onBlur={() => {
                const n = Math.round(Number(dc));
                if (Number.isFinite(n) && n >= 1 && n <= 40 && n !== trigger.save?.dc)
                  onChange({
                    ...trigger,
                    save: { ...(trigger.save as NonNullable<Trigger["save"]>), dc: n },
                  });
                else setDc(String(trigger.save?.dc ?? 12));
              }}
              className={`${input} h-11 tabular`}
            />
          </div>
          <div className="col-span-2">
            <Select
              label="On a success"
              value={trigger.save.onSuccess}
              onChange={(onSuccess) =>
                onChange({
                  ...trigger,
                  save: { ...(trigger.save as NonNullable<Trigger["save"]>), onSuccess },
                })
              }
              options={[
                { value: "half", label: "Half damage" },
                { value: "none", label: "No damage" },
              ]}
            />
          </div>
        </div>
      ) : null}
      <Toggle
        checked={!!trigger.damage}
        onChange={(v) => {
          const { damage: _d, ...rest } = trigger;
          onChange(v ? { ...rest, damage: { formula: "1d6", type: "fire" } } : rest);
        }}
        label="Damage"
      />
      {trigger.damage ? (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="caps mb-1.5 block text-12 text-fog">Formula</span>
            <input
              aria-label="Damage formula"
              value={formula}
              maxLength={60}
              onChange={(e) => setFormula(e.target.value)}
              onBlur={() => {
                const v = formula.trim();
                if (v && v !== trigger.damage?.formula)
                  onChange({
                    ...trigger,
                    damage: { ...(trigger.damage as NonNullable<Trigger["damage"]>), formula: v },
                  });
                else setFormula(trigger.damage?.formula ?? "1d6");
              }}
              className={`${input} h-11 font-mono`}
            />
          </div>
          <Select
            label="Type"
            value={trigger.damage.type}
            onChange={(type) =>
              onChange({
                ...trigger,
                damage: { ...(trigger.damage as NonNullable<Trigger["damage"]>), type },
              })
            }
            options={DAMAGE_TYPES.map((d) => ({ value: d, label: d[0]?.toUpperCase() + d.slice(1) }))}
          />
        </div>
      ) : null}
    </div>
  );
}

function parseDm(json: string | undefined): { note: string; triggers: Trigger[] } {
  if (!json) return { note: "", triggers: [] };
  try {
    const d = JSON.parse(json) as { note?: string; triggers?: Trigger[] };
    return { note: d.note ?? "", triggers: Array.isArray(d.triggers) ? d.triggers : [] };
  } catch {
    return { note: "", triggers: [] };
  }
}
