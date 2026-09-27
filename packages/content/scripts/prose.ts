/**
 * Step 4 of the content pipeline (SPEC §33.2): structured facts read from the canonical PDF prose with
 * explicit patterns. Every finding carries the pattern id that produced it, which ends up in the record's
 * `provenance` and in docs/research/spells-report.md.
 *
 * Inputs are the plain paragraph/bullet text of a spell (tables and stat blocks excluded, so a summoned
 * creature's "Blindsight 30 ft." or "1d8 + 3" never reads as the spell's own data).
 */
import type { SpellInput } from "@gloam/shared/schemas";

type Area = NonNullable<SpellInput["area"]>;
type DamageType = NonNullable<SpellInput["damage"]>[number]["type"];
type Ability = NonNullable<SpellInput["save"]>["ability"];
type ConditionId = NonNullable<SpellInput["conditions"]>[number]["id"];

export interface Finding<T> {
  value: T;
  pattern: string;
  /** Character offset of the match (earliest finding wins when several patterns match). */
  at: number;
  match: string;
}

const ABILITIES: Record<string, Ability> = {
  Strength: "str",
  Dexterity: "dex",
  Constitution: "con",
  Intelligence: "int",
  Wisdom: "wis",
  Charisma: "cha",
};

const DAMAGE_WORDS =
  "Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|Poison|Psychic|Radiant|Slashing|Thunder";
const CONDITION_WORDS =
  "Blinded|Charmed|Deafened|Exhaustion|Frightened|Grappled|Incapacitated|Invisible|Paralyzed|Petrified|Poisoned|Prone|Restrained|Stunned|Unconscious";

const NUM_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
};
const toNum = (s: string) => NUM_WORDS[s.toLowerCase()] ?? Number(s);

/** "10-foot", also tolerating the PDF's occasional "10- foot". */
const FT = String.raw`(\d+)-\s?foot`;

interface AreaPattern {
  id: string;
  re: RegExp;
  build: (m: RegExpExecArray) => Area;
  /** Rejects matches that describe a size limit rather than an area of effect. */
  reject?: (before: string) => boolean;
}

const SIZE_LIMIT = /(no larger than|must fit in|fit within|contained within|connected|Any)\s+(an?\s+)?$/i;

const AREA_PATTERNS: AreaPattern[] = [
  {
    id: "N-foot-radius, N-foot-high Cylinder",
    re: new RegExp(`${FT}-radius, ${FT}[- ](?:high|tall) Cylinder`),
    build: (m) => ({ shape: "cylinder", radius: Number(m[1]), height: Number(m[2]) }),
  },
  {
    id: "N-foot-tall, N-foot-radius Cylinder",
    re: new RegExp(`${FT}-(?:high|tall), ${FT}-radius Cylinder`),
    build: (m) => ({ shape: "cylinder", radius: Number(m[2]), height: Number(m[1]) }),
  },
  {
    id: "Cylinder that is N feet tall with a N-foot radius",
    re: new RegExp(String.raw`Cylinder that is (\d+) feet (?:tall|high) with a ${FT} radius`),
    build: (m) => ({ shape: "cylinder", radius: Number(m[2]), height: Number(m[1]) }),
  },
  {
    id: "N-foot-radius Sphere",
    re: new RegExp(`${FT}-radius Sphere`),
    build: (m) => ({ shape: "sphere", radius: Number(m[1]) }),
  },
  {
    id: "N-foot Cone",
    re: new RegExp(`${FT} Cone`),
    build: (m) => ({ shape: "cone", length: Number(m[1]) }),
  },
  {
    id: "N-foot-long, N-foot-wide Line",
    re: new RegExp(`${FT}-long, ${FT}-wide Line`),
    build: (m) => ({ shape: "line", length: Number(m[1]), width: Number(m[2]) }),
  },
  {
    id: "N-foot-wide, N-foot-long Line",
    re: new RegExp(`${FT}-wide, ${FT}-long Line`),
    build: (m) => ({ shape: "line", length: Number(m[2]), width: Number(m[1]) }),
  },
  {
    id: "Line … N feet long and N feet wide",
    re: /Line of [^.]*?(\d+) feet long and (\d+) feet wide/,
    build: (m) => ({ shape: "line", length: Number(m[1]), width: Number(m[2]) }),
  },
  {
    id: "N-foot Emanation",
    re: new RegExp(`${FT} Emanation`),
    build: (m) => ({ shape: "emanation", distance: Number(m[1]) }),
  },
  {
    id: "N-foot Cube",
    re: new RegExp(`${FT} Cube\\b`),
    build: (m) => ({ shape: "cube", size: Number(m[1]) }),
    reject: (before) => SIZE_LIMIT.test(before),
  },
  {
    // A flat square on the ground (Grease, Entangle, Black Tentacles): §17.1 has no square, so a Cube of the
    // same side gives the same footprint.
    id: "N-foot square (ground) → Cube",
    re: new RegExp(`${FT} square\\b`),
    build: (m) => ({ shape: "cube", size: Number(m[1]) }),
    reject: (before) => /\b(one|each|any)\s+$/i.test(before),
  },
  {
    id: "Cube up to N feet on a side",
    re: /\bCube up to (\d+) feet on a side/,
    build: (m) => ({ shape: "cube", size: Number(m[1]) }),
  },
  {
    id: "Cube … as large as N feet on each side",
    re: /\bCube that can be as small as \d+ feet to as large as (\d+) feet on each side/,
    build: (m) => ({ shape: "cube", size: Number(m[1]) }),
  },
];

