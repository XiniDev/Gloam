import type { ActorView } from "@gloam/shared/protocol";
import { effectiveSpeed, statusName, statusSummary } from "@gloam/shared/rules";
import { parseCustomMarkers } from "@gloam/shared/state";
import {
  ChevronDown,
  FileDown,
  FileUp,
  Lock,
  Plus,
  ScrollText,
  Sparkles,
  Trash2,
  Unlock,
  UserPlus,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { StatusIcon } from "../../icons/status.tsx";
import { changeStatus } from "../../net/health.ts";
import { useSheets } from "../../net/sheets.ts";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { prefersReducedMotion } from "../../state/settings.ts";
import { type SheetTab, useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { Portrait } from "../../ui/Portrait.tsx";
import { toast } from "../../ui/Toast.tsx";
import { useAssetImage } from "../useAssetImage.ts";
import { type SheetCtx, useSheetCtx } from "./context.ts";
import { ImportDialog } from "./ImportDialog.tsx";
import { ProposeDialog } from "./ProposeDialog.tsx";
import { LockMark, NumberField, Rollable, Stepper, TextField } from "./primitives.tsx";
import { QuickCreateDialog } from "./QuickCreateDialog.tsx";
import { isDmRole, signed } from "./sheetActions.ts";
import { AbilitiesTab } from "./tabs/AbilitiesTab.tsx";
import { ActionsTab } from "./tabs/ActionsTab.tsx";
import { CustomTab } from "./tabs/CustomTab.tsx";
import { FeaturesTab } from "./tabs/FeaturesTab.tsx";
import { InventoryTab } from "./tabs/InventoryTab.tsx";
import { NotesTab } from "./tabs/NotesTab.tsx";
import { OverviewTab } from "./tabs/OverviewTab.tsx";
import { SpellsTab } from "./tabs/SpellsTab.tsx";
import { TokenTab } from "./tabs/TokenTab.tsx";
import { visibleTabs } from "./tabsLayout.ts";

const TABS: { id: SheetTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "abilities", label: "Abilities" },
  { id: "actions", label: "Actions" },
  { id: "spells", label: "Spells" },
  { id: "inventory", label: "Inventory" },
  { id: "features", label: "Features" },
  { id: "custom", label: "Custom" },
  { id: "notes", label: "Notes" },
  { id: "token", label: "Token" },
];

/** Which character the panel shows: the one picked, else the selected token's, else your own (DMs: the first). */
function useShownActor(): { actor: ActorView | undefined; readable: ActorView[] } {
  const actors = useSheets((s) => s.actors);
  const chosen = useUi((s) => s.sheetActor);
  const me = useTable((s) => s.me);
  const selected = useUi((s) => (s.selection.length === 1 ? s.selection[0] : undefined));
  const selectedActor = useBoard((d) => (selected ? d.tokens.get(selected)?.actorId : undefined));
  const readable = [...actors.values()].sort((a, b) => a.sheet.core.name.localeCompare(b.sheet.core.name));
  const pick = (id: string | null | undefined) => (id ? actors.get(id) : undefined);
  const own = readable.find((a) => a.ownerUserId === me?.userId && a.kind === "character");
  const actor = pick(chosen) ?? pick(selectedActor) ?? own ?? (isDmRole(me?.role) ? readable[0] : undefined);
  return { actor, readable };
}

/**
 * The character sheet (SPEC §8.10 UI, §29.7): a parchment page in the dock (a full page on phones) — the header with
 * the character's vitals, then tabs for everything else. Every number that rolls, rolls; every field is edited in
 * place; a field the lock keeps from a player becomes a proposal to the DM.
 */
export function SheetPanel() {
  const { actor, readable } = useShownActor();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<"json" | "ai" | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="sheet-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ScrollText size={18} className="shrink-0 text-brass" aria-hidden />
        <h2 className="text-18 text-bone">Sheet</h2>
        {readable.length > 1 ? (
          <select
            aria-label="Character"
            value={actor?.id ?? ""}
            onChange={(e) => useUi.getState().set({ sheetActor: e.target.value || null })}
            className="h-8 min-h-[var(--touch-min)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-ink-900 px-2 text-13 text-bone"
          >
            {readable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.sheet.core.name}
                {a.kind === "npc" ? " (creature)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex-1" />
        )}
        <IconButton label="New character" onClick={() => setCreating(true)}>
          <UserPlus size={17} />
        </IconButton>
      </div>
      {actor ? (
        <SheetPage key={actor.id} actor={actor} onImport={setImporting} />
      ) : (
        <div className="p-4">
          <EmptyState title="No character yet. Make one in a minute — a name, a class, HP, AC and speed are enough to play — or bring one from another sheet." />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
              Quick create
            </Button>
            <Button variant="secondary" icon={<FileUp size={16} />} onClick={() => setImporting("json")}>
              Import JSON…
            </Button>
            <Button variant="ghost" icon={<Sparkles size={16} />} onClick={() => setImporting("ai")}>
              Import with AI…
            </Button>
          </div>
        </div>
      )}
      <QuickCreateDialog open={creating} onClose={() => setCreating(false)} />
      <ImportDialog mode={importing} actor={actor ?? null} onClose={() => setImporting(null)} />
      <ProposeDialog />
    </div>
  );
}

const TAB_CLASS =
  "h-9 min-h-[var(--touch-min)] shrink-0 whitespace-nowrap px-2 text-13 font-semibold transition-[color,box-shadow] duration-[var(--dur-fast)]";
/**
 * The sheet's sections (§29.7): one row of tabs in their fixed order — as many as the bar holds, the rest under "+n".
 * Widths come from an invisible copy of every tab and of the More button, measured again as the panel is resized and
 * once the fonts have loaded.
 */
function SheetTabs({ tab }: { tab: SheetTab }) {
  const bar = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ avail: number; widths: number[]; moreW: number } | null>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    const m = ruler.current;
    if (!el || !m) return;
    const update = () => {
      const cs = getComputedStyle(el);
      const avail = el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
      const all = [...m.children].map((c) => (c as HTMLElement).getBoundingClientRect().width);
      const moreW = all.pop() ?? 0;
      setRoom((r) =>
        r && r.avail === avail && r.moreW === moreW && r.widths.every((w, k) => w === all[k])
          ? r
          : { avail, widths: all, moreW },
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(m);
    void document.fonts?.ready.then(update);
    return () => ro.disconnect();
  }, []);
  const active = Math.max(
    0,
    TABS.findIndex((t) => t.id === tab),
  );
  const shown = room ? visibleTabs(room.widths, room.moreW, room.avail, active) : TABS.map((_, k) => k);
  const rest = TABS.filter((_, k) => !shown.includes(k));
  const pick = (id: SheetTab) => useUi.getState().set({ sheetTab: id });
  return (
    <div
      ref={bar}
      className="parchment-bar sticky top-0 z-10 flex shrink-0 items-center border-b border-parchment-edge px-2"
    >
      {/* The widths' ruler, laid out but inside a box of no size (an absolute row of every tab still counted toward
          the page's scroll width, so the page could be slid sideways). */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden"
      >
        <div ref={ruler} className="flex w-max whitespace-nowrap">
          {TABS.map((t) => (
            <span key={t.id} className={`${TAB_CLASS} inline-flex items-center`}>
              {t.label}
            </span>
          ))}
          {/* The More button as it's drawn (Menu's labelled button), widest count. */}
          <span className="inline-flex h-9 items-center gap-1 px-2 text-13 font-bold">
            +{TABS.length - 1}
            <ChevronDown size={14} />
          </span>
        </div>
      </div>
      <div aria-label="Sheet sections" role="tablist" className="flex min-w-0 flex-1 gap-0.5">
        {shown.map((k) => {
          const t = TABS[k] as (typeof TABS)[number];
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => pick(t.id)}
              className={`${TAB_CLASS} ${
                tab === t.id
                  ? "text-paper-ink shadow-[inset_0_-2px_0_var(--brass-600)]"
                  : "text-paper-muted shadow-[inset_0_-2px_0_transparent] hover:text-paper-ink"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {rest.length ? (
        <Menu
          label="More sections"
          text={`+${rest.length}`}
          items={rest.map((t) => ({ label: t.label, onSelect: () => pick(t.id) }))}
        />
      ) : null}
    </div>
  );
}

function SheetPage({ actor, onImport }: { actor: ActorView; onImport: (m: "json" | "ai") => void }) {
  const ctx = useSheetCtx(actor);
  const tab = useUi((s) => s.sheetTab);
  const page = useRef<HTMLElement>(null);
  const tabsAt = useRef<HTMLDivElement>(null);
  // Another section opens at its top: a page scrolled past the header comes back to where the tabs stick; and where
  // the header leaves the section less than half the page (a phone, a short screen), picking one scrolls the header
  // away so the section is what's in view. (Not when the sheet first opens: its header is what's wanted then.)
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the section changes
  useLayoutEffect(() => {
    const el = page.current;
    const mark = tabsAt.current;
    if (!el || !mark) return;
    const at = mark.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    if (el.scrollTop > at) el.scrollTop = at;
    else if (opened.current && el.clientHeight - (at - el.scrollTop) < el.clientHeight / 2)
      el.scrollTo({ top: at, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    opened.current = true;
  }, [tab]);
  return (
    <article
      ref={page}
      // One scrolling page: the header scrolls away and the tabs stay on top (a phone has room for the section,
      // not only for the header). Never scrollable sideways (a wide child would slide the page left and cut its edge).
      className="parchment m-2 flex min-h-0 min-w-0 flex-1 scroll-pt-12 flex-col overflow-y-auto overflow-x-clip"
      data-testid="sheet"
      data-actor={actor.id}
      aria-label={`${actor.sheet.core.name}'s sheet`}
    >
      <SheetHeader ctx={ctx} onImport={onImport} />
      <div ref={tabsAt} aria-hidden className="h-0 shrink-0" />
      <SheetTabs tab={tab} />
      <div
        className="min-w-0 flex-1 overflow-x-clip px-3 pt-2 pb-4"
        role="tabpanel"
        data-testid={`sheet-tab-${tab}`}
      >
        {tab === "overview" ? <OverviewTab ctx={ctx} /> : null}
        {tab === "abilities" ? <AbilitiesTab ctx={ctx} /> : null}
        {tab === "actions" ? <ActionsTab ctx={ctx} /> : null}
        {tab === "spells" ? <SpellsTab ctx={ctx} /> : null}
        {tab === "inventory" ? <InventoryTab ctx={ctx} /> : null}
        {tab === "features" ? <FeaturesTab ctx={ctx} /> : null}
        {tab === "custom" ? <CustomTab ctx={ctx} /> : null}
        {tab === "notes" ? <NotesTab ctx={ctx} /> : null}
        {tab === "token" ? <TokenTab ctx={ctx} /> : null}
      </div>
    </article>
  );
}

/** "Dwarf · Fighter 5 / Wizard 1 · Soldier". */
function subtitle(ctx: SheetCtx): string {
  const c = ctx.sheet.core;
  const classes = c.classes.map((k) => `${k.name} ${k.level}`).join(" / ");
  return [c.species, classes, c.background].filter(Boolean).join(" · ");
}

function SheetHeader({ ctx, onImport }: { ctx: SheetCtx; onImport: (m: "json" | "ai") => void }) {
  const c = ctx.sheet.core;
  const d = ctx.derived.values;
  const portrait = useAssetImage(c.portraitAssetId, 128);
  const [amount, setAmount] = useState("");
  const target = useSheetTarget(ctx.actor.id);
  // Damage and healing go through the HP pipeline (§8.11): the dialog shows its preview before applying.
  const dmg = (heal: boolean) => {
    const n = Math.max(0, Math.floor(Number(amount)));
    setAmount("");
    useUi.getState().set({
      hpDialog: {
        targets: [target.tokenId ?? ctx.actor.id],
        kind: heal ? "heal" : "damage",
        ...(n ? { amount: n } : {}),
      },
    });
  };
  const lockLabel = { unlocked: "Unlocked", core: "Core locked", full: "Fully locked" }[ctx.actor.lockLevel];
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(ctx.sheet, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${c.name.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "character"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const [naming, setNaming] = useState<string | null>(null);
  const saveTemplate = async () => {
    const name = naming?.trim();
    if (!name) return;
    try {
      await request("template.save", { name, fromActorId: ctx.actor.id });
      toast.success("Template saved", `New characters can start from “${name}”.`);
      setNaming(null);
    } catch (e) {
      toast.danger("Couldn't save the template", (e as Error).message);
    }
  };
  const remove = async () => {
    try {
      await request("actor.delete", { actorId: ctx.actor.id });
      useUi.getState().set({ sheetActor: null });
    } catch (e) {
      toast.danger("Couldn't remove the character", (e as Error).message);
    }
  };
  return (
    <header className="shrink-0 px-3 pt-3 pb-2">
      <div className="flex items-start gap-3">
        <Portrait name={c.name} color="var(--wax-500)" size={52} src={portrait} />
        <div className="min-w-0 flex-1">
          <NameField ctx={ctx} />
          <p className="truncate px-1 text-13 text-paper-muted" data-testid="sheet-subtitle">
            {subtitle(ctx) || "—"}
          </p>
          {/* The lock and what's waiting on the DM, on one line (the DM sets the lock below). */}
          {ctx.dm ? null : (
            <p className="flex min-w-0 items-center gap-1.5 px-1 text-12 text-paper-muted">
              <span className="inline-flex shrink-0 items-center gap-1" data-testid="sheet-lock">
                {ctx.actor.lockLevel === "unlocked" ? (
                  <Unlock size={12} aria-hidden />
                ) : (
                  <Lock size={12} aria-hidden />
                )}
                {lockLabel}
              </span>
              <PendingProposals actorId={ctx.actor.id} />
            </p>
          )}
        </div>
        <Inspiration ctx={ctx} />
        <Menu
          label="Sheet actions"
          items={[
            { label: "Export JSON", icon: <FileDown size={15} />, onSelect: exportJson },
            ...(ctx.canEdit
              ? [
                  { label: "Import JSON…", icon: <FileUp size={15} />, onSelect: () => onImport("json") },
                  { label: "Import with AI…", icon: <Sparkles size={15} />, onSelect: () => onImport("ai") },
                  {
                    label: "Save custom blocks as a template…",
                    onSelect: () => setNaming(`${c.name}'s layout`),
                  },
                  {
                    label: "Remove this character",
                    icon: <Trash2 size={15} />,
                    danger: true,
                    onSelect: () => void remove(),
                  },
                ]
              : []),
          ]}
        />
      </div>
      {/* The lock (§8.10 Ownership and locks): the DM sets it. */}
      {ctx.dm ? (
        <div className="mt-2">
          <Segmented
            label="Sheet lock"
            size="S"
            tone="paper"
            fill
            value={ctx.actor.lockLevel}
            onChange={(level) => void request("actor.setLock", { actorId: ctx.actor.id, level })}
            options={[
              { value: "unlocked", label: "Unlocked" },
              { value: "core", label: "Core locked", hint: "Players change play-state only" },
              { value: "full", label: "Fully locked", hint: "Read-only for players" },
            ]}
          />
        </div>
      ) : null}
      {/* Vitals (§29.7): HP large in the display face, − and + either side of the whole value. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="sheet-vitals">
        <div className="flex min-w-0 items-center gap-1">
          <span className="caps text-12 text-paper-muted">HP</span>
          <Stepper
            big
            label="Current HP"
            value={c.hp.current}
            min={-c.hp.max}
            max={c.hp.max}
            disabled={!ctx.canEdit}
            onChange={(v) => void ctx.set(["core", "hp", "current"], v)}
            after={
              <span className="display flex items-baseline text-18 text-paper-muted">
                <span aria-hidden>/</span>
                <NumberField
                  label="Max HP"
                  value={c.hp.max}
                  min={0}
                  width="2.6rem"
                  disabled={!ctx.canEdit}
                  onCommit={(v) => void ctx.set(["core", "hp", "max"], v)}
                  className="text-18"
                />
              </span>
            }
          />
          <span className="inline-flex items-center gap-0.5 rounded-chip border border-parchment-edge/60 bg-parchment-deep/40 pl-1.5 text-13">
            <span className="caps text-12 text-paper-muted">temp</span>
            <NumberField
              label="Temporary HP"
              value={c.hp.temp}
              min={0}
              width="2.4rem"
              disabled={!ctx.canEdit}
              onCommit={(v) => void ctx.set(["core", "hp", "temp"], v)}
            />
          </span>
        </div>
        {ctx.canEdit ? (
          <div className="flex items-center gap-1">
            <input
              aria-label="Damage or healing amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="0"
              className="tabular h-8 min-h-[var(--touch-min)] w-12 rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-1 text-center text-14 text-paper-ink focus:border-brass-deep focus:shadow-[var(--ring-focus)] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => dmg(false)}
              className="h-8 min-h-[var(--touch-min)] min-w-[var(--touch-min)] rounded-[var(--radius-control)] border border-wax px-2 text-13 font-bold text-wax hover:bg-wax hover:text-parchment"
            >
              Damage
            </button>
            <button
              type="button"
              onClick={() => dmg(true)}
              className="h-8 min-h-[var(--touch-min)] min-w-[var(--touch-min)] rounded-[var(--radius-control)] border border-paper-ink/40 px-2 text-13 font-bold text-paper-ink hover:bg-parchment-deep"
            >
              Heal
            </button>
          </div>
        ) : null}
      </div>
      {/* The numbers most asked for, labels above values. */}
      <dl className="mt-2 grid grid-cols-4 gap-1.5 text-center" data-testid="sheet-stats">
        <Stat label="AC">
          <NumberField
            label="Armour class"
            value={c.ac.value}
            min={0}
            max={99}
            width="100%"
            disabled={!ctx.canEdit}
            onCommit={(v) => void ctx.set(["core", "ac", "value"], v)}
            className="text-16"
          />
        </Stat>
        <Stat label="Init">
          <Rollable
            actor={ctx.actor}
            formula="1d20 + @init"
            label="Initiative"
            className="tabular min-h-[var(--touch-min)] justify-center text-16 font-bold"
          >
            {signed(d.initiative)}
          </Rollable>
        </Stat>
        <Stat label="Speed">
          <SpeedValue core={c} />
        </Stat>
        <Stat label="Prof">
          <span className="tabular text-16 font-bold">{signed(d.proficiencyBonus)}</span>
        </Stat>
      </dl>
      {senses(c) ? <p className="mt-1 px-1 text-13 text-paper-muted">{senses(c)}</p> : null}
      <Conditions ctx={ctx} />
      <Dialog
        open={naming !== null}
        onClose={() => setNaming(null)}
        variant="parchment"
        title="Save as a template"
        description="The custom blocks' layout — titles, kinds, table columns, counters' maximums — without what's filled in. New characters can start from it."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!naming?.trim()} onClick={() => void saveTemplate()}>
              Save template
            </Button>
          </div>
        }
      >
        <label className="flex flex-col gap-1 text-14">
          <span className="caps text-12 text-paper-muted">Template name</span>
          <input
            data-autofocus
            value={naming ?? ""}
            maxLength={80}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveTemplate()}
            className="h-10 rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-2 text-16 text-paper-ink focus:border-brass-deep focus:shadow-[var(--ring-focus)] focus:outline-none"
          />
        </label>
      </Dialog>
    </header>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-[var(--radius-control)] border border-parchment-edge/50 bg-parchment-deep/30 px-1 py-0.5">
      <dt className="caps text-12 text-paper-muted">{label}</dt>
      <dd className="flex min-h-8 items-center justify-center text-paper-ink">{children}</dd>
    </div>
  );
}

/**
 * Its walking speed as it moves now — after its conditions (Speed 0) and Exhaustion (−5 ft a level; §19.4, AC-HP-05),
 * as its token and hover card say (critic P7 r2 #11) — with its base speed under it when they differ.
 */
function SpeedValue({ core: c }: { core: SheetCtx["sheet"]["core"] }) {
  const now = effectiveSpeed(c.speeds.walk, c.conditions, c.exhaustion);
  const why = [
    ...c.conditions
      .filter((id) => effectiveSpeed(30, [id], 0) === 0)
      .map((id) => `${statusName(id)}: Speed 0`),
    ...(c.exhaustion > 0 ? [`Exhaustion ${c.exhaustion}: −${5 * c.exhaustion} ft`] : []),
  ].join(" · ");
  return (
    <span
      className="flex flex-col items-center leading-tight"
      title={now !== c.speeds.walk ? why : undefined}
    >
      <span className="tabular text-16 font-bold" data-testid="sheet-speed">
        {now} ft
      </span>
      {now !== c.speeds.walk ? (
        <span className="tabular text-12 text-paper-muted" data-testid="sheet-speed-base">
          base {c.speeds.walk}
        </span>
      ) : null}
    </span>
  );
}

/** Senses beyond plain sight, as a line: "Darkvision 60 ft · Tremorsense 10 ft". */
function senses(c: SheetCtx["sheet"]["core"]): string {
  const s = c.senses;
  return (
    [
      ["Darkvision", s.darkvision],
      ["Blindsight", s.blindsight],
      ["Tremorsense", s.tremorsense],
      ["Truesight", s.truesight],
    ] as const
  )
    .filter(([, ft]) => ft > 0)
    .map(([n, ft]) => `${n} ${ft} ft`)
    .join(" · ");
}

/**
 * The character's name as a heading (the display face; a long name ends in an ellipsis); its player or the DM click
 * it to rename.
 */
function NameField({ ctx }: { ctx: SheetCtx }) {
  const [editing, setEditing] = useState(false);
  const name = ctx.sheet.core.name;
  if (editing)
    return (
      <TextField
        label="Name"
        value={name}
        autoFocus
        onCommit={(v) => {
          if (v.trim() && v.trim() !== name) void ctx.set(["core", "name"], v.trim());
        }}
        onDone={() => setEditing(false)}
        className="display h-9 border-transparent bg-transparent px-1 text-22 leading-tight max-sm:text-18"
      />
    );
  return (
    <div className="flex min-w-0 items-center gap-1">
      {ctx.canEdit ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Rename"
          aria-label={`${name} — rename`}
          className="display min-h-[var(--touch-min)] min-w-0 max-w-full rounded-[var(--radius-control)] px-1 text-left text-22 leading-tight text-paper-ink hover:bg-parchment-deep/50 max-sm:text-18"
        >
          <span className="line-clamp-2 [overflow-wrap:anywhere] [text-wrap:balance]">{name}</span>
        </button>
      ) : (
        <h2 className="display line-clamp-2 px-1 text-22 leading-tight text-paper-ink [overflow-wrap:anywhere] max-sm:text-18">
          {name}
        </h2>
      )}
      <LockMark show={ctx.canEdit && !ctx.free(["core", "name"])} />
    </div>
  );
}

/** Where a sheet's character stands on the board now (its linked token), for the HP and condition commands. */
function useSheetTarget(actorId: string): { tokenId?: string; actorId?: string } {
  const tokenId = useBoard((d) => {
    for (const t of d.tokens.values())
      if (t.actorId === actorId && (!t.dm || t.dm.link === "linked")) return t.id;
    return undefined;
  });
  return tokenId ? { tokenId } : { actorId };
}

const CHIP =
  "inline-flex h-7 items-center gap-1 rounded-chip border border-parchment-edge bg-parchment-deep pl-0.5 text-13 text-paper-ink";

/**
 * What the character is under (§8.11), as its token shows it: conditions, Exhaustion with its level, what it
 * concentrates on, and its markers (the token's, a DM's custom ones in their colour) — each removable where the sheet
 * is editable; Exhaustion and concentration open the picker, where they're set.
 */
function Conditions({ ctx }: { ctx: SheetCtx }) {
  const c = ctx.sheet.core;
  const target = useSheetTarget(ctx.actor.id);
  const token = useBoard((d) => (target.tokenId ? d.tokens.get(target.tokenId) : undefined));
  const customs = new Map(parseCustomMarkers(token?.customMarkers ?? []).map((m) => [m.id, m] as const));
  const markers = (token?.markers ?? []).filter((m) => m !== "concentrating");
  const picker = () => useUi.getState().set({ statusPicker: target });
  // Through the conditions command (§8.11): what follows (concentration ending on Incapacitated) follows.
  const remove = (id: string) =>
    void changeStatus({ ...target, remove: [id] }).catch((e: Error) =>
      toast.danger("Couldn't remove it", e.message),
    );
  const removable = (id: string, name: string) =>
    ctx.canEdit ? (
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={() => remove(id)}
        className="grid h-7 w-6 place-items-center text-paper-muted hover:text-wax pointer-coarse:h-[var(--touch-min)] pointer-coarse:w-[var(--touch-min)]"
      >
        <X size={12} />
      </button>
    ) : (
      <span className="w-1" />
    );
  const opener = `${CHIP} pr-2 ${ctx.canEdit ? "hover:border-paper-ink" : ""}`;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="sheet-conditions">
      <span className="caps text-12 text-paper-muted">Conditions</span>
      {c.conditions.map((id) => (
        <span key={id} title={statusSummary(id)} className={CHIP}>
          <StatusIcon id={id} size={22} badge label="" />
          {statusName(id)}
          {removable(id, statusName(id))}
        </span>
      ))}
      {c.exhaustion > 0 ? (
        <button
          type="button"
          disabled={!ctx.canEdit}
          onClick={picker}
          title={statusSummary("exhaustion")}
          className={opener}
          data-testid="sheet-exhaustion"
        >
          <StatusIcon id="exhaustion" size={22} badge label="" level={c.exhaustion} />
          Exhaustion {c.exhaustion}
        </button>
      ) : null}
      {c.concentration ? (
        <button
          type="button"
          disabled={!ctx.canEdit}
          onClick={picker}
          title={statusSummary("concentrating")}
          className={opener}
        >
          <StatusIcon id="concentrating" size={22} badge label="" />
          Concentrating · {c.concentration}
        </button>
      ) : null}
      {markers.map((id) => {
        const custom = customs.get(id);
        const name = custom?.label || statusName(id);
        return (
          <span
            key={id}
            title={custom ? custom.description || undefined : statusSummary(id)}
            className={CHIP}
          >
            <StatusIcon id={id} size={22} badge label="" glyph={custom?.glyph} color={custom?.color} />
            {name}
            {removable(id, name)}
          </span>
        );
      })}
      {ctx.canEdit ? (
        <button
          type="button"
          aria-label="Add a condition"
          onClick={picker}
          className="inline-flex h-7 min-h-[var(--touch-min)] items-center gap-1 rounded-chip border border-dashed border-paper-muted px-2 text-13 text-paper-muted hover:border-paper-ink hover:text-paper-ink"
        >
          <Plus size={13} aria-hidden />
          add
        </button>
      ) : null}
    </div>
  );
}

/** Heroic Inspiration: a toggle beside the sheet's menu (lit when the character has it). */
function Inspiration({ ctx }: { ctx: SheetCtx }) {
  const on = ctx.sheet.core.inspiration;
  return (
    <button
      type="button"
      disabled={!ctx.canEdit}
      aria-pressed={on}
      aria-label="Heroic Inspiration"
      title={on ? "Heroic Inspiration — has it" : "Heroic Inspiration"}
      onClick={() => void ctx.set(["core", "inspiration"], !on)}
      className={`grid h-9 min-h-[var(--touch-min)] w-9 min-w-[var(--touch-min)] shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-parchment-deep/60 ${
        on ? "text-wax" : "text-paper-muted opacity-70"
      }`}
    >
      <StatusIcon id="inspiration" size={20} label="" />
    </button>
  );
}

/** The player's changes waiting on the DM for this sheet. */
function PendingProposals({ actorId }: { actorId: string }) {
  const me = useTable((s) => s.me?.userId);
  const n = useSheets(
    (s) =>
      [...s.proposals.values()].filter(
        (p) => p.actorId === actorId && p.status === "pending" && p.userId === me,
      ).length,
  );
  if (!n) return null;
  return (
    <span
      className="min-w-0 truncate whitespace-nowrap text-12 text-paper-muted"
      data-testid="sheet-pending"
      title={`${n} change${n === 1 ? "" : "s"} waiting for the DM`}
    >
      <span aria-hidden>· </span>
      {n} change{n === 1 ? "" : "s"} waiting for the DM
    </span>
  );
}
