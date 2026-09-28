import { RECHARGES } from "@gloam/shared/schemas";
import { useState } from "react";
import type { SheetCtx } from "../context.ts";
import { NumberField, Pips, SectionTitle, TextField } from "../primitives.tsx";
import { RemoveButton } from "./OverviewTab.tsx";

const RECHARGE_LABEL: Record<(typeof RECHARGES)[number], string> = {
  short: "short rest",
  long: "long rest",
  dawn: "at dawn",
  none: "doesn't recharge",
};

/** Features and traits (§8.10): each with its text and, if it has them, uses — spent as pips — and when they return. */
export function FeaturesTab({ ctx }: { ctx: SheetCtx }) {
  const features = ctx.sheet.core.features;
  const ro = !ctx.canEdit;
  const [name, setName] = useState("");
  const add = () => {
    if (!name.trim()) return;
    void ctx.set(["core", "features"], [...features, { name: name.trim(), text: "" }]);
    setName("");
  };
  return (
    <div className="flex flex-col gap-2 text-14 text-paper-ink">
      <SectionTitle>Features and traits</SectionTitle>
      {features.length === 0 ? <p className="text-13 italic text-paper-muted">None yet.</p> : null}
      {features.map((f, i) => (
        <section
          key={i}
          className="rounded-[var(--radius-control)] border border-parchment-edge/60 p-2"
          data-testid="sheet-feature"
        >
          <div className="flex items-center gap-1.5">
            <TextField
              label={`Feature ${i + 1}`}
              value={f.name}
              disabled={ro}
              onCommit={(v) => v.trim() && void ctx.set(["core", "features", i, "name"], v.trim())}
              className="font-bold"
            />
            {ro ? null : (
              <RemoveButton
                label={`Remove ${f.name}`}
                onClick={() =>
                  void ctx.set(
                    ["core", "features"],
                    features.filter((_, j) => j !== i),
                  )
                }
              />
            )}
          </div>
          {f.uses ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Pips
                label={`${f.name} uses spent`}
                total={f.uses.max}
                filled={f.uses.used}
                disabled={ro}
                onSet={(n) => void ctx.set(["core", "features", i, "uses", "used"], n)}
              />
              <span className="text-13 text-paper-muted">of</span>
              <NumberField
                label={`${f.name} uses`}
                value={f.uses.max}
                min={0}
                max={99}
                width="2.5rem"
                disabled={ro}
                onCommit={(v) => void ctx.set(["core", "features", i, "uses", "max"], v)}
              />
              <select
                aria-label={`${f.name} recharge`}
                value={f.uses.recharge}
                disabled={ro}
                onChange={(e) => void ctx.set(["core", "features", i, "uses", "recharge"], e.target.value)}
                className="h-7 min-h-[var(--touch-min)] rounded-chip border border-parchment-edge bg-transparent px-1 text-13 text-paper-ink"
              >
                {RECHARGES.map((r) => (
                  <option key={r} value={r}>
                    {RECHARGE_LABEL[r]}
                  </option>
                ))}
              </select>
              {ro ? null : (
                <button
                  type="button"
                  onClick={() => void ctx.set(["core", "features", i, "uses"], undefined)}
                  className="min-h-[var(--touch-min)] min-w-[var(--touch-min)] text-13 text-paper-muted underline decoration-dotted hover:text-wax"
                >
                  Remove uses
                </button>
              )}
            </div>
          ) : ro ? null : (
            <button
              type="button"
              onClick={() =>
                void ctx.set(["core", "features", i, "uses"], { max: 1, used: 0, recharge: "long" })
              }
              className="min-h-[var(--touch-min)] mt-1 text-13 text-paper-muted underline decoration-dotted hover:text-wax"
            >
              Has uses…
            </button>
          )}
          <div className="mt-1.5">
            <TextField
              label={`${f.name} text`}
              value={f.text}
              multiline
              placeholder="What it does"
              disabled={ro}
              onCommit={(v) => void ctx.set(["core", "features", i, "text"], v)}
            />
          </div>
        </section>
      ))}
      {ro ? null : (
        <div className="flex items-center gap-1.5">
          <input
            aria-label="New feature"
            value={name}
            placeholder="Add a feature — Second Wind…"
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
    </div>
  );
}
