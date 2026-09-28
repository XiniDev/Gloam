/**
 * What sheet things are called on screen (SPEC §8.10): abilities, skills, the derived numbers, and any field a change
 * touches — "AC", "Wisdom score", "Perception proficiency", "Sanity value" — so a proposal's diff reads as the sheet
 * does, not as its JSON paths.
 */
import type { Ability, SkillId } from "../constants.ts";

export const ABILITY_NAMES: Record<Ability, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

/** A skill's name as printed ("sleightOfHand" → "Sleight of Hand", "animalHandling" → "Animal Handling"). */
export function skillName(id: SkillId | string): string {
  return id
    .replace(/([A-Z])/g, " $1")
    .split(" ")
    .map((w, i) =>
      i && ["Of", "And"].includes(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

const abilityOf = (k: unknown) => ABILITY_NAMES[k as Ability] ?? String(k);

/** A derived number's name ("skill.perception" → "Perception", "mod.str" → "Strength modifier"). */
export function derivedName(key: string): string {
  const [head, tail] = key.split(".");
  switch (head) {
    case "level":
      return "Level";
    case "proficiencyBonus":
      return "Proficiency bonus";
    case "initiative":
      return "Initiative";
    case "passive":
      return `Passive ${skillName(tail ?? "")}`;
    case "spell":
      return tail === "dc" ? "Spell save DC" : "Spell attack";
    case "carry":
      return "Carrying capacity";
    case "mod":
      return `${abilityOf(tail)} modifier`;
    case "save":
      return `${abilityOf(tail)} save`;
    case "skill":
      return skillName(tail ?? "");
    default:
      return humanize(key);
  }
}

/** "initiativeBonus" → "Extra initiative bonus". */
function humanize(key: string): string {
  const words = key.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CORE: Record<string, string> = {
  name: "Name",
  portraitAssetId: "Portrait",
  tokenAssetId: "Token image",
  species: "Species",
  background: "Background",
  alignment: "Alignment",
  classes: "Classes",
  xp: "XP",
  size: "Size",
  initiativeBonus: "Extra initiative bonus",
  conditions: "Conditions",
  conditionImmunities: "Condition immunities",
  resistances: "Resistances",
  immunities: "Immunities",
  vulnerabilities: "Vulnerabilities",
  exhaustion: "Exhaustion",
  inspiration: "Inspiration",
  concentration: "Concentration",
  deathSaves: "Death saves",
  hitDice: "Hit dice",
  inventory: "Inventory",
  currency: "Coins",
  features: "Features",
  attacks: "Attacks",
  notes: "Notes",
  spellcasting: "Spellcasting",
  light: "Light carried",
  languages: "Languages",
  proficiencies: "Proficiencies",
};

const HP: Record<string, string> = { max: "Max HP", current: "HP", temp: "Temporary HP" };
const AC: Record<string, string> = { value: "AC", note: "AC note" };
const SPEED = (k: string) => (k === "hover" ? "Hovers" : `${humanize(k)} speed`);

/**
 * A changed field's name, from its path in the sheet; with the sheet, a custom block goes by its own title
 * ("Sanity value").
 */
export function fieldLabel(
  path: readonly (string | number)[],
  sheet?: { custom?: readonly { title?: string }[] },
): string {
  const [root, a, b, c] = path;
  if (root === "importNotes") return "Import notes";
  if (root === "custom") {
    if (typeof a !== "number") return "Custom blocks";
    const title = sheet?.custom?.[a]?.title || `Custom block ${a + 1}`;
    return b === undefined ? title : `${title} ${humanize(String(b)).toLowerCase()}`;
  }
  if (root !== "core" || a === undefined)
    return path.length ? humanize(String(path[path.length - 1])) : "The sheet";
  switch (a) {
    case "hp":
      return b === undefined ? "HP" : (HP[String(b)] ?? `HP ${String(b)}`);
    case "ac":
      return b === undefined ? "AC" : (AC[String(b)] ?? "AC");
    case "abilities":
      return b === undefined ? "Ability scores" : `${abilityOf(b)} score`;
    case "saves":
      return b === undefined ? "Saving throws" : `${abilityOf(b)} save proficiency`;
    case "skills":
      return b === undefined
        ? "Skills"
        : `${skillName(String(b))} ${c === "bonus" ? "bonus" : "proficiency"}`;
    case "speeds":
      return b === undefined ? "Speeds" : SPEED(String(b));
    case "senses":
      return b === undefined ? "Senses" : humanize(String(b));
    case "overrides":
      return b === undefined ? "Numbers set by hand" : `${derivedName(String(b))} (set by hand)`;
    case "classes":
      return typeof b === "number" ? `Class ${b + 1}${c === "level" ? " level" : ""}` : "Classes";
    default:
      return CORE[String(a)] ?? humanize(String(a));
  }
}
