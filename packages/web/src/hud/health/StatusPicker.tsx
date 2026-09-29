import { CONDITION_IDS, MARKER_IDS, PLAYER_COLORS } from "@gloam/shared";
import { STATUS_ICONS } from "@gloam/shared/icons";
import { statusName, statusSummary } from "@gloam/shared/rules";
import { Search } from "lucide-react";
import { useState } from "react";
import { StatusIcon } from "../../icons/status.tsx";
import { changeStatus, type StatusDraft } from "../../net/health.ts";
import { useSheets } from "../../net/sheets.ts";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { ColorSwatchPicker } from "../../ui/ColorSwatchPicker.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";

/** Markers a person sets by hand (Bloodied and the death-save states follow HP; the DM may still set them). */
const HAND_MARKERS = MARKER_IDS.filter((m) => m !== "bloodied" && m !== "deathsaves");

/**
 * The condition picker (SPEC §8.11): a searchable grid of the 15 SRD conditions and the status markers — each with its
 * icon, name and one-line summary — toggled on and off at once (each an undoable command); where a condition came
 * from and how many rounds it lasts; the Exhaustion level; what the creature concentrates on; and, for the DM, custom
 * markers (a name, a colour, a glyph from the icon set, a duration). For a token, or a character with none on the
 * board (its sheet's conditions).
 */
