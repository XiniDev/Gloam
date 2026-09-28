import { CONDITION_IDS } from "@gloam/shared";
import type { ActorView } from "@gloam/shared/protocol";
import { FileDown, FileUp, Lock, Plus, Sparkles, Trash2, Unlock, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useSheets } from "../../net/sheets.ts";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
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
        <h2 className="caps text-13 text-bone">Sheet</h2>
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

function SheetPage({ actor, onImport }: { actor: ActorView; onImport: (m: "json" | "ai") => void }) {
  const ctx = useSheetCtx(actor);
  const tab = useUi((s) => s.sheetTab);
  return (
    <article
      className="parchment m-2 flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="sheet"
      data-actor={actor.id}
      aria-label={`${actor.sheet.core.name}'s sheet`}
    >
      <SheetHeader ctx={ctx} onImport={onImport} />
      <div
        aria-label="Sheet sections"
        role="tablist"
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-parchment-edge px-2"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => useUi.getState().set({ sheetTab: t.id })}
            className={`caps h-9 min-h-[var(--touch-min)] shrink-0 px-2.5 text-12 transition-[color,box-shadow] duration-[var(--dur-fast)] ${
              tab === t.id
                ? "text-paper-ink shadow-[inset_0_-2px_0_var(--wax-500)]"
                : "text-paper-muted shadow-[inset_0_-2px_0_transparent] hover:text-paper-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-4"
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
  const dmg = (heal: boolean) => {
    const n = Math.max(0, Math.floor(Number(amount)));
    if (!n) return;
    setAmount("");
    // P6's arithmetic (P7 brings the damage pipeline): temporary HP take damage first; healing stops at the maximum.
    if (heal) void ctx.set(["core", "hp", "current"], Math.min(c.hp.max, Math.max(0, c.hp.current) + n));
    else {
      const fromTemp = Math.min(c.hp.temp, n);
      void ctx.edit([
        { path: ["core", "hp", "temp"], after: c.hp.temp - fromTemp },
        { path: ["core", "hp", "current"], after: Math.max(0, c.hp.current - (n - fromTemp)) },
      ]);
    }
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
          <div className="flex items-center gap-1">
            {ctx.canEdit ? (
              <TextField
                label="Name"
                value={c.name}
                onCommit={(v) => v.trim() && void ctx.set(["core", "name"], v.trim())}
                className="display h-9 border-transparent bg-transparent px-1 text-22 leading-tight"
              />
            ) : (
              <h2 className="display truncate text-22 leading-tight text-paper-ink">{c.name}</h2>
            )}
            <LockMark show={ctx.canEdit && !ctx.free(["core", "name"])} />
          </div>
          <p className="truncate px-1 text-13 text-paper-muted" data-testid="sheet-subtitle">
            {subtitle(ctx) || "—"}
          </p>
        </div>
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
      {/* The lock (§8.10 Ownership and locks): the DM sets it; a player sees it. */}
      <div className="mt-2 flex items-center gap-2">
        {ctx.dm ? (
          <Segmented
            label="Sheet lock"
            size="S"
            value={ctx.actor.lockLevel}
            onChange={(level) => void request("actor.setLock", { actorId: ctx.actor.id, level })}
            options={[
              { value: "unlocked", label: "Unlocked" },
              { value: "core", label: "Core locked", hint: "Players change play-state only" },
              { value: "full", label: "Fully locked", hint: "Read-only for players" },
            ]}
          />
        ) : ctx.actor.lockLevel !== "unlocked" ? (
          <span
            className="caps inline-flex items-center gap-1 text-12 text-paper-muted"
            data-testid="sheet-lock"
          >
            <Lock size={12} aria-hidden />
            {lockLabel}
          </span>
        ) : (
          <span
            className="caps inline-flex items-center gap-1 text-12 text-paper-muted"
            data-testid="sheet-lock"
          >
            <Unlock size={12} aria-hidden />
            {lockLabel}
          </span>
        )}
        <PendingProposals actorId={ctx.actor.id} />
      </div>
      {/* Vitals (§29.7). */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5" data-testid="sheet-vitals">
        <div className="flex items-center gap-1">
          <span className="caps text-12 text-paper-muted">HP</span>
          <Stepper
            label="Current HP"
            value={c.hp.current}
            min={-c.hp.max}
            max={c.hp.max}
            disabled={!ctx.canEdit}
            onChange={(v) => void ctx.set(["core", "hp", "current"], v)}
          />
          <span className="text-paper-muted">/</span>
          <NumberField
            label="Max HP"
            value={c.hp.max}
            min={0}
            disabled={!ctx.canEdit}
            onCommit={(v) => void ctx.set(["core", "hp", "max"], v)}
          />
          <span className="caps ml-1 text-12 text-paper-muted">temp</span>
          <NumberField
            label="Temporary HP"
            value={c.hp.temp}
            min={0}
            disabled={!ctx.canEdit}
            onCommit={(v) => void ctx.set(["core", "hp", "temp"], v)}
          />
        </div>
        {ctx.canEdit ? (
          <div className="flex items-center gap-1">
            <input
              aria-label="Damage or healing amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              placeholder="0"
              className="tabular h-8 w-12 rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-1 text-center text-14 text-paper-ink focus:border-wax focus:outline-none"
            />
            <button
              type="button"
              onClick={() => dmg(false)}
              className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-wax px-2 text-13 font-bold text-wax hover:bg-wax hover:text-parchment"
            >
              Damage
            </button>
            <button
              type="button"
              onClick={() => dmg(true)}
              className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-paper-ink/40 px-2 text-13 font-bold text-paper-ink hover:bg-parchment-deep"
            >
              Heal
            </button>
          </div>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-14">
        <Stat label="AC">
          <NumberField
            label="Armour class"
            value={c.ac.value}
            min={0}
            max={99}
            disabled={!ctx.canEdit}
            onCommit={(v) => void ctx.set(["core", "ac", "value"], v)}
          />
        </Stat>
        <Stat label="Init">
          <Rollable actor={ctx.actor} formula="1d20 + @init" label="Initiative" className="tabular font-bold">
            {signed(d.initiative)}
          </Rollable>
        </Stat>
        <Stat label="Speed">
          <span className="tabular font-bold">{c.speeds.walk} ft</span>
        </Stat>
        {c.senses.darkvision ? (
          <Stat label="Darkvision">
            <span className="tabular font-bold">{c.senses.darkvision} ft</span>
          </Stat>
        ) : null}
        <Stat label="Prof">
          <span className="tabular font-bold">{signed(d.proficiencyBonus)}</span>
        </Stat>
      </div>
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
            className="h-10 rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-2 text-16 text-paper-ink focus:border-wax focus:outline-none"
          />
        </label>
      </Dialog>
    </header>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="caps text-12 text-paper-muted">{label}</span>
      {children}
    </span>
  );
}

const conditionName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

function Conditions({ ctx }: { ctx: SheetCtx }) {
  const c = ctx.sheet.core;
  const setConditions = (next: string[]) => void ctx.set(["core", "conditions"], next);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="sheet-conditions">
      <span className="caps text-12 text-paper-muted">Conditions</span>
      {c.conditions.map((id) => (
        <span
          key={id}
          className="inline-flex h-7 items-center gap-1 rounded-chip border border-wax/60 bg-parchment-deep px-2 text-13 text-paper-ink"
        >
          {conditionName(id)}
          {ctx.canEdit ? (
            <button
              type="button"
              aria-label={`Remove ${conditionName(id)}`}
              onClick={() => setConditions(c.conditions.filter((x) => x !== id))}
              className="text-paper-muted hover:text-wax"
            >
              <X size={12} />
            </button>
          ) : null}
        </span>
      ))}
      {ctx.canEdit ? (
        <select
          aria-label="Add a condition"
          value=""
          onChange={(e) => e.target.value && setConditions([...c.conditions, e.target.value])}
          className="h-7 min-h-[var(--touch-min)] rounded-chip border border-dashed border-paper-muted bg-transparent px-1 text-13 text-paper-muted"
        >
          <option value="">+ add</option>
          {CONDITION_IDS.filter((id) => !c.conditions.includes(id)).map((id) => (
            <option key={id} value={id}>
              {conditionName(id)}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        disabled={!ctx.canEdit}
        aria-pressed={c.inspiration}
        onClick={() => void ctx.set(["core", "inspiration"], !c.inspiration)}
        className="ml-auto inline-flex h-7 min-h-[var(--touch-min)] items-center gap-1 px-1 text-13 text-paper-ink"
        title="Heroic Inspiration"
      >
        <span
          aria-hidden
          className={`block h-3 w-3 rotate-45 border ${c.inspiration ? "border-wax bg-wax" : "border-paper-muted"}`}
        />
        Inspiration
      </button>
    </div>
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
    <span className="caps ml-auto text-12 text-wax" data-testid="sheet-pending">
      {n} change{n === 1 ? "" : "s"} waiting for the DM
    </span>
  );
}
