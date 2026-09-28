import { ABILITIES } from "@gloam/shared";
import type { DerivedKey } from "@gloam/shared/schemas";
import { useState } from "react";
import { toast } from "../../../ui/Toast.tsx";
import { overrideDerived, type SheetCtx } from "../context.ts";
import { DerivedValue, NumberField, Pips, RollButton, SectionTitle } from "../primitives.tsx";
import { type AbilityKey, abilityName, signed } from "../sheetActions.ts";
import { AddButton, RemoveButton } from "./OverviewTab.tsx";

const LEVEL = ["Cantrips", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];

/**
 * Spells (§8.10): the casting ability with its save DC and attack bonus (derived, overridable), slot pips per level
 * and pact slots, spells by level with prepare toggles and Cast (spends a slot of the spell's level; its effects
 * arrive with spells, P9) and a spell-attack roll.
 */
export function SpellsTab({ ctx }: { ctx: SheetCtx }) {
  const sc = ctx.sheet.core.spellcasting;
  const ro = !ctx.canEdit;
  const [newSpell, setNewSpell] = useState({ name: "", level: 1 });
  if (!sc)
    return (
      <div className="flex flex-col items-start gap-2 text-14 text-paper-ink">
        <p className="italic text-paper-muted">This character doesn't cast spells.</p>
        {ro ? null : (
          <label className="flex items-center gap-2">
            <span className="text-13 text-paper-muted">Casts with</span>
            <select
              aria-label="Spellcasting ability"
              value=""
              onChange={(e) =>
                e.target.value &&
                void ctx.set(["core", "spellcasting"], { ability: e.target.value, slots: [], spells: [] })
              }
              className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-2 text-14 text-paper-ink"
            >
              <option value="">choose an ability…</option>
              {ABILITIES.map((a) => (
                <option key={a} value={a}>
                  {abilityName(a as AbilityKey)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    );
  const d = ctx.derived;
  const override = (key: DerivedKey, v: number | undefined) => overrideDerived(ctx, key, v);
  const cast = (level: number, name: string) => {
    if (level === 0) return;
    const i = sc.slots.findIndex((s) => s.level === level && s.used < s.max);
    if (i < 0) {
      toast.warning(
        `No ${LEVEL[level]}-level slots left`,
        `${name} needs one — take a rest or cast it with a higher slot.`,
      );
      return;
    }
    void ctx.set(["core", "spellcasting", "slots", i, "used"], (sc.slots[i]?.used ?? 0) + 1);
  };
  const byLevel = new Map<number, { spell: (typeof sc.spells)[number]; i: number }[]>();
  for (const [i, spell] of sc.spells.entries())
    byLevel.set(spell.level, [...(byLevel.get(spell.level) ?? []), { spell, i }]);
  const slotFor = (level: number) => sc.slots.findIndex((s) => s.level === level);
  const addSpell = () => {
    if (!newSpell.name.trim()) return;
    void ctx.set(
      ["core", "spellcasting", "spells"],
      [...sc.spells, { name: newSpell.name.trim(), level: newSpell.level, prepared: false }],
    );
    setNewSpell({ name: "", level: newSpell.level });
  };
  return (
    <div className="flex flex-col text-14 text-paper-ink">
      <SectionTitle>Spellcasting</SectionTitle>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex items-center gap-1">
          <span className="text-13 text-paper-muted">Ability</span>
          <select
            aria-label="Spellcasting ability"
            value={sc.ability}
            disabled={ro}
            onChange={(e) => void ctx.set(["core", "spellcasting", "ability"], e.target.value)}
            className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-2 text-14 text-paper-ink"
          >
            {ABILITIES.map((a) => (
              <option key={a} value={a}>
                {abilityName(a as AbilityKey)}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ["spell.dc", "Save DC", false],
            ["spell.attack", "Attack", true],
          ] as const
        ).map(([key, label, sign]) => (
          <span key={key} className="group/row inline-flex items-center gap-1">
            <span className="text-13 text-paper-muted">{label}</span>
            <DerivedValue
              value={d.values[key]}
              auto={d.auto[key]}
              overridden={d.overridden.has(key)}
              onOverride={(v) => override(key, v)}
              onRevert={() => override(key, undefined)}
              label={`Spell ${label.toLowerCase()}`}
              disabled={ro}
            >
              <span className="tabular font-bold">{sign ? signed(d.values[key]) : d.values[key]}</span>
            </DerivedValue>
          </span>
        ))}
        <RollButton
          actor={ctx.actor}
          formula="1d20 + @spellmod + @prof"
          label="Spell attack"
          text={`Spell attack ${signed(d.values["spell.attack"])}`}
        />
      </div>

      {[...byLevel.keys()]
        .sort((a, b) => a - b)
        .map((level) => (
          <div key={level}>
            <SectionTitle>{level === 0 ? "Cantrips" : `${LEVEL[level]} level`}</SectionTitle>
            <ul className="flex flex-col">
              {(byLevel.get(level) ?? []).map(({ spell, i }) => (
                <li
                  key={i}
                  className="flex items-center gap-1.5 border-b border-parchment-edge/30 py-0.5"
                  data-testid="sheet-spell"
                >
                  {level > 0 ? (
                    <button
                      type="button"
                      disabled={ro}
                      aria-pressed={spell.prepared}
                      aria-label={`${spell.name} prepared`}
                      title={spell.prepared ? "Prepared" : "Not prepared"}
                      onClick={() =>
                        void ctx.set(["core", "spellcasting", "spells", i, "prepared"], !spell.prepared)
                      }
                      className="grid h-6 min-h-[var(--touch-min)] w-5 min-w-[var(--touch-min)] place-items-center"
                    >
                      <span
                        aria-hidden
                        className={`block h-2.5 w-2.5 rotate-45 border ${spell.prepared ? "border-wax bg-wax" : "border-paper-muted"}`}
                      />
                    </button>
                  ) : (
                    <span className="w-5" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{spell.name}</span>
                  {level > 0 && !ro ? (
                    <button
                      type="button"
                      onClick={() => cast(level, spell.name)}
                      className="caps h-7 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-wax/70 px-2 text-12 text-wax hover:bg-wax hover:text-parchment"
                    >
                      Cast
                    </button>
                  ) : null}
                  {ro ? null : (
                    <RemoveButton
                      label={`Remove ${spell.name}`}
                      onClick={() =>
                        void ctx.set(
                          ["core", "spellcasting", "spells"],
                          sc.spells.filter((_, j) => j !== i),
                        )
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}

      <SectionTitle>Slots</SectionTitle>
      <div className="flex flex-col gap-1" data-testid="spell-slots">
        {sc.slots.length === 0 && !sc.pact ? (
          <p className="text-13 italic text-paper-muted">No spell slots.</p>
        ) : null}
        {sc.slots.map((slot, i) => (
          <div key={slot.level} className="flex items-center gap-2">
            <span className="w-10 text-13 text-paper-muted">{LEVEL[slot.level]}</span>
            <Pips
              label={`${LEVEL[slot.level]}-level slots spent`}
              total={slot.max}
              filled={slot.used}
              disabled={ro}
              onSet={(n) => void ctx.set(["core", "spellcasting", "slots", i, "used"], n)}
            />
            <span className="text-13 text-paper-muted">{slot.max - slot.used} of</span>
            {ro ? (
              <span className="tabular text-13 font-bold">{slot.max}</span>
            ) : (
              <NumberField
                label={`${LEVEL[slot.level]}-level slots`}
                value={slot.max}
                min={0}
                max={9}
                width="2.5rem"
                onCommit={(v) => {
                  const slots = sc.slots.filter((x) => x.level !== slot.level);
                  if (v > 0) slots.push({ level: slot.level, max: v, used: Math.min(slot.used, v) });
                  slots.sort((x, y) => x.level - y.level);
                  void ctx.set(["core", "spellcasting", "slots"], slots);
                }}
              />
            )}
            <span className="text-13 text-paper-muted">left</span>
          </div>
        ))}
        {sc.pact ? (
          <div className="flex items-center gap-2">
            <span className="w-10 text-13 text-paper-muted">Pact</span>
            <Pips
              label={`Pact slots (level ${sc.pact.level}) spent`}
              total={sc.pact.max}
              filled={sc.pact.used}
              disabled={ro}
              onSet={(n) => void ctx.set(["core", "spellcasting", "pact", "used"], n)}
            />
            <span className="text-13 text-paper-muted">
              {sc.pact.max - sc.pact.used} of {sc.pact.max} left, level {sc.pact.level}
            </span>
          </div>
        ) : null}
        {ro ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Add slots for a level"
              value=""
              onChange={(e) => {
                const level = Number(e.target.value);
                if (!level) return;
                const slots = [...sc.slots, { level, max: 1, used: 0 }].sort((x, y) => x.level - y.level);
                void ctx.set(["core", "spellcasting", "slots"], slots);
              }}
              className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-dashed border-paper-muted bg-transparent px-1 text-13 text-paper-muted"
            >
              <option value="">+ slots for a level</option>
              {Array.from({ length: 9 }, (_, k) => k + 1)
                .filter((level) => slotFor(level) < 0)
                .map((level) => (
                  <option key={level} value={level}>
                    {LEVEL[level]} level
                  </option>
                ))}
            </select>
            {sc.pact ? null : (
              <button
                type="button"
                onClick={() => void ctx.set(["core", "spellcasting", "pact"], { level: 1, max: 1, used: 0 })}
                className="min-h-[var(--touch-min)] text-13 text-paper-muted underline decoration-dotted hover:text-wax"
              >
                Add pact slots
              </button>
            )}
          </div>
        )}
      </div>

      {ro ? null : (
        <>
          <SectionTitle action={<AddButton label="Add the spell" onClick={addSpell} />}>
            Add a spell
          </SectionTitle>
          <div className="flex items-center gap-1.5">
            <input
              aria-label="New spell name"
              value={newSpell.name}
              placeholder="Shield"
              onChange={(e) => setNewSpell((x) => ({ ...x, name: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && addSpell()}
              className="h-8 min-h-[var(--touch-min)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-parchment-edge/60 bg-parchment/60 px-2 text-14 text-paper-ink placeholder:text-paper-muted/70 focus:border-brass-deep focus:shadow-[var(--ring-focus)] focus:outline-none"
            />
            <select
              aria-label="New spell level"
              value={newSpell.level}
              onChange={(e) => setNewSpell((s) => ({ ...s, level: Number(e.target.value) }))}
              className="h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-parchment-edge bg-parchment/60 px-1 text-14 text-paper-ink"
            >
              {LEVEL.map((l, k) => (
                <option key={l} value={k}>
                  {k === 0 ? "Cantrip" : l}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );
}
