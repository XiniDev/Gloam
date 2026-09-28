import { LIGHT_PRESETS } from "@gloam/shared";
import { useState } from "react";
import { overrideDerived, type SheetCtx } from "../context.ts";
import { DerivedValue, NumberField, SectionTitle, Stepper, TextField } from "../primitives.tsx";
import { RemoveButton } from "./OverviewTab.tsx";

/**
 * Inventory (§8.10): items with quantity, weight, equipped and attuned, notes and the light an item can be; coins;
 * the load carried against the carrying capacity. Quantities and coins are play-state (changeable under a core lock).
 */
export function InventoryTab({ ctx }: { ctx: SheetCtx }) {
  const c = ctx.sheet.core;
  const ro = !ctx.canEdit;
  const [name, setName] = useState("");
  const load = ctx.derived.load;
  const cap = ctx.derived.values["carry.capacity"];
  const add = () => {
    if (!name.trim()) return;
    void ctx.set(["core", "inventory"], [...c.inventory, { name: name.trim(), qty: 1, weight: 0 }]);
    setName("");
  };
  return (
    <div className="flex flex-col text-14 text-paper-ink">
      <SectionTitle>
        <span className="group/row inline-flex items-center gap-1">
          Carrying {load} of
          <DerivedValue
            value={cap}
            auto={ctx.derived.auto["carry.capacity"]}
            overridden={ctx.derived.overridden.has("carry.capacity")}
            onOverride={(v) => overrideDerived(ctx, "carry.capacity", v)}
            onRevert={() => overrideDerived(ctx, "carry.capacity", undefined)}
            label="Carrying capacity"
            disabled={ro}
          />
          lb
        </span>
      </SectionTitle>
      <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-parchment-edge/40" aria-hidden>
        <div
          className={`h-full ${load > cap ? "bg-wax" : "bg-paper-ink/60"}`}
          style={{ width: `${Math.min(100, (load / Math.max(1, cap)) * 100)}%` }}
        />
      </div>
      <ul className="flex flex-col" data-testid="sheet-inventory">
        {c.inventory.map((it, i) => (
          <li key={i} className="flex flex-col gap-0.5 border-b border-parchment-edge/30 py-1">
            <div className="flex items-center gap-1">
              <TextField
                label={`Item ${i + 1}`}
                value={it.name}
                disabled={ro}
                onCommit={(v) => v.trim() && void ctx.set(["core", "inventory", i, "name"], v.trim())}
              />
              <Stepper
                label={`${it.name} quantity`}
                value={it.qty}
                min={0}
                max={99_999}
                disabled={ro}
                onChange={(v) => void ctx.set(["core", "inventory", i, "qty"], v)}
              />
              {ro ? null : (
                <RemoveButton
                  label={`Remove ${it.name}`}
                  onClick={() =>
                    void ctx.set(
                      ["core", "inventory"],
                      c.inventory.filter((_, j) => j !== i),
                    )
                  }
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-1 text-13">
              <span className="flex items-center gap-1">
                <span className="text-paper-muted">lb each</span>
                <NumberField
                  label={`${it.name} weight`}
                  value={it.weight}
                  min={0}
                  max={10_000}
                  width="3rem"
                  disabled={ro}
                  onCommit={(v) => void ctx.set(["core", "inventory", i, "weight"], v)}
                />
              </span>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={it.equipped}
                  disabled={ro}
                  onChange={(e) => void ctx.set(["core", "inventory", i, "equipped"], e.target.checked)}
                  className="accent-[var(--wax-500)]"
                />
                equipped
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={it.attuned}
                  disabled={ro}
                  onChange={(e) => void ctx.set(["core", "inventory", i, "attuned"], e.target.checked)}
                  className="accent-[var(--wax-500)]"
                />
                attuned
              </label>
              <label className="flex items-center gap-1">
                <span className="text-paper-muted">light</span>
                <select
                  aria-label={`${it.name} light`}
                  value={it.light ?? ""}
                  disabled={ro}
                  onChange={(e) =>
                    void ctx.set(["core", "inventory", i, "light"], e.target.value || undefined)
                  }
                  className="h-7 rounded-chip border border-parchment-edge bg-transparent px-1 text-13 text-paper-ink"
                >
                  <option value="">—</option>
                  {LIGHT_PRESETS.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {it.notes || !ro ? (
              <TextField
                label={`${it.name} notes`}
                value={it.notes ?? ""}
                placeholder="notes"
                disabled={ro}
                onCommit={(v) => void ctx.set(["core", "inventory", i, "notes"], v.trim() || undefined)}
                className="text-13"
              />
            ) : null}
          </li>
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
            className="h-8 min-h-[var(--touch-min)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-parchment-edge/60 bg-parchment/60 px-2 text-14 text-paper-ink placeholder:text-paper-muted/70 focus:border-wax focus:outline-none"
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
