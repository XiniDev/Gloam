import { ABILITIES, type Ability, SKILL_IDS, SKILLS, type SkillId } from "../constants.ts";
import type { DerivedKey, SheetCore } from "../schemas/sheet.ts";
import { abilityMod } from "./abilities.ts";

/**
 * Derived values of a character sheet (SPEC §8.10 Derived values; SRD 5.2.1): level from the classes, proficiency
 * bonus from the level, ability modifiers, saving throws, skills (half, proficient or expertise), passives, initiative,
 * spell save DC and attack bonus, carrying capacity — each computed, and each overridable. An override stands in for
 * the value everywhere downstream (an overridden proficiency bonus is the one every save and skill uses).
 */

export interface DerivedSheet {
  /** The values in force (overrides applied). */
  values: Record<DerivedKey, number>;
  /** The values as computed, before this key's own override (what "revert" goes back to). */
  auto: Record<DerivedKey, number>;
  /** The keys set by hand. */
  overridden: ReadonlySet<DerivedKey>;
  /** Pounds carried: items × their weight, and coins at 50 to the pound. */
  load: number;
}

/** 2 at levels 1–4, +1 every four levels after. */
export const proficiencyFor = (level: number) => 2 + Math.floor((Math.max(1, level) - 1) / 4);

const SIZE_CARRY: Record<SheetCore["size"], number> = {
  tiny: 0.5,
  small: 1,
  medium: 1,
  large: 2,
  huge: 4,
  gargantuan: 8,
};

export function deriveSheet(core: SheetCore): DerivedSheet {
  const values = {} as Record<DerivedKey, number>;
  const auto = {} as Record<DerivedKey, number>;
  const overridden = new Set<DerivedKey>();
  const set = (key: DerivedKey, computed: number): number => {
    auto[key] = computed;
    const o = core.overrides[key];
    if (o !== undefined) overridden.add(key);
    values[key] = o ?? computed;
    return values[key];
  };
  const level = set(
    "level",
    core.classes.reduce((s, c) => s + c.level, 0),
  );
  const pb = set("proficiencyBonus", proficiencyFor(level));
  const mod = {} as Record<Ability, number>;
  for (const a of ABILITIES) mod[a] = set(`mod.${a}`, abilityMod(core.abilities[a]));
  for (const a of ABILITIES) {
    const s = core.saves[a];
    set(`save.${a}`, mod[a] + (s?.proficient ? pb : 0) + (s?.bonus ?? 0));
  }
  const profPart = { none: 0, half: Math.floor(pb / 2), proficient: pb, expertise: 2 * pb } as const;
  for (const id of SKILL_IDS) {
    const s = core.skills[id];
    set(`skill.${id}`, mod[SKILLS[id]] + profPart[s?.prof ?? "none"] + (s?.bonus ?? 0));
  }
  set("passive.perception", 10 + values["skill.perception"]);
  set("passive.investigation", 10 + values["skill.investigation"]);
  set("passive.insight", 10 + values["skill.insight"]);
  set("initiative", mod.dex + core.initiativeBonus);
  const sc = core.spellcasting;
  set("spell.dc", sc ? 8 + pb + mod[sc.ability] : 0);
  set("spell.attack", sc ? pb + mod[sc.ability] : 0);
  set("carry.capacity", Math.floor(core.abilities.str * 15 * SIZE_CARRY[core.size]));
  const coins = core.currency.cp + core.currency.sp + core.currency.ep + core.currency.gp + core.currency.pp;
  const load = core.inventory.reduce((s, i) => s + i.qty * i.weight, 0) + coins / 50;
  return { values, auto, overridden, load: Math.round(load * 100) / 100 };
}

/**
 * The `@` references of dice formulas (§18.1) against a sheet: `@str`…`@cha` (modifiers), `@prof`, `@level`, `@init`,
 * `@spellmod`, `@spelldc`, `@<ability>.save`, `@skill.<skill>` and `@<skill>`. Unknown ones are undefined (an error for
 * the roll).
 */
export function sheetRefs(core: SheetCore): (path: readonly string[]) => number | undefined {
  const d = deriveSheet(core);
  const v = d.values;
  return (path) => {
    const [a, b] = path;
    if (!a) return undefined;
    if (b === undefined) {
      if ((ABILITIES as readonly string[]).includes(a)) return v[`mod.${a as Ability}`];
      if (a === "prof") return v.proficiencyBonus;
      if (a === "level") return v.level;
      if (a === "init") return v.initiative;
      if (a === "spellmod") return core.spellcasting ? v[`mod.${core.spellcasting.ability}`] : undefined;
      if (a === "spelldc") return core.spellcasting ? v["spell.dc"] : undefined;
      if ((SKILL_IDS as readonly string[]).includes(a)) return v[`skill.${a as SkillId}`];
      return undefined;
    }
    if (b === "save" && (ABILITIES as readonly string[]).includes(a)) return v[`save.${a as Ability}`];
    if (a === "skill" && (SKILL_IDS as readonly string[]).includes(b)) return v[`skill.${b as SkillId}`];
    return undefined;
  };
}