export function StatusPicker() {
  const target = useUi((s) => s.statusPicker);
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const token = useBoard((d) => (target?.tokenId ? d.tokens.get(target.tokenId) : undefined));
  const actor = useSheets((s) => {
    const id = target?.actorId ?? token?.actorId;
    return id ? s.actors.get(id) : undefined;
  });
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [rounds, setRounds] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState({ name: "", color: "orchid", glyph: "custom", rounds: "" });
  const close = () => {
    useUi.getState().set({ statusPicker: null });
    setQ("");
    setFocus(null);
  };

  const name = token?.name ?? actor?.sheet.core.name ?? "";
  const conditions = token ? token.conditions : (actor?.sheet.core.conditions ?? []);
  const markers = token ? token.markers : [];
  const exhaustion = token ? token.exhaustion : (actor?.sheet.core.exhaustion ?? 0);
  const concentration = actor?.sheet.core.concentration ?? "";
  const concentrating = token ? token.concentrating : Boolean(concentration);
  const customs = (token?.customMarkers ?? []).map((s) => {
    const [id, label, color, glyph] = s.split("|") as [string, string, string, string];
    return { id, label, color, glyph };
  });

  const ref = target?.tokenId
    ? { tokenId: target.tokenId }
    : target?.actorId
      ? { actorId: target.actorId }
      : null;
  const send = async (d: Omit<StatusDraft, "tokenId" | "actorId">, key: string) => {
    if (!ref) return;
    setBusy(key);
    try {
      await changeStatus({ ...ref, ...d });
    } catch (e) {
      toast.danger("Couldn't change that", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const extra = () => {
    const r = Math.floor(Number(rounds));
    return { ...(source.trim() ? { source: source.trim() } : {}), ...(r > 0 ? { untilRound: r } : {}) };
  };
  const toggle = (id: string, on: boolean) =>
    void send(on ? { remove: [id] } : { add: [{ id, ...extra() }] }, id);

  const match = (id: string) => {
    const t = q.trim().toLowerCase();
    return !t || statusName(id).toLowerCase().includes(t) || statusSummary(id).toLowerCase().includes(t);
  };
  const conds = CONDITION_IDS.filter((c) => c !== "exhaustion").filter(match);
  const marks = token ? HAND_MARKERS.filter(match) : [];
  const shownSummary = focus ? statusSummary(focus) : null;

  const tile = (
    id: string,
    on: boolean,
    label = statusName(id),
    look: { glyph?: string; color?: string } = {},
  ) => (
    <li key={id}>
      <button
        type="button"
        aria-pressed={on}
        title={statusSummary(id) || label}
        disabled={busy === id}
        onClick={() => toggle(id, on)}
        onFocus={() => setFocus(id)}
        onMouseEnter={() => setFocus(id)}
        data-status={id}
        className={`flex min-h-[var(--touch-min)] w-full items-center gap-2 rounded-[var(--radius-control)] border px-2 py-1.5 text-left text-13 transition-[border-color,box-shadow,background-color] duration-[var(--dur-fast)] ${
          on
            ? "border-brass bg-[var(--glow-brass-soft)] text-bone shadow-[0_0_0_2px_var(--glow-brass-soft)]"
            : "border-line text-muted hover:border-line-strong hover:text-bone"
        }`}
      >
        <StatusIcon id={id} size={24} badge label="" glyph={look.glyph} color={look.color} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </li>
  );

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={`Conditions — ${name}`}
      width={680}
      footer={
        <div className="flex justify-end">
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="status-picker">
        <label className="relative block">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fog"
            aria-hidden
          />
          <input
            data-autofocus
            aria-label="Search conditions and markers"
            placeholder="Search — “prone”, “advantage”, “speed”…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-11 w-full rounded-[var(--radius-control)] border border-line bg-ink-900 pl-9 pr-3 text-14 text-bone placeholder:text-faint focus:border-brass focus:shadow-[var(--ring-focus)] focus:outline-none"
          />
        </label>
        <section aria-label="Conditions" className="flex flex-col gap-1.5">
          <h3 className="caps text-12 text-fog">Conditions</h3>
          {conds.length ? (
            <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {conds.map((id) => tile(id, conditions.includes(id)))}
            </ul>
          ) : (
            <p className="text-13 text-muted">No condition matches.</p>
          )}
        </section>
        {token ? (
          <section aria-label="Markers" className="flex flex-col gap-1.5">
            <h3 className="caps text-12 text-fog">Markers</h3>
            <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {marks.map((id) => tile(id, markers.includes(id)))}
              {customs.map((c) =>
                tile(c.id, true, c.label || statusName(c.id), { glyph: c.glyph, color: c.color }),
              )}
            </ul>
          </section>
        ) : null}
        <p className="min-h-10 text-13 text-muted" aria-live="polite" data-testid="status-summary">
          {shownSummary ? (
            <>
              <strong className="text-bone">{focus ? statusName(focus) : ""}</strong> — {shownSummary}
            </>
          ) : (
            "Hover or focus one to read what it does."
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-14">
            <span className="caps text-12 text-fog">From (optional)</span>
            <input
              value={source}
              maxLength={80}
              placeholder="Dragon's Frightful Presence"
              onChange={(e) => setSource(e.target.value)}
              className="h-10 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-14 text-bone placeholder:text-faint focus:border-brass focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-14">
            <span className="caps text-12 text-fog">Lasts until round (optional)</span>
            <input
              inputMode="numeric"
              value={rounds}
              placeholder="—"
              onChange={(e) => setRounds(e.target.value.replace(/\D/g, "").slice(0, 5))}
              className="h-10 w-28 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-14 text-bone placeholder:text-faint focus:border-brass focus:outline-none"
            />
          </label>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="caps text-12 text-fog">Exhaustion</span>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Exhaustion level"
              size="S"
              value={String(exhaustion)}
              onChange={(v) => void send({ exhaustion: Number(v) }, "exhaustion")}
              options={[0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n) }))}
            />
            <span className="text-13 text-muted">
              {exhaustion
                ? `−${2 * exhaustion} to D20 Tests · −${5 * exhaustion} ft speed${exhaustion >= 6 ? " · dead?" : ""}`
                : "None"}
            </span>
          </div>
        </div>
        <ConcentrationRow
          concentrating={concentrating}
          spell={concentration}
          busy={busy === "concentration"}
          onSet={(v) => void send({ concentration: v }, "concentration")}
        />
        {dm && token ? (
          <details className="rounded-[var(--radius-control)] border border-line px-3 py-2">
            <summary className="min-h-[var(--touch-min)] cursor-pointer py-2 text-14 text-bone">
              A custom marker…
            </summary>
            <div className="flex flex-col gap-3 pb-2 pt-1">
              <label className="flex flex-col gap-1.5">
                <span className="caps text-12 text-fog">Name</span>
                <input
                  value={custom.name}
                  maxLength={40}
                  placeholder="Hexed"
                  onChange={(e) => setCustom((c) => ({ ...c, name: e.target.value }))}
                  className="h-10 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-14 text-bone focus:border-brass focus:outline-none"
                />
              </label>
              <ColorSwatchPicker
                label="Its colour"
                value={custom.color}
                onChange={(color) => setCustom((c) => ({ ...c, color }))}
              />
              <div className="flex flex-col gap-1.5">
                <span className="caps text-12 text-fog">Its glyph</span>
                <div role="radiogroup" aria-label="Glyph" className="flex flex-wrap gap-1">
                  {STATUS_ICONS.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      role="radio"
                      aria-checked={custom.glyph === i.id}
                      aria-label={i.name}
                      title={i.name}
                      onClick={() => setCustom((c) => ({ ...c, glyph: i.id }))}
                      className={`grid h-9 w-9 min-h-[var(--touch-min)] min-w-[var(--touch-min)] place-items-center rounded-[var(--radius-control)] border ${
                        custom.glyph === i.id
                          ? "border-brass bg-raised"
                          : "border-transparent hover:border-line"
                      }`}
                    >
                      <StatusIcon id={i.id} size={20} label="" />
                    </button>
                  ))}
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={!custom.name.trim()}
                onClick={() => {
                  const slug = custom.name
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "")
                    .slice(0, 32);
                  const hex = (
                    PLAYER_COLORS.find((c) => c.id === custom.color) ?? (PLAYER_COLORS[0] as { hex: string })
                  ).hex;
                  void send(
                    {
                      add: [
                        {
                          id: `custom:${slug || "marker"}`,
                          label: custom.name.trim(),
                          color: hex,
                          glyph: custom.glyph,
                          ...extra(),
                        },
                      ],
                    },
                    "custom",
                  ).then(() => setCustom((c) => ({ ...c, name: "" })));
                }}
              >
                Add the marker
              </Button>
            </div>
          </details>
        ) : null}
      </div>
    </Dialog>
  );
}

function ConcentrationRow({
  concentrating,
  spell,
  busy,
  onSet,
}: {
  concentrating: boolean;
  spell: string;
  busy: boolean;
  onSet: (v: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-col gap-1.5">
      <span className="caps text-12 text-fog">Concentration</span>
      {concentrating ? (
        <div className="flex flex-wrap items-center gap-2 text-14 text-bone">
          <StatusIcon id="concentrating" size={22} badge label="" />
          <span>{spell ? `On ${spell}` : "Concentrating"}</span>
          <Button size="S" variant="ghost" loading={busy} onClick={() => onSet(null)}>
            End it
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) onSet(draft.trim());
            setDraft("");
          }}
        >
          <input
            aria-label="Concentrating on"
            value={draft}
            maxLength={80}
            placeholder="Bless"
            onChange={(e) => setDraft(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-14 text-bone focus:border-brass focus:outline-none"
          />
          <Button size="S" variant="secondary" type="submit" disabled={!draft.trim()} loading={busy}>
            Concentrate
          </Button>
        </form>
      )}
    </div>
  );
}
