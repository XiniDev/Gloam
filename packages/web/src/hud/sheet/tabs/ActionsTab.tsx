import { formulaText, summarizeFormula } from "@gloam/shared/dice";
import { sheetRefs } from "@gloam/shared/rules";
import { useMemo, useState } from "react";
import type { SheetCtx } from "../context.ts";
import { RollButton, SectionTitle, TextField } from "../primitives.tsx";
import { AddButton, RemoveButton } from "./OverviewTab.tsx";

/**
 * Actions (§8.10): the character's attacks — an attack roll and a damage roll each, shown with the sheet's numbers in
 * ("Attack +6", "1d8 + 3 bludgeoning"); their formulas, in the §18.1 grammar with `@` references to the sheet
 * ("1d20 + @str + @prof", "1d8 + @str [slashing]"), behind Edit.
 */
export function ActionsTab({ ctx }: { ctx: SheetCtx }) {
  const attacks = ctx.sheet.core.attacks;
  const ro = !ctx.canEdit;
  const [editing, setEditing] = useState<number | null>(null);
  const resolve = useMemo(() => sheetRefs(ctx.sheet.core), [ctx.sheet.core]);
  const shown = (formula: string, toHit: boolean) =>
    formulaText(summarizeFormula(formula, resolve), { toHit }) ?? formula;
  const set = (i: number, key: "name" | "attack" | "damage" | "range" | "properties", v: string) =>
    void ctx.set(
      ["core", "attacks", i, key],
      key === "name" ? v.trim() || attacks[i]?.name : v.trim() || undefined,
    );
  return (
    <div className="flex flex-col gap-2 text-14 text-paper-ink">
      <SectionTitle
        action={
          ro ? null : (
            <AddButton
              label="Add an attack"
              onClick={() =>
                void ctx.set(
                  ["core", "attacks"],
                  [...attacks, { name: "New attack", attack: "1d20 + @str + @prof", damage: "1d6 + @str" }],
                )
              }
            />
          )
        }
      >
        Attacks
      </SectionTitle>
      {attacks.length === 0 ? (
        <p className="text-13 italic text-paper-muted">No attacks yet{ro ? "." : " — add one with +."}</p>
      ) : null}
      {attacks.map((a, i) => (
        <section
          key={i}
          className="rounded-[var(--radius-control)] border border-parchment-edge/60 p-2"
          data-testid="sheet-attack"
        >
          <div className="flex items-center gap-1.5">
            <TextField
              label={`Attack ${i + 1} name`}
              value={a.name}
              disabled={ro}
              onCommit={(v) => set(i, "name", v)}
              className="font-bold"
            />
            {ro ? null : (
              <RemoveButton
                label={`Remove ${a.name}`}
                onClick={() =>
                  void ctx.set(
                    ["core", "attacks"],
                    attacks.filter((_, j) => j !== i),
                  )
                }
              />
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {a.attack ? (
              <RollButton
                actor={ctx.actor}
                formula={a.attack}
                label={`${a.name} — attack`}
                test={{ kind: "attack" }}
                text={<span className="tabular">Attack {shown(a.attack, true)}</span>}
              />
            ) : null}
            {a.damage ? (
              <RollButton
                actor={ctx.actor}
                formula={a.damage}
                label={`${a.name} — damage`}
                test={null}
                text={<span className="tabular">{shown(a.damage, false)}</span>}
              />
            ) : null}
            {a.range ? <span className="text-13 text-paper-muted">{a.range}</span> : null}
            {a.properties ? <span className="text-13 italic text-paper-muted">{a.properties}</span> : null}
            {ro ? null : (
              <button
                type="button"
                aria-expanded={editing === i}
                onClick={() => setEditing(editing === i ? null : i)}
                className="ml-auto min-h-[var(--touch-min)] min-w-[var(--touch-min)] px-1 text-13 text-paper-muted underline decoration-dotted hover:text-paper-ink"
              >
                {editing === i ? "Done" : "Edit"}
              </button>
            )}
          </div>
          {ro || editing !== i ? null : (
            <div className="mt-1.5 grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1">
              <span className="text-13 text-paper-muted">To hit</span>
              <TextField
                label={`${a.name} attack formula`}
                value={a.attack ?? ""}
                placeholder="e.g. 1d20 + @str + @prof"
                onCommit={(v) => set(i, "attack", v)}
                className="mono text-13"
              />
              <span className="text-13 text-paper-muted">Damage</span>
              <TextField
                label={`${a.name} damage formula`}
                value={a.damage ?? ""}
                placeholder="e.g. 1d8 + @str [slashing]"
                onCommit={(v) => set(i, "damage", v)}
                className="mono text-13"
              />
              <span className="text-13 text-paper-muted">Range</span>
              <TextField
                label={`${a.name} range`}
                value={a.range ?? ""}
                placeholder="e.g. 5 ft"
                onCommit={(v) => set(i, "range", v)}
              />
              <span className="text-13 text-paper-muted">Properties</span>
              <TextField
                label={`${a.name} properties`}
                value={a.properties ?? ""}
                placeholder="e.g. versatile, finesse"
                onCommit={(v) => set(i, "properties", v)}
              />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
