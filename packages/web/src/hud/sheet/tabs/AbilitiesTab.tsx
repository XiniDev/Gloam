import { ABILITIES, SKILL_IDS, SKILLS } from "@gloam/shared";
import type { DerivedKey } from "@gloam/shared/schemas";
import { overrideDerived, type SheetCtx } from "../context.ts";
import { DerivedValue, NumberField, Rollable, SectionTitle } from "../primitives.tsx";
import { type AbilityKey, abilityName, signed, skillName } from "../sheetActions.ts";

const PROF_CYCLE = ["none", "half", "proficient", "expertise"] as const;
const PROF_MARK: Record<(typeof PROF_CYCLE)[number], string> = {
  none: "○",
  half: "◐",
  proficient: "●",
  expertise: "◉",
};

/**
 * Abilities & Skills (§8.10): scores with their modifiers, saves and all 18 skills — each rolls when clicked, each
 * derived number can be set by hand and reverted; proficiency cycles none → half → proficient → expertise.
 */
export function AbilitiesTab({ ctx }: { ctx: SheetCtx }) {
  const c = ctx.sheet.core;
  const d = ctx.derived;
  const ro = !ctx.canEdit;
  const override = (key: DerivedKey, v: number | undefined) => overrideDerived(ctx, key, v);
  const derived = (key: DerivedKey, label: string, formula: string, rollLabel: string) => (
    <DerivedValue
      value={d.values[key]}
      auto={d.auto[key]}
      overridden={d.overridden.has(key)}
      onOverride={(v) => override(key, v)}
      onRevert={() => override(key, undefined)}
      label={label}
      disabled={ro}
    >
      <Rollable
        actor={ctx.actor}
        formula={formula}
        label={rollLabel}
        className="tabular min-w-[2.5rem] justify-center font-bold"
      >
        {signed(d.values[key])}
      </Rollable>
    </DerivedValue>
  );
  return (
    <div className="@container flex flex-col text-14 text-paper-ink">
      <SectionTitle>Abilities</SectionTitle>
      <p className="mb-1 text-13 text-paper-muted">A modifier rolls its check, a save its saving throw.</p>
      {/* Ability | Score | Check | Save across the whole width, each heading over its numbers; a narrow page (a phone)
          names each ability by its three letters so the numbers keep their columns. */}
      <div
        className="grid grid-cols-[minmax(2.5rem,1fr)_repeat(3,auto)] items-center gap-x-2 gap-y-0.5 @min-[420px]:gap-x-4"
        data-testid="sheet-abilities"
      >
        {/* (On a narrow page the three-letter names need no heading, and it wouldn't fit their column.) */}
        <span className="caps text-12 text-paper-muted">
          <span className="hidden @min-[420px]:inline">Ability</span>
        </span>
        <span className="caps text-center text-12 text-paper-muted">Score</span>
        <span className="caps text-center text-12 text-paper-muted">Check</span>
        <span className="caps text-center text-12 text-paper-muted">Save</span>
        {ABILITIES.map((a) => {
          const save = c.saves[a];
          return (
            <div key={a} className="group/row contents">
              <span className="min-w-0 truncate text-14 text-paper-ink" title={abilityName(a as AbilityKey)}>
                <span className="caps text-12 @min-[420px]:hidden">{a}</span>
                <span className="hidden @min-[420px]:inline">{abilityName(a as AbilityKey)}</span>
              </span>
              <span className="flex justify-center">
                <NumberField
                  label={`${abilityName(a as AbilityKey)} score`}
                  value={c.abilities[a]}
                  min={1}
                  max={30}
                  width="2.75rem"
                  disabled={ro}
                  onCommit={(v) => void ctx.set(["core", "abilities", a], v)}
                />
              </span>
              <span className="flex justify-center">
                {derived(
                  `mod.${a}`,
                  `${abilityName(a as AbilityKey)} modifier`,
                  `1d20 + @${a}`,
                  `${abilityName(a as AbilityKey)} check`,
                )}
              </span>
              <span className="flex items-center justify-center gap-0.5">
                <button
                  type="button"
                  disabled={ro}
                  aria-pressed={save?.proficient === true}
                  aria-label={`${abilityName(a as AbilityKey)} save proficiency`}
                  title="Proficient in this save"
                  onClick={() =>
                    void ctx.set(["core", "saves", a], { ...(save ?? {}), proficient: !save?.proficient })
                  }
                  className="grid h-6 min-h-[var(--touch-min)] w-5 min-w-[var(--touch-min)] place-items-center text-paper-ink"
                >
                  {save?.proficient ? "●" : "○"}
                </button>
                {derived(
                  `save.${a}`,
                  `${abilityName(a as AbilityKey)} save`,
                  `1d20 + @${a}.save`,
                  `${abilityName(a as AbilityKey)} save`,
                )}
              </span>
            </div>
          );
        })}
      </div>

      <SectionTitle>Proficiency and initiative</SectionTitle>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="group/row inline-flex items-center gap-1">
          <span className="text-13 text-paper-muted">Proficiency bonus</span>
          <DerivedValue
            value={d.values.proficiencyBonus}
            auto={d.auto.proficiencyBonus}
            overridden={d.overridden.has("proficiencyBonus")}
            onOverride={(v) => override("proficiencyBonus", v)}
            onRevert={() => override("proficiencyBonus", undefined)}
            label="Proficiency bonus"
            disabled={ro}
          >
            <span className="tabular font-bold">{signed(d.values.proficiencyBonus)}</span>
          </DerivedValue>
        </span>
        <span className="group/row inline-flex items-center gap-1">
          <span className="text-13 text-paper-muted">Initiative</span>
          {derived("initiative", "Initiative", "1d20 + @init", "Initiative")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="text-13 text-paper-muted">Extra initiative bonus</span>
          <NumberField
            label="Extra initiative bonus"
            value={c.initiativeBonus}
            min={-99}
            max={99}
            disabled={ro}
            onCommit={(v) => void ctx.set(["core", "initiativeBonus"], v)}
          />
        </span>
      </div>

      <SectionTitle>Skills</SectionTitle>
      <ul className="flex flex-col" data-testid="sheet-skills">
        {SKILL_IDS.map((id) => {
          const s = c.skills[id];
          const prof = s?.prof ?? "none";
          const next = PROF_CYCLE[
            (PROF_CYCLE.indexOf(prof) + 1) % PROF_CYCLE.length
          ] as (typeof PROF_CYCLE)[number];
          return (
            <li
              key={id}
              className="group/row flex items-center gap-1.5 border-b border-parchment-edge/30 py-0.5"
            >
              <button
                type="button"
                disabled={ro}
                aria-label={`${skillName(id)}: ${prof}; change to ${next}`}
                title={`${prof} — click for ${next}`}
                onClick={() => void ctx.set(["core", "skills", id], { ...(s ?? {}), prof: next })}
                className="grid h-6 min-h-[var(--touch-min)] w-5 min-w-[var(--touch-min)] place-items-center text-paper-ink"
              >
                {PROF_MARK[prof]}
              </button>
              <span className="min-w-0 flex-1 truncate">
                {skillName(id)} <span className="caps text-12 text-paper-muted">{SKILLS[id]}</span>
              </span>
              {derived(`skill.${id}`, skillName(id), `1d20 + @skill.${id}`, skillName(id))}
            </li>
          );
        })}
      </ul>

      <SectionTitle>Passives</SectionTitle>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {(
          [
            ["passive.perception", "Perception"],
            ["passive.investigation", "Investigation"],
            ["passive.insight", "Insight"],
          ] as const
        ).map(([key, label]) => (
          <span key={key} className="group/row inline-flex items-center gap-1">
            <span className="text-13 text-paper-muted">{label}</span>
            <DerivedValue
              value={d.values[key]}
              auto={d.auto[key]}
              overridden={d.overridden.has(key)}
              onOverride={(v) => override(key, v)}
              onRevert={() => override(key, undefined)}
              label={`Passive ${label}`}
              disabled={ro}
            >
              <span className="tabular font-bold">{d.values[key]}</span>
            </DerivedValue>
          </span>
        ))}
      </div>
    </div>
  );
}
