import { LIGHT_PRESETS } from "@gloam/shared";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { overrideDerived, type SheetCtx } from "../context.ts";
import { DerivedValue, NumberField, SectionTitle, Stepper, TextField } from "../primitives.tsx";
import { RemoveButton } from "./OverviewTab.tsx";

type Item = SheetCtx["sheet"]["core"]["inventory"][number];

/**
 * Inventory (§8.10): one line per item — equipped, name, quantity, weight — its details (attuned, the light it is,
 * notes) a click away; coins; the load carried against the carrying capacity. Quantities and coins are play-state
 * (changeable under a Core lock).
 */
export function InventoryTab({ ctx }: { ctx: SheetCtx }) {
  const c = ctx.sheet.core;
  const ro = !ctx.canEdit;
  const [name, setName] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const load = ctx.derived.load;
  const cap = ctx.derived.values["carry.capacity"];
  const add = () => {
    if (!name.trim()) return;
    void ctx.set(["core", "inventory"], [...c.inventory, { name: name.trim(), qty: 1, weight: 0 }]);
    setName("");
  };
  return (
    <div className="flex flex-col text-14 text-paper-ink">
      <SectionTitle>Items</SectionTitle>
      <p className="group/row flex items-center gap-1 text-13 text-paper-muted">
        <span>
          Carrying <span className="tabular font-bold text-paper-ink">{load}</span> /{" "}
        </span>
        <DerivedValue
          value={cap}
          auto={ctx.derived.auto["carry.capacity"]}
          overridden={ctx.derived.overridden.has("carry.capacity")}
          onOverride={(v) => overrideDerived(ctx, "carry.capacity", v)}
          onRevert={() => overrideDerived(ctx, "carry.capacity", undefined)}
          label="Carrying capacity"
          disabled={ro}
        >
          <span className="tabular font-bold text-paper-ink">{cap} lb</span>
        </DerivedValue>
      </p>
      <div className="mb-1.5 mt-1 h-1.5 overflow-hidden rounded-full bg-parchment-edge/40" aria-hidden>
        <div
          className={`h-full ${load > cap ? "bg-wax" : "bg-paper-ink/60"}`}
          style={{ width: `${Math.min(100, (load / Math.max(1, cap)) * 100)}%` }}
        />
      </div>
      <ul className="@container flex flex-col" data-testid="sheet-inventory">
        {c.inventory.map((it, i) => (
          <ItemRow
            key={i}
            ctx={ctx}
            it={it}
            i={i}
            open={open === i}
            onToggle={() => setOpen(open === i ? null : i)}
          />
        ))}
      </ul>
      {ro ? null : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            aria-label="New item"
            value={name}
            placeholder="Add an item — Rope, Torch…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            className="h-8 min-h-[var(--touch-min)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-parchment-edge/60 bg-parchment/60 px-2 text-14 text-paper-ink placeholder:text-paper-muted/70 focus:border-brass-deep focus:shadow-[var(--ring-focus)] focus:outline-none"
          />
          <button
            type="button"
            onClick={add}
            className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-paper-ink/40 px-3 text-13 font-bold text-paper-ink hover:bg-parchment-deep"
          >
            Add
          </button>
        </div>
      )}

      <SectionTitle>Coins</SectionTitle>
      <div className="grid grid-cols-5 gap-1" data-testid="sheet-coins">
        {(["cp", "sp", "ep", "gp", "pp"] as const).map((k) => (
          <span key={k} className="flex flex-col items-center">
            <span className="caps text-12 text-paper-muted">{k}</span>
            <NumberField
              label={`${k.toUpperCase()} coins`}
              value={c.currency[k]}
              min={0}
              max={99_999_999}
              width="100%"
              disabled={ro}
              onCommit={(v) => void ctx.set(["core", "currency", k], v)}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

function ItemRow({
  ctx,
  it,
  i,
  open,
  onToggle,
}: {
  ctx: SheetCtx;
  it: Item;
  i: number;
  open: boolean;
  onToggle: () => void;
}) {
  const ro = !ctx.canEdit;
  const set = (key: string, v: unknown) => void ctx.set(["core", "inventory", i, key], v);
  return (
    <li className="border-b border-parchment-edge/30 py-0.5" data-testid="inventory-item">
      {/* One line when the panel is wide enough; on a narrow one (a phone) the quantity and weight drop to a second
          line under the name, so the name keeps its room. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 @min-[420px]:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]">
        <label
          className="grid h-8 min-h-[var(--touch-min)] w-6 min-w-[var(--touch-min)] place-items-center"
          title="Equipped"
        >
          <input
            type="checkbox"
            aria-label={`${it.name} equipped`}
            checked={it.equipped}
            disabled={ro}
            onChange={(e) => set("equipped", e.target.checked)}
            className="h-4 w-4 accent-[var(--wax-500)]"
          />
        </label>
        <TextField
          label={`Item ${i + 1}`}
          value={it.name}
          disabled={ro}
          onCommit={(v) => v.trim() && set("name", v.trim())}
        />
        <div className="order-1 col-span-2 col-start-2 flex items-center gap-3 @min-[420px]:contents">
          <Stepper
            label={`${it.name} quantity`}
            value={it.qty}
            min={0}
            max={99_999}
            disabled={ro}
            onChange={(v) => set("qty", v)}
          />
          <span className="flex items-center text-13 text-paper-muted">
            <NumberField
              label={`${it.name} weight`}
              value={it.weight}
              min={0}
              max={10_000}
              width="2.5rem"
              disabled={ro}
              onCommit={(v) => set("weight", v)}
            />
            lb
          </span>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${it.name}: details`}
          onClick={onToggle}
          className="grid h-8 min-h-[var(--touch-min)] w-7 min-w-[var(--touch-min)] place-items-center text-paper-muted hover:text-paper-ink"
        >
          <ChevronDown
            size={15}
            aria-hidden
            className={`transition-transform duration-[var(--dur-fast)] ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {open ? (
        <div className="flex flex-col gap-1 pb-1.5 pl-7">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-13">
            <label className="inline-flex min-h-[var(--touch-min)] items-center gap-1.5">
              <input
                type="checkbox"
                checked={it.attuned}
                disabled={ro}
                onChange={(e) => set("attuned", e.target.checked)}
                className="h-4 w-4 accent-[var(--wax-500)]"
              />
              Attuned
            </label>
            <label className="inline-flex items-center gap-1.5">
              <span className="text-paper-muted">Is a light</span>
              <select
                aria-label={`${it.name} light`}
                value={it.light ?? ""}
                disabled={ro}
                onChange={(e) => set("light", e.target.value || undefined)}
                className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-1 text-13 text-paper-ink"
              >
                <option value="">No</option>
                {LIGHT_PRESETS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            {ro ? null : (
              <span className="ml-auto">
                <RemoveButton
                  label={`Remove ${it.name}`}
                  onClick={() =>
                    void ctx.set(
                      ["core", "inventory"],
                      ctx.sheet.core.inventory.filter((_, j) => j !== i),
                    )
                  }
                />
              </span>
            )}
          </div>
          <TextField
            label={`${it.name} notes`}
            value={it.notes ?? ""}
            placeholder="Notes"
            disabled={ro}
            onCommit={(v) => set("notes", v.trim() || undefined)}
            className="text-13"
          />
        </div>
      ) : null}
    </li>
  );
}
