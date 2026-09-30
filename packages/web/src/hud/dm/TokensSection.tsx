import type { TokenView } from "@gloam/shared/state";
import { Crosshair, Eye, EyeOff, Plus, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { boardApi } from "../../board/boardApi.ts";
import { ringColorOf } from "../../board/colors.ts";
import { useSheets } from "../../net/sheets.ts";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { ShortcutHint } from "../../ui/KeyHint.tsx";
import { SECTION_HEADING } from "../../ui/labels.ts";
import { Menu } from "../../ui/Menu.tsx";
import { Portrait } from "../../ui/Portrait.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";
import { openQuickUnit } from "../LeftToolbar.tsx";
import { useAssetImage } from "../useAssetImage.ts";
import { act, focusToken, overrideBadges, updateToken } from "./tokenDm.tsx";

type Filter = "all" | "party" | "foes" | "others" | "hidden";

const DISPOSITIONS = [
  { value: "party", label: "Party" },
  { value: "friendly", label: "Friendly" },
  { value: "neutral", label: "Neutral" },
  { value: "hostile", label: "Hostile" },
] as const;

const BAND = ["Down", "Critical", "Bloodied", "Hurt", "Healthy"];

function Row({
  t,
  picked,
  onPick,
  names,
  npcHp,
}: {
  t: TokenView;
  picked: boolean;
  onPick: () => void;
  names: (id: string) => string;
  npcHp: string;
}) {
  const src = useAssetImage(t.portraitAssetId || t.assetId || undefined, 64);
  const colorBlind = useSettings((s) => s.colorBlind);
  const badges = overrideBadges(t, names, npcHp);
  const hp = t.hp ? `${t.hp.hp}/${t.hp.hpMax}` : t.hpBand <= 4 ? BAND[t.hpBand] : "";
  const hide = () => updateToken(t.id, { hidden: !t.dm?.dmHidden });
  const settings = () => useUi.getState().set({ tokenSettings: t.id });
  const dispositions = DISPOSITIONS.map((d) => ({
    label: `${d.label}${t.disposition === d.value ? " ✓" : ""}`,
    onSelect: () => updateToken(t.id, { disposition: d.value }),
  }));
  return (
    <li className="flex items-center gap-2 px-2 py-1.5" data-testid="token-row" data-token={t.id}>
      <input
        type="checkbox"
        aria-label={`Choose ${t.name}`}
        checked={picked}
        onChange={onPick}
        className="h-4 w-4 shrink-0 accent-[var(--brass-500)]"
      />
      <button
        type="button"
        onClick={() => focusToken(t)}
        className="flex min-h-[var(--touch-min)] min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] px-1 py-1 text-left hover:bg-raised"
      >
        <span className={t.dm?.dmHidden ? "opacity-50" : ""}>
          <Portrait name={t.name} color={ringColorOf(t, colorBlind)} size={30} src={src} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-14 text-bone">{t.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-12 text-muted">
            <span className="capitalize">{t.disposition}</span>
            {hp ? <span className="tabular">· {hp}</span> : null}
            {badges.length ? (
              <span className="ml-1 flex min-w-0 items-center gap-1 overflow-hidden text-brass">
                {badges.slice(0, 5).map((b) => (
                  <Tooltip key={b.key} label={b.title}>
                    <span className="inline-flex" role="img" aria-label={b.title}>
                      <b.icon size={13} aria-hidden />
                    </span>
                  </Tooltip>
                ))}
                {badges.length > 5 ? <span>+{badges.length - 5}</span> : null}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {/* Wide: its three actions at hand. A phone: one menu of them — three buttons left the name "Gobli…". */}
      <span className="contents max-sm:hidden">
        <IconButton label={t.dm?.dmHidden ? `Reveal ${t.name}` : `Hide ${t.name}`} onClick={hide}>
          {t.dm?.dmHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </IconButton>
        <Menu label={`${t.name}: disposition`} items={dispositions} />
        <IconButton label={`${t.name}: DM settings`} onClick={settings}>
          <SlidersHorizontal size={15} />
        </IconButton>
      </span>
      <span className="sm:hidden">
        <Menu
          label={`${t.name}: actions`}
          items={[
            { label: "DM settings", icon: <SlidersHorizontal size={15} />, onSelect: settings },
            {
              label: t.dm?.dmHidden ? "Reveal" : "Hide",
              icon: t.dm?.dmHidden ? <Eye size={15} /> : <EyeOff size={15} />,
              onSelect: hide,
            },
            ...dispositions,
          ]}
        />
      </span>
    </li>
  );
}

/** The campaign's creatures to spawn (SPEC §8.5 Creation "from the Bestiary"): each placed as its own unlinked copy. */
function Bestiary() {
  const actors = useSheets((s) => s.actors);
  const scene = useBoard((d) => d.scene);
  const [q, setQ] = useState("");
  const creatures = useMemo(
    () =>
      [...actors.values()]
        .filter((a) => a.kind === "npc")
        .filter((a) => a.sheet.core.name.toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => a.sheet.core.name.localeCompare(b.sheet.core.name)),
    [actors, q],
  );
  if (!scene) return null;
  const place = (actorId: string, name: string, size: string) => {
    const el = boardApi.element;
    const r = el?.getBoundingClientRect();
    const at = (r ? boardApi.groundAt(r.left + r.width / 2, r.top + r.height / 2) : null) ?? { x: 0, y: 0 };
    act(
      request("token.create", {
        sceneId: scene.id,
        name,
        pos: { x: Math.round(at.x / 5) * 5 + 2.5, y: Math.round(at.y / 5) * 5 + 2.5 },
        size,
        actorId,
        link: "unlinked",
        disposition: "hostile",
      }),
      "Couldn't place it",
    );
  };
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4" aria-label="Bestiary">
      <h3 className={SECTION_HEADING}>Bestiary</h3>
      {creatures.length || q ? (
        <label className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fog"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Find a creature"
            placeholder="Find a creature"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 min-h-[var(--touch-min)] w-full rounded-[var(--radius-control)] border border-line bg-ink-950 pl-8 pr-2 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
          />
        </label>
      ) : null}
      {creatures.length ? (
        <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
          {creatures.map((a) => {
            const c = a.sheet.core;
            return (
              <li key={a.id} className="flex items-center gap-2 px-3 py-1.5" data-testid="bestiary-row">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-14 text-bone">{c.name}</span>
                  <span className="tabular truncate text-12 text-muted">
                    <span className="capitalize">{c.size}</span> · AC {c.ac.value} · HP {c.hp.max}
                  </span>
                </span>
                <Button
                  size="S"
                  variant="secondary"
                  icon={<Plus size={14} />}
                  onClick={() => place(a.id, c.name, c.size)}
                >
                  Place
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-13 text-muted">
          {q
            ? "No creature by that name."
            : "No creatures yet. Import a stat block or make an NPC's sheet, and it's here to place — each copy with its own HP."}
        </p>
      )}
    </section>
  );
}

/**
 * DM panel → Tokens & Units (SPEC §8.19): the creatures on the scene — found by name, filtered (party, foes, others,
 * hidden), each brought into view, hidden or revealed, its disposition changed, its DM settings opened; chosen ones
 * hidden or revealed together; Quick Unit and the Bestiary to add more.
 */
export function TokensSection() {
  const tokens = useBoard((d) => d.tokens);
  const presence = useTable((s) => s.presence);
  const npcHp = useTable((s) => s.houseRules?.npcHpDisplay ?? "bar");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const names = (id: string) => presence.find((p) => p.userId === id)?.name ?? "someone";
  const all = [...tokens.values()];
  const list = all
    .filter((t) =>
      filter === "party"
        ? t.disposition === "party"
        : filter === "foes"
          ? t.disposition === "hostile"
          : filter === "others"
            ? t.disposition === "friendly" || t.disposition === "neutral"
            : filter === "hidden"
              ? t.dm?.dmHidden === true
              : true,
    )
    .filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const chosen = [...picked].filter((id) => tokens.has(id));
  const setAll = (hidden: boolean) => {
    for (const id of chosen) updateToken(id, { hidden });
    setPicked(new Set());
  };
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="tokens-section">
      <div className="flex flex-wrap gap-2">
        <Button size="S" variant="secondary" icon={<Plus size={15} />} onClick={openQuickUnit}>
          Quick unit
          <ShortcutHint keys="Q" />
        </Button>
        {chosen.length ? (
          <>
            <Button size="S" variant="ghost" icon={<EyeOff size={15} />} onClick={() => setAll(true)}>
              Hide {chosen.length}
            </Button>
            <Button size="S" variant="ghost" icon={<Eye size={15} />} onClick={() => setAll(false)}>
              Reveal {chosen.length}
            </Button>
            <Button size="S" variant="ghost" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
          </>
        ) : null}
      </div>
      <Segmented
        label="Show"
        size="S"
        fill
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: `All ${all.length}` },
          { value: "party", label: "Party" },
          { value: "foes", label: "Foes" },
          { value: "others", label: "Others" },
          { value: "hidden", label: "Hidden" },
        ]}
      />
      <label className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fog"
          aria-hidden
        />
        <input
          type="search"
          aria-label="Find a token"
          placeholder="Find a token"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 min-h-[var(--touch-min)] w-full rounded-[var(--radius-control)] border border-line bg-ink-950 pl-8 pr-2 text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
        />
      </label>
      {list.length ? (
        <ul className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line">
          {list.map((t) => (
            <Row
              key={t.id}
              t={t}
              names={names}
              npcHp={npcHp}
              picked={picked.has(t.id)}
              onPick={() =>
                setPicked((s) => {
                  const n = new Set(s);
                  if (n.has(t.id)) n.delete(t.id);
                  else n.add(t.id);
                  return n;
                })
              }
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          art="candle"
          title={
            all.length
              ? "Nothing here matches."
              : "No tokens on this scene. Quick unit, the Bestiary or the Library add them."
          }
        />
      )}
      <Button
        size="S"
        variant="ghost"
        icon={<Crosshair size={15} />}
        className="self-start"
        disabled={!chosen.length}
        onClick={() => useUi.getState().set({ selection: chosen })}
      >
        Select these on the board
      </Button>
      <Bestiary />
    </div>
  );
}
