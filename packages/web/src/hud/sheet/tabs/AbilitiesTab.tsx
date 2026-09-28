import { ABILITIES, SKILL_IDS, SKILLS } from "@gloam/shared";
import type { DerivedKey } from "@gloam/shared/schemas";
import type { SheetCtx } from "../context.ts";
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
  const override = (key: DerivedKey, v: number | undefined) => {
    const next = { ...c.overrides };
    if (v === undefined) delete next[key];
    else next[key] = v;
    void ctx.set(["core", "overrides"], next);
  };
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
    <div className="flex flex-col text-14 text-paper-ink">
      <SectionTitle>Abilities · click a modifier for a check, a save to save</SectionTitle>
      <div
        className="grid grid-cols-[auto_auto_auto_1fr] items-center gap-x-2 gap-y-0.5"
        data-testid="sheet-abilities"
      >
        <span className="caps text-12 text-paper-muted">Score</span>
        <span className="caps text-12 text-paper-muted">Check</span>
        <span className="caps text-12 text-paper-muted">Save</span>
        <span />
        {ABILITIES.map((a) => {
          const save = c.saves[a];
          return (
            <div key={a} className="group/row contents">
              <span className="flex items-center gap-1">
                <span className="caps w-8 text-12 text-paper-muted" title={abilityName(a as AbilityKey)}>
                  {a}
                </span>
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
              {derived(
                `mod.${a}`,
                `${abilityName(a as AbilityKey)} modifier`,
                `1d20 + @${a}`,
                `${abilityName(a as AbilityKey)} check`,
              )}
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={ro}
                  aria-pressed={save?.proficient === true}
                  aria-label={`${abilityName(a as AbilityKey)} save proficiency`}
                  title="Proficient in this save"
                  onClick={() =>
                    void ctx.set(["core", "saves", a], { ...(save ?? {}), proficient: !save?.proficient })
                  }
                  className="grid h-6 min-h-[var(--touch-min)] w-5 place-items-center text-paper-ink"
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
              <span />
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
          <span className="text-13 text-paper-muted">Initiative bonus</span>
          <NumberField
            label="Initiative bonus"
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
                className="grid h-6 min-h-[var(--touch-min)] w-5 place-items-center text-paper-ink"
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
