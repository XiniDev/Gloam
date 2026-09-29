import { ABILITIES } from "@gloam/shared";
import type { DerivedKey, Spell } from "@gloam/shared/schemas";
import { Fragment, useState } from "react";
import { allSpells, loadSrdSpells, useSpells } from "../../../net/spells.ts";
import { useTable } from "../../../net/table.ts";
import { toast } from "../../../ui/Toast.tsx";
import { CastDialog, type CastRequest } from "../../spells/CastDialog.tsx";
import { duplicateOf, HomebrewBuilder } from "../../spells/HomebrewBuilder.tsx";
import { SpellBrowserDialog } from "../../spells/SpellBrowserDialog.tsx";
import { casterTokenOf } from "../../spells/useCaster.ts";
import { overrideDerived, type SheetCtx } from "../context.ts";
import { DerivedValue, NumberField, Pips, RollButton, SectionTitle } from "../primitives.tsx";
import { type AbilityKey, abilityName, signed } from "../sheetActions.ts";
import { AddButton, RemoveButton } from "./OverviewTab.tsx";

const LEVEL = ["Cantrips", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];

/**
 * Spells (§8.10, §8.13): the casting ability with its save DC and attack bonus (derived, overridable), slot pips per
 * level and pact slots, spells by level with prepare toggles and Cast (the cast dialog: the slot, then the board and
 * the resolution card), a spell-attack roll, and spells added from the table's list or by name.
 */
export function SpellsTab({ ctx }: { ctx: SheetCtx }) {
  const sc = ctx.sheet.core.spellcasting;
  const ro = !ctx.canEdit;
  const [newSpell, setNewSpell] = useState({ name: "", level: 1 });
  const [casting, setCasting] = useState<CastRequest | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // A homebrew spell of one's own (§8.13 Homebrew builder): a player's goes to the DM as a proposal (AC-SPL-10).
  const [brewing, setBrewing] = useState<{ spell: Spell | null; replaces?: string } | null>(null);
  const homebrew = useSpells((st) => st.homebrew);
  const me = useTable((st) => st.me);
  const mine = homebrew.filter((h) => h.createdBy === me?.userId && h.status !== "active");
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
  // Cast (§8.13 Casting flow): the spell from the table's list — the slot, the board, the card. A spell the list
  // doesn't know (typed in by hand) spends its slot as before, and says so.
  const cast = async (entry: { name: string; level: number; contentId?: string | undefined }) => {
    let spells: Spell[] = [];
    try {
      spells = allSpells({ srd: await loadSrdSpells(), homebrew: useSpells.getState().homebrew });
    } catch {
      // the list couldn't be loaded: the slot, by hand
    }
    const spell =
      spells.find((x) => x.id === entry.contentId) ??
      spells.find((x) => x.name.toLowerCase() === entry.name.trim().toLowerCase());
    if (spell) {
      const token = casterTokenOf(ctx.actor.id);
      setCasting({
        spell,
        casterTokenId: token?.id ?? null,
        casterName: ctx.sheet.core.name,
        spellcasting: sc,
        casterLevel: Math.max(1, d.values.level),
      });
      return;
    }
    if (entry.level === 0) {
      toast.info(`${entry.name} isn't in the spell list`, "Add it from the list to cast it on the board.");
      return;
    }
    const i = sc.slots.findIndex((x) => x.level === entry.level && x.used < x.max);
    if (i < 0) {
      toast.warning(
        `No ${LEVEL[entry.level]}-level slots left`,
        `${entry.name} needs one — take a rest or cast it with a higher slot.`,
      );
      return;
    }
    void ctx.set(["core", "spellcasting", "slots", i, "used"], (sc.slots[i]?.used ?? 0) + 1);
    toast.info(
      `${entry.name}: a ${LEVEL[entry.level]}-level slot spent`,
      "It isn't in the spell list, so there's nothing to aim.",
    );
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
          text="Roll"
          test={{ kind: "attack" }}
        />
      </div>

      {[...byLevel.keys()]
        .sort((a, b) => a - b)
        .map((level) => (
          <Fragment key={level}>
            <SectionTitle>{level === 0 ? "Cantrips" : `Level ${level}`}</SectionTitle>
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
                  {!ro ? (
                    <button
                      type="button"
                      data-testid="cast-spell"
                      onClick={() => void cast(spell)}
                      // A paper-secondary button (wax stays for danger and seals).
                      className="h-7 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-paper-ink/35 px-2.5 text-13 font-semibold text-paper-ink hover:border-paper-ink/60 hover:bg-parchment-deep"
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
          </Fragment>
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
                width="2rem"
                // Boxed: the one number here that's typed in ("1 of [2] left").
                className="!border-parchment-edge/70 !bg-parchment/50"
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

      <CastDialog req={casting} onClose={() => setCasting(null)} />
      <SpellBrowserDialog
        open={browsing}
        onClose={() => setBrowsing(false)}
        title={`Add spells to ${ctx.sheet.core.name}`}
        actions={(s) => (
          <>
            {sc.spells.some((x) => x.contentId === s.id || x.name.toLowerCase() === s.name.toLowerCase()) ? (
              <span className="text-13 italic text-paper-muted">On the sheet</span>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void ctx.set(
                    ["core", "spellcasting", "spells"],
                    [...sc.spells, { name: s.name, level: s.level, prepared: false, contentId: s.id }],
                  )
                }
                className={PAPER_BUTTON}
              >
                Add to the sheet
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setBrowsing(false);
                setBrewing({ spell: duplicateOf(s, homebrew) });
              }}
              className={PAPER_BUTTON}
            >
              Duplicate as homebrew
            </button>
          </>
        )}
      />
      <HomebrewBuilder
        open={brewing !== null}
        initial={brewing?.spell ?? null}
        {...(brewing?.replaces ? { replaces: brewing.replaces } : {})}
        onClose={() => setBrewing(null)}
      />
      {ro ? null : (
        <>
          <SectionTitle
            action={
              <button
                type="button"
                onClick={() => setBrowsing(true)}
                className="min-h-[var(--touch-min)] text-13 text-paper-muted underline decoration-dotted hover:text-wax"
              >
                From the spell list…
              </button>
            }
          >
            Add a spell
          </SectionTitle>
          {/* Homebrew of one's own: a new spell, or one from the list duplicated — a player's goes to the DM. */}
          <div className="flex flex-wrap items-center gap-2" data-testid="own-homebrew">
            <button type="button" onClick={() => setBrewing({ spell: null })} className={PAPER_BUTTON}>
              New homebrew spell…
            </button>
            {mine.map((h) => (
              <button
                key={h.id}
                type="button"
                data-testid="own-homebrew-row"
                data-status={h.status}
                onClick={() => setBrewing({ spell: h.spell, replaces: h.id })}
                className="inline-flex min-h-[var(--touch-min)] items-center gap-1.5 text-13 text-paper-ink hover:text-wax"
              >
                {h.spell.name}
                <span className="caps text-12 text-paper-muted">
                  {h.status === "proposed" ? "waiting on the DM" : "not approved"}
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              aria-label="New spell name"
              value={newSpell.name}
              placeholder="e.g. Shield"
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
            <AddButton label="Add the spell" onClick={addSpell} />
          </div>
        </>
      )}
    </div>
  );
}

/** A button on the sheet's parchment (the spell list's actions, homebrew). */
const PAPER_BUTTON =
  "h-8 min-h-[var(--touch-min)] rounded-[var(--radius-control)] border border-paper-ink/35 px-3 text-13 font-semibold text-paper-ink hover:border-paper-ink/60 hover:bg-parchment-deep";