/** The first area-of-effect phrase in the text (size limits such as "no larger than a 20-foot Cube" skipped). */
export function proseArea(text: string): Finding<Area> | null {
  let best: Finding<Area> | null = null;
  for (const p of AREA_PATTERNS) {
    const re = new RegExp(p.re.source, "g");
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (p.reject?.(before)) continue;
      if (!best || m.index < best.at) best = { value: p.build(m), pattern: p.id, at: m.index, match: m[0] };
      break;
    }
  }
  return best;
}

/** "The Sphere’s radius increases by 5 feet for each spell slot level above 4." */
export function proseAreaScaling(higher: string): Finding<number> | null {
  const re =
    /([^.]*\b(?:radius|Cube|Sphere|Emanation|Cone|Line|size|length)\b[^.]*?)\bby (\d+) feet,? for (?:each|every) (?:spell )?slot level above/;
  const m = re.exec(higher);
  if (!m) return null;
  return { value: Number(m[2]), pattern: "area increases by N feet per slot", at: m.index, match: m[0] };
}

/** First saving throw the spell forces (not "Advantage on Dexterity saving throws"). */
export function proseSave(
  text: string,
): Finding<{ ability: Ability; onSuccess: "half" | "none" | "special" }> | null {
  const re =
    /\b(?:make|makes|making|succeed on|succeeds on|repeat|repeats|fails|fail) (?:a|an|another|the) (?:DC \d+ )?(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/;
  const m = re.exec(text);
  if (!m) return null;
  const ability = ABILITIES[m[1]!]!;
  let onSuccess: "half" | "none" | "special" = "none";
  let pattern = "makes/succeeds on a <Ability> saving throw";
  // A success clause that only ends or negates the spell ("the spell ends", "has no effect") means the
  // save simply avoids the effect; any other consequence of a success is "special".
  const success = /On a successful save, ([^.]*)\./.exec(text);
  const negates =
    /^(?:the spell ends|the spell has no effect|the (?:target|creature) (?:isn’t affected|is unaffected|resists|is no longer affected|isn’t Restrained)|it is no longer)/;
  if (/half as much damage|half the initial damage/.test(text)) {
    onSuccess = "half";
    pattern += " + half as much damage";
  } else if (success && !negates.test(success[1]!)) {
    onSuccess = "special";
    pattern += " + On a successful save (other effect)";
  }
  return { value: { ability, onSuccess }, pattern, at: m.index, match: m[0] };
}

export function proseAttack(text: string): Finding<"melee" | "ranged"> | null {
  const m = /\b(melee|ranged) spell attack/i.exec(text);
  if (!m) return null;
  return {
    value: m[1]!.toLowerCase() as "melee" | "ranged",
    pattern: "<melee|ranged> spell attack",
    at: m.index,
    match: m[0],
  };
}

export interface ProseDamage {
  formula: string;
  type: DamageType;
  /** "5d10 Radiant or Necrotic damage": the caster chooses. */
  typeOptions?: DamageType[];
}

/**
 * Damage phrases in order of appearance: "8d6 Fire damage", "5d10 Radiant or Necrotic damage",
 * "20 Radiant damage", "Fire damage equal to 3d6 plus your spellcasting ability modifier".
 */
export function proseDamage(text: string): Finding<ProseDamage>[] {
  const out: Finding<ProseDamage>[] = [];
  const typeList = `(?:${DAMAGE_WORDS})(?:(?:,| or|, or) (?:${DAMAGE_WORDS}))*`;
  const direct = new RegExp(String.raw`\b(\d+d\d+(?: \+ \d+)?|\d+) (${typeList}) damage`, "g");
  for (let m = direct.exec(text); m; m = direct.exec(text)) {
    const types = m[2]!.split(/,? or |, /).map((t) => t.trim().toLowerCase() as DamageType);
    // "10d6 + 40 Force damage" is one phrase; skip the bare "40 Force damage" inside it.
    if (/^\d+$/.test(m[1]!) && /\d+d\d+ \+ $/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const value: ProseDamage = { formula: m[1]!.replace(/ /g, ""), type: types[0]! };
    if (types.length > 1) value.typeOptions = types;
    out.push({
      value,
      pattern:
        types.length > 1
          ? "NdM <Type> or <Type> damage"
          : /d/.test(m[1]!)
            ? "NdM <Type> damage"
            : "N <Type> damage",
      at: m.index,
      match: m[0],
    });
  }
  const plusMod = new RegExp(
    String.raw`\b(${DAMAGE_WORDS}) damage (?:to [^.,]{1,30}? )?equal to (\d+d\d+) plus your spellcasting ability modifier`,
    "g",
  );
  for (let m = plusMod.exec(text); m; m = plusMod.exec(text)) {
    out.push({
      value: { formula: `${m[2]} + @spellmod`, type: m[1]!.toLowerCase() as DamageType },
      pattern: "<Type> damage equal to NdM plus your spellcasting ability modifier",
      at: m.index,
      match: m[0],
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface ProseSlotScaling {
  perLevel: string[];
  /** Damage type the sentence names ("The Bludgeoning damage increases…"), if any. */
  type?: DamageType;
  appliesTo: "damage" | "healing" | "both";
}

/** "The damage increases by 1d6 for each spell slot level above 3." and variants. */
export function proseSlotScaling(higher: string): Finding<ProseSlotScaling> | null {
  if (!/for (?:each|every) (?:spell )?slot level above/.test(higher)) return null;
  // Dice ("increases by 1d6") or a flat amount directly followed by "for each" ("increase by 5 for each").
  const dice = [...higher.matchAll(/increases? by (\d+d\d+|\d+(?=\s+for (?:each|every)\b))/g)].map(
    (m) => m[1]!,
  );
  if (dice.length === 0) return null;
  const typed = new RegExp(String.raw`\bThe (${DAMAGE_WORDS}) damage increases`).exec(higher);
  const healing = /\bhealing\b|\bHit Points increase\b/i.test(higher);
  const damage = /\bdamage\b/i.test(higher);
  const value: ProseSlotScaling = {
    perLevel: dice,
    appliesTo: healing === damage ? "both" : healing ? "healing" : "damage",
  };
  if (typed) value.type = typed[1]!.toLowerCase() as DamageType;
  return { value, pattern: "increases by NdM for each spell slot level above", at: 0, match: higher };
}

/** "The damage increases by 1d10 when you reach levels 5 (2d10), 11 (3d10), and 17 (4d10)." */
export function proseCantripScaling(upgrade: string): Finding<Record<"5" | "11" | "17", string>> | null {
  const m = /levels 5 \((\d+d\d+)\), 11 \((\d+d\d+)\), and 17 \((\d+d\d+)\)/.exec(upgrade);
  if (!m) return null;
  return {
    value: { "5": m[1]!, "11": m[2]!, "17": m[3]! },
    pattern: "levels 5 (NdM), 11 (NdM), and 17 (NdM)",
    at: m.index,
    match: m[0],
  };
}

export function proseHealing(text: string): Finding<string> | null {
  const plusMod =
    /regains? (?:a number of )?Hit Points equal to (\d+d\d+(?: \+ \d+)?) plus your spellcasting ability modifier/.exec(
      text,
    );
  if (plusMod) {
    return {
      value: `${plusMod[1]!.replace(/ /g, "")} + @spellmod`,
      pattern: "regains Hit Points equal to NdM plus your spellcasting ability modifier",
      at: plusMod.index,
      match: plusMod[0],
    };
  }
  const flat = /regains? (\d+d\d+(?: \+ \d+)?|\d+) Hit Points/.exec(text);
  if (flat) {
    return {
      value: flat[1]!.replace(/ /g, ""),
      pattern: "regains N Hit Points",
      at: flat.index,
      match: flat[0],
    };
  }
  return null;
}

const COND_ID = (w: string) => w.toLowerCase() as ConditionId;

/** Conditions the spell imposes ("…or have the Paralyzed condition"), not ones it checks for or prevents. */
export function proseConditions(text: string): Finding<ConditionId[]> | null {
  const list = `(?:${CONDITION_WORDS})(?:(?:,| and| or|, and|, or) (?:${CONDITION_WORDS}))*`;
  const re = new RegExp(String.raw`\b(?:has|have|gains?|having) the (${list}) conditions?`, "g");
  const found: ConditionId[] = [];
  let first = -1;
  let firstMatch = "";
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    // Checked for, prevented or removed rather than imposed: "if it has the…", "can’t … gain the…",
    // "nor cause the target to have the…", "have the … conditions removed".
    if (
      /\b(if|while|unless|whether|already|that|who|isn’t|doesn’t|can’t|can't|cannot|nor|neither|immune)\b[^,.;]*$/i.test(
        before,
      )
    ) {
      continue;
    }
    if (/^\s*(removed|end)\b/.test(after)) continue;
    for (const w of m[1]!.split(/,? (?:and|or) |, /)) {
      const id = COND_ID(w.trim());
      if (!found.includes(id)) found.push(id);
    }
    if (first < 0) {
      first = m.index;
      firstMatch = m[0];
    }
  }
  if (found.length === 0) return null;
  return { value: found, pattern: "has/have the <Condition> condition", at: first, match: firstMatch };
}

export function proseLight(text: string): Finding<{ bright: number; dim: number }> | null {
  const patterns: {
    id: string;
    re: RegExp;
    build: (m: RegExpExecArray) => { bright: number; dim: number };
  }[] = [
    {
      id: "Bright Light in a N-foot radius and Dim Light for an additional N feet",
      re: new RegExp(`Bright Light in an? ${FT} radius and Dim Light for an additional (\\d+) feet`),
      build: (m) => ({ bright: Number(m[1]), dim: Number(m[2]) }),
    },
    {
      id: "Bright Light within N feet and Dim Light for an additional N feet",
      re: /Bright Light within (\d+) feet and Dim Light for an additional (\d+) feet/,
      build: (m) => ({ bright: Number(m[1]), dim: Number(m[2]) }),
    },
    {
      id: "Dim Light in a N-foot radius",
      re: new RegExp(`Dim Light in an? ${FT} radius`),
      build: (m) => ({ bright: 0, dim: Number(m[1]) }),
    },
    {
      id: "Bright Light in a N-foot radius",
      re: new RegExp(`Bright Light in an? ${FT} radius`),
      build: (m) => ({ bright: Number(m[1]), dim: 0 }),
    },
  ];
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (m) return { value: p.build(m), pattern: p.id, at: m.index, match: m[0] };
  }
  return null;
}

/** "Choose up to three creatures", "up to six creatures of your choice". */
export function proseTargetCount(text: string): Finding<number> | null {
  const m =
    /\bup to (one|two|three|four|five|six|seven|eight|nine|ten|twelve|\d+) (?:willing |other )?creatures?\b/.exec(
      text,
    );
  if (!m) return null;
  return { value: toNum(m[1]!), pattern: "up to N creatures", at: m.index, match: m[0] };
}

/** "You can target one additional creature for each spell slot level above 2." */
export function proseTargetCountPerSlot(higher: string): Finding<number> | null {
  const m = /\b(one|two) additional creatures? for (?:each|every) (?:spell )?slot level above/.exec(higher);
  if (!m) return null;
  return {
    value: toNum(m[1]!),
    pattern: "N additional creature(s) for each spell slot level above",
    at: m.index,
    match: m[0],
  };
}
