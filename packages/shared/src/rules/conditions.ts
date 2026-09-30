/**
 * Conditions and status markers (SPEC §8.11, §19.3, §34.1): each one's name, a one-line summary for its tooltip
 * (paraphrased from SRD 5.2.1, with its page), and the metadata that drives hints and some enforcement — speed 0,
 * incapacitation, no sight, automatic Str/Dex save failures, and what it does to rolls. Pure data and functions.
 */
import type { ConditionId, MarkerId } from "../constants.ts";

export type RollKind = "attack" | "check" | "save" | "initiative";

export interface ConditionInfo {
  name: string;
  summary: string;
  /** SRD 5.2.1 page(s). */
  page: string;
  speedZero: boolean;
  incapacitated: boolean;
  noSight: boolean;
  /** Automatically fails Strength and Dexterity saving throws. */
  autoFailStrDex: boolean;
  /** Its own rolls, by kind: advantage or disadvantage (a hint the roller can take away before rolling). */
  own: Partial<Record<RollKind, "adv" | "dis">>;
  /** Its Dexterity saves specifically (Restrained). */
  dexSave?: "dis";
  /** What attackers get against it (the attacker's hint). */
  against?: "adv" | "dis" | "adv-within-5";
  /** Hits from within 5 ft are critical hits. */
  critWithin5?: boolean;
  /** When the roll depends on the source being in sight (Frightened): shown with the hint. */
  note?: string;
  /**
   * The conditions it includes (SRD 5.2.1: Unconscious — "you have the Incapacitated and Prone conditions"; Paralyzed,
   * Petrified, Stunned — Incapacitated): what they do, it does (rules audit A5).
   */
  implies?: ConditionId[];
  /** Conditions it makes the creature immune to (Petrified: "Immunity to the Poisoned condition", rules audit A12). */
  immuneTo?: ConditionId[];
}

const c = (
  name: string,
  summary: string,
  page: string,
  rest: Partial<Omit<ConditionInfo, "name" | "summary" | "page">> = {},
): ConditionInfo => ({
  name,
  summary,
  page,
  speedZero: false,
  incapacitated: false,
  noSight: false,
  autoFailStrDex: false,
  own: {},
  ...rest,
});

export const CONDITIONS: Record<ConditionId, ConditionInfo> = {
  blinded: c(
    "Blinded",
    "Can't see; fails checks that need sight; attacks against it have advantage, its attacks disadvantage.",
    "177",
    { noSight: true, own: { attack: "dis" }, against: "adv" },
  ),
  charmed: c(
    "Charmed",
    "Can't attack its charmer or target it with harm; the charmer has advantage on social checks against it.",
    "178",
  ),
  deafened: c("Deafened", "Can't hear; fails checks that need hearing.", "181"),
  exhaustion: c(
    "Exhaustion",
    "Levels add up: D20 Tests −2 × level, Speed −5 ft × level; level 6 is death; a Long Rest removes one.",
    "181",
  ),
  frightened: c(
    "Frightened",
    "Disadvantage on checks and attacks while its fear's source is in sight; can't willingly move closer to it.",
    "182",
    { own: { attack: "dis", check: "dis" }, note: "while the source is in sight" },
  ),
  grappled: c(
    "Grappled",
    "Speed 0; disadvantage on attacks against anyone but its grappler, who can drag it along.",
    "182, 190",
    { speedZero: true, own: { attack: "dis" }, note: "against anyone but the grappler" },
  ),
  incapacitated: c(
    "Incapacitated",
    "No actions, bonus actions or reactions; concentration breaks; can't speak; disadvantage on initiative.",
    "184",
    { incapacitated: true, own: { initiative: "dis" } },
  ),
  invisible: c(
    "Invisible",
    "Advantage on initiative; attacks against it have disadvantage and its attacks advantage, unless it's seen.",
    "184",
    {
      own: { attack: "adv", initiative: "adv" },
      against: "dis",
      note: "unless the other creature can see it",
    },
  ),
  paralyzed: c(
    "Paralyzed",
    "Incapacitated, Speed 0; fails Str and Dex saves; attacks against it have advantage; hits within 5 ft crit.",
    "186",
    {
      speedZero: true,
      incapacitated: true,
      autoFailStrDex: true,
      against: "adv",
      critWithin5: true,
      implies: ["incapacitated"],
    },
  ),
  petrified: c(
    "Petrified",
    "As Paralyzed without the automatic crits; resistance to all damage; immune to Poisoned.",
    "186",
    {
      speedZero: true,
      incapacitated: true,
      autoFailStrDex: true,
      against: "adv",
      implies: ["incapacitated"],
      immuneTo: ["poisoned"],
    },
  ),
  poisoned: c("Poisoned", "Disadvantage on attack rolls and ability checks.", "186", {
    own: { attack: "dis", check: "dis" },
  }),
  prone: c(
    "Prone",
    "Crawls, or spends half its Speed to stand; its attacks have disadvantage; attacks against it: advantage within 5 ft, else disadvantage.",
    "186, 14",
    { own: { attack: "dis" }, against: "adv-within-5" },
  ),
  restrained: c(
    "Restrained",
    "Speed 0; attacks against it have advantage; its attacks and Dex saves have disadvantage.",
    "187",
    { speedZero: true, own: { attack: "dis" }, dexSave: "dis", against: "adv" },
  ),
  stunned: c("Stunned", "Incapacitated; fails Str and Dex saves; attacks against it have advantage.", "189", {
    incapacitated: true,
    autoFailStrDex: true,
    against: "adv",
    implies: ["incapacitated"],
  }),
  unconscious: c(
    "Unconscious",
    "Incapacitated and Prone, Speed 0, drops what it holds; fails Str and Dex saves; attacks against it have advantage; hits within 5 ft crit.",
    "191",
    {
      speedZero: true,
      incapacitated: true,
      noSight: true,
      autoFailStrDex: true,
      against: "adv",
      critWithin5: true,
      implies: ["incapacitated", "prone"],
    },
  ),
};

/**
 * A creature's conditions with the ones they include (Unconscious: Incapacitated and Prone), each once, less any that
 * another makes it immune to (a Petrified creature's Poisoned does nothing) — what the roll hints and the rules read
 * (rules audit A5: a ranged attack from 30 ft at an Unconscious creature is a plain roll, its Advantage and the Prone
 * target's Disadvantage cancelling; A12).
 */
export function expandConditions(ids: readonly string[]): string[] {
  const out = new Set<string>();
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const x of (CONDITIONS as Record<string, ConditionInfo>)[id]?.implies ?? []) add(x);
  };
  for (const id of ids) add(id);
  for (const id of [...out])
    for (const x of (CONDITIONS as Record<string, ConditionInfo>)[id]?.immuneTo ?? []) out.delete(x);
  return [...out];
}

/**
 * What SRD 5.1 has differently (SPEC §19.3, §34.8; docs/research/rules-5.2.1.md "5.1 differences"; rules audit C2):
 * Grappled gives no Disadvantage on its attacks, Incapacitated and Invisible nothing on initiative (5.1 has no such
 * rule), and a Stunned creature can't move.
 */
const SRD51: Partial<Record<string, Partial<ConditionInfo>>> = {
  grappled: { own: {}, note: undefined },
  incapacitated: { own: {} },
  invisible: { own: { attack: "adv" } },
  stunned: { speedZero: true },
};

/** A condition's rules in the campaign's pack (SRD 5.2.1 unless it plays SRD 5.1). */
export function conditionInfo(id: string, pack?: string): ConditionInfo | undefined {
  const base = (CONDITIONS as Record<string, ConditionInfo>)[id];
  if (!base || pack !== "srd-5.1") return base;
  const d = SRD51[id];
  return d ? { ...base, ...d } : base;
}

/**
 * Why a creature can't have a condition, if it can't: its own immunity (a stat block's Condition Immunities), or one
 * a condition it has grants (Petrified: "Immunity to the Poisoned condition", SRD 5.2.1 p. 186; rules audit A12).
 */
export function immuneToCondition(
  immunities: readonly string[],
  conditions: readonly string[],
  id: string,
): "own" | string | null {
  if (immunities.includes(id)) return "own";
  for (const c of conditions)
    if ((CONDITIONS as Record<string, ConditionInfo>)[c]?.immuneTo?.includes(id as ConditionId))
      return (CONDITIONS as Record<string, ConditionInfo>)[c]?.name ?? c;
  return null;
}

export interface MarkerInfo {
  name: string;
  summary: string;
}

export const MARKERS: Record<MarkerId, MarkerInfo> = {
  bloodied: { name: "Bloodied", summary: "At half its Hit Points or fewer (no effect of its own)." },
  concentrating: {
    name: "Concentrating",
    summary:
      "Holding a spell or effect: damage calls for a Con save (DC 10 or half the damage); it ends when Incapacitated.",
  },
  deathsaves: {
    name: "Death saves",
    summary: "At 0 HP and dying: a save each turn — three successes stabilise, three failures kill.",
  },
  stable: {
    name: "Stable",
    summary: "At 0 HP but no longer dying; still Unconscious; 1 HP after 1d4 hours.",
  },
  dead: { name: "Dead", summary: "Dead." },
  hidden: { name: "Hidden", summary: "Unseen and unheard; the Stealth total is the DC to find it." },
  surprised: { name: "Surprised", summary: "Disadvantage on its initiative roll." },
  dodging: {
    name: "Dodging",
    summary: "Attacks against it have disadvantage and its Dex saves advantage, until its next turn.",
  },
  disengaged: { name: "Disengaged", summary: "Its movement provokes no opportunity attacks this turn." },
  dashing: { name: "Dashing", summary: "Extra movement equal to its Speed this turn." },
  inspiration: {
    name: "Heroic Inspiration",
    summary: "Can reroll any die it just rolled (the new roll stands).",
  },
  blessed: { name: "Blessed", summary: "Adds 1d4 to attack rolls and saving throws." },
  baned: { name: "Baned", summary: "Subtracts 1d4 from attack rolls and saving throws." },
  hasted: {
    name: "Hasted",
    summary: "Speed doubled, +2 AC, advantage on Dex saves, an extra limited action.",
  },
  slowed: {
    name: "Slowed",
    summary: "Speed halved, −2 AC and Dex saves, no reactions, one action or bonus action.",
  },
  burning: {
    name: "Burning",
    summary: "1d4 fire damage at the start of each turn; an action and going prone puts it out.",
  },
  flying: {
    name: "Flying",
    summary: "Aloft; falls if knocked Prone or its Speed drops to 0 (unless it hovers).",
  },
  readied: { name: "Readied", summary: "Holding an action for a trigger (its reaction)." },
};

/** A condition or marker's name, and its summary for tooltips. */
export function statusName(id: string): string {
  return (
    (CONDITIONS as Record<string, ConditionInfo>)[id]?.name ??
    (MARKERS as Record<string, MarkerInfo>)[id]?.name ??
    id
  );
}
export function statusSummary(id: string): string {
  return (
    (CONDITIONS as Record<string, ConditionInfo>)[id]?.summary ??
    (MARKERS as Record<string, MarkerInfo>)[id]?.summary ??
    ""
  );
}

/** A roll's automatic hints from the roller's own conditions (AC-DICE-11): each with why, removable before rolling. */
export interface RollHints {
  adv: { from: string; note?: string }[];
  dis: { from: string; note?: string }[];
  /** Exhaustion: −2 × level on every D20 Test (5.2.1). */
  penalty: number;
  /**
   * What a marker adds to the roll, a term each (rules audit Q6): Bless "+1d4" and Bane "-1d4" on attack rolls and
   * saving throws, Slow "-2" on Dexterity saves — joined to the formula (`withTerms`), not the roller's to set aside.
   */
  extra: { term: string; from: string }[];
  /** Strength and Dexterity saves fail outright (the DM can still let it roll). */
  autoFail: string[];
}

/**
 * What a creature's conditions do to one of its rolls: `kind`, and for saves the ability (Restrained's Dex saves,
 * the automatic Str/Dex failures).
 */
export function rollHints(
  conditions: readonly string[],
  exhaustion: number,
  kind: RollKind,
  ability?: string,
  /** Its markers and its Speed now, where they're known (Dodging's advantage on Dexterity saves, rules audit A10). */
  creature?: { markers: readonly string[]; speedFt?: number },
  /** The campaign's rules pack: SRD 5.1's conditions and Exhaustion table (rules audit C2). */
  pack?: string,
): RollHints {
  const out: RollHints = { adv: [], dis: [], penalty: 0, extra: [], autoFail: [] };
  // (Each condition with those it includes; Incapacitated's initiative disadvantage counted once, named for what
  // brought it.)
  let incapacitatedDis = false;
  const srd51 = pack === "srd-5.1";
  for (const id of expandConditions(conditions)) {
    const info = conditionInfo(id, pack);
    if (!info) continue;
    // (Initiative is a Dexterity check: what a condition does to ability checks, it does to initiative — rules audit A7.)
    const own = info.own[kind] ?? (kind === "initiative" ? info.own.check : undefined);
    const hint = { from: info.name, ...(info.note ? { note: info.note } : {}) };
    // Incapacitated — or a condition that includes it (Stunned, Paralyzed, Petrified, Unconscious) — gives initiative
    // disadvantage (SRD 5.2.1): once, named for the first that brings it.
    if (kind === "initiative" && info.incapacitated && !srd51) {
      if (!incapacitatedDis) out.dis.push(hint);
      incapacitatedDis = true;
    } else {
      if (own === "adv") out.adv.push(hint);
      if (own === "dis") out.dis.push(hint);
    }
    if (kind === "save" && ability === "dex" && info.dexSave === "dis") out.dis.push({ from: info.name });
    if (kind === "save" && (ability === "str" || ability === "dex") && info.autoFailStrDex)
      out.autoFail.push(info.name);
  }
  // Dodge: "you make Dexterity saving throws with Advantage" — while it holds (SRD 5.2.1 p. 181).
  if (kind === "save" && ability === "dex" && creature && dodgeHolds({ conditions, ...creature }))
    out.adv.push({ from: "Dodging" });
  if (creature) out.extra.push(...markerRollTerms(creature.markers, kind, ability, out));
  // Exhaustion: every D20 Test (attacks, ability checks, saves; initiative is a Dex check) −2 a level — or SRD 5.1's
  // table: Disadvantage on ability checks from level 1, on attack rolls and saving throws from level 3 (5.1 p. 291).
  const lvl = Math.max(0, Math.min(6, Math.trunc(exhaustion)));
  if (lvl && !srd51) out.penalty = -2 * lvl;
  if (srd51 && lvl >= 1 && (kind === "check" || kind === "initiative"))
    out.dis.push({ from: `Exhaustion ${lvl}` });
  if (srd51 && lvl >= 3 && (kind === "attack" || kind === "save"))
    out.dis.push({ from: `Exhaustion ${lvl}` });
  return out;
}

/**
 * What a spell's marker does to a roll (rules audit Q6; SRD 5.2.1): Blessed adds 1d4 to attack rolls and saving throws
 * (p. 113), Baned subtracts 1d4 from them (p. 112); Hasted has Advantage on Dexterity saves (p. 139); Slowed takes −2
 * on them (p. 163). Advantage goes into `hints.adv`; the terms come back.
 */
function markerRollTerms(
  markers: readonly string[],
  kind: RollKind,
  ability: string | undefined,
  hints: Pick<RollHints, "adv" | "dis">,
): { term: string; from: string }[] {
  const out: { term: string; from: string }[] = [];
  const attackOrSave = kind === "attack" || kind === "save";
  if (attackOrSave && markers.includes("blessed")) out.push({ term: "+1d4", from: "Blessed" });
  if (attackOrSave && markers.includes("baned")) out.push({ term: "-1d4", from: "Baned" });
  if (kind === "save" && ability === "dex") {
    if (markers.includes("hasted")) hints.adv.push({ from: "Hasted" });
    if (markers.includes("slowed")) out.push({ term: "-2", from: "Slowed" });
  }
  return out;
}

/** A creature's AC with its markers (rules audit Q6): Hasted +2 (SRD 5.2.1 p. 139), Slowed −2 (p. 163). */
export function acWithMarkers(ac: number, markers: readonly string[]): number {
  return ac + (markers.includes("hasted") ? 2 : 0) - (markers.includes("slowed") ? 2 : 0);
}

/** Why a creature can take no Reactions, from its markers (Slowed: "it can't take Reactions", p. 163), else null. */
export function reactionsBarredBy(markers: readonly string[]): string | null {
  return markers.includes("slowed") ? "Slowed" : null;
}

/**
 * Whether a creature's Dodge still protects it (SRD 5.2.1 p. 181, "Dodge"): attacks against it at a disadvantage, its
 * Dexterity saves at an advantage — "You lose these benefits if you have the Incapacitated condition or if your Speed
 * is 0" (rules audit A10). A condition that includes Incapacitated (Stunned, Paralyzed, Petrified, Unconscious) ends it
 * too; so does a Speed-0 condition (Grappled, Restrained) or a Speed of 0 by other means, where the caller knows it.
 */
export function dodgeHolds(c: {
  conditions: readonly string[];
  markers: readonly string[];
  speedFt?: number;
}): boolean {
  if (!c.markers.includes("dodging")) return false;
  const all = expandConditions(c.conditions);
  if (incapacitates(all) || speedZeroCondition(all)) return false;
  return c.speedFt === undefined || c.speedFt > 0;
}

/** An attack's hints: the attacker's and the target's, and whether a hit is a critical hit. */
export interface AttackHints extends RollHints {
  /** A hit is a critical hit — why (Paralyzed, Unconscious: any hit from within 5 ft, SRD 5.2.1 pp. 186, 191). */
  critOnHit: string | null;
}

/**
 * What an attack gets (SRD 5.2.1 §19.3; the card's attack rolls): the attacker's own conditions (Poisoned, Prone,
 * Restrained, Blinded: disadvantage; Invisible: advantage) and Exhaustion's penalty; what the target's give attackers
 * (Restrained, Stunned, Paralyzed, Blinded, Unconscious: advantage; Prone: advantage within 5 ft, else disadvantage;
 * Invisible: disadvantage — unless it's outlined, Faerie Fire p. 129; Dodging, while it holds: disadvantage; outlined:
 * advantage); and
 * a hit from within 5 ft on a Paralyzed or Unconscious creature — any attack roll, melee or ranged — is a critical hit.
 * Each hint says why; the roller can take any of them away before rolling.
 */
export function attackHints(
  attacker: {
    conditions: readonly string[];
    exhaustion: number;
    pack?: string | undefined;
    /** Its markers (Blessed's +1d4, Baned's −1d4 on the roll; rules audit Q6). */
    markers?: readonly string[];
  },
  target: {
    conditions: readonly string[];
    markers: readonly string[];
    /** It can't benefit from Invisible (outlined). */
    outlined: boolean;
    /** Attacks against it have Advantage — an outline's usual gift (Faerie Fire), not every outline's (Starry Wisp). */
    advantage?: boolean;
    speedFt?: number;
  },
  at: {
    withinFt: number;
    melee: boolean;
    /**
     * A ranged attack's circumstances (SRD 5.2.1 pp. 15–16; rules audit C6): the hostile creatures within 5 ft of the
     * attacker that can see it and can act ("Ranged Attacks in Close Combat"), and a target past the weapon's normal
     * range ("Long Range") — each Disadvantage.
     */
    closeHostiles?: readonly string[];
    beyondNormalRange?: boolean;
  },
): AttackHints {
  const out: AttackHints = {
    ...rollHints(
      attacker.conditions,
      attacker.exhaustion,
      "attack",
      undefined,
      attacker.markers ? { markers: attacker.markers } : undefined,
      attacker.pack,
    ),
    critOnHit: null,
  };
  const near = at.withinFt <= 5 + 1e-6;
  for (const id of expandConditions(target.conditions)) {
    const info = (CONDITIONS as Record<string, ConditionInfo>)[id];
    if (!info) continue;
    const from = `target ${info.name}`;
    if (info.against === "adv") out.adv.push({ from });
    else if (info.against === "adv-within-5")
      (near ? out.adv : out.dis).push({ from: `${from} (${near ? "within" : "beyond"} 5 ft)` });
    else if (info.against === "dis" && !(id === "invisible" && target.outlined))
      out.dis.push({ from, ...(info.note ? { note: info.note } : {}) });
    // Any attack roll that hits from within 5 ft — melee or not: "Any attack roll that hits you is a Critical Hit if
    // the attacker is within 5 feet of you" (SRD 5.2.1 pp. 186, 191; rules audit A6: a Fire Bolt from 5 ft counts).
    if (info.critWithin5 && near && !out.critOnHit) out.critOnHit = info.name;
  }
  if (dodgeHolds(target)) out.dis.push({ from: "target Dodging" });
  if (!at.melee) {
    if (at.closeHostiles?.length) out.dis.push({ from: `${at.closeHostiles[0]} within 5 ft` });
    if (at.beyondNormalRange) out.dis.push({ from: "long range" });
  }
  if (target.outlined && (target.advantage ?? true)) out.adv.push({ from: "target outlined" });
  return out;
}

/** The roll mode the hints add up to: advantage and disadvantage cancel (any of each), else whichever there is. */
export function hintedMode(h: Pick<RollHints, "adv" | "dis">): "normal" | "adv" | "dis" {
  if (h.adv.length && h.dis.length) return "normal";
  if (h.adv.length) return "adv";
  if (h.dis.length) return "dis";
  return "normal";
}

/**
 * Speed after conditions (§19.4): 0 with any Speed-0 condition (unless the DM lets it ignore them), or a condition
 * holding it at 0 for its while (Haste's lethargy: `speed0`); otherwise less 5 ft per Exhaustion level, never below 0 —
 * or, in SRD 5.1, halved from Exhaustion 2 and 0 from 5 (rules audit C2). Then its markers (rules audit Q6): Hasted
 * doubles it (SRD 5.2.1 p. 139), Slowed halves it (p. 163), rounded down — after Exhaustion, as Dash multiplies Speed
 * after its modifiers.
 */
export function effectiveSpeed(
  speed: number,
  conditions: readonly (string | { id: string; speed0?: boolean | undefined })[],
  exhaustion: number,
  ignoreConditionSpeed = false,
  pack?: string,
  markers: readonly string[] = [],
): number {
  const ids = conditions.map((c) => (typeof c === "string" ? c : c.id));
  if (!ignoreConditionSpeed && (speedZeroCondition(ids, pack) || heldAtZero(conditions))) return 0;
  const lvl = Math.max(0, Math.min(6, Math.trunc(exhaustion)));
  const base =
    pack === "srd-5.1"
      ? lvl >= 5
        ? 0
        : lvl >= 2
          ? Math.floor(speed / 2)
          : speed
      : Math.max(0, speed - 5 * lvl);
  const times = (markers.includes("hasted") ? 2 : 1) / (markers.includes("slowed") ? 2 : 1);
  return Math.floor(base * times);
}

/** A condition held at Speed 0 for its while (Haste's lethargy, SRD 5.2.1 p. 139), whatever it is. */
export function heldAtZero(
  conditions: readonly (string | { id: string; speed0?: boolean | undefined })[],
): boolean {
  return conditions.some((c) => typeof c !== "string" && c.speed0 === true);
}

/** The condition holding a creature's Speed at 0 (Grappled, Restrained…), if any (§8.6: "Can't move — Grappled"). */
export function speedZeroCondition(conditions: readonly string[], pack?: string): string | null {
  return conditions.find((id) => conditionInfo(id, pack)?.speedZero) ?? null;
}

/** SRD 5.1's Exhaustion 4: its hit point maximum halved (5.1 p. 291; rules audit C2). */
export const exhaustedHpMax = (hpMax: number, exhaustion: number, pack?: string): number =>
  pack === "srd-5.1" && exhaustion >= 4 ? Math.floor(hpMax / 2) : hpMax;

/**
 * Why a creature can't move at all, as the table says it (§8.6 "Can't move — Grappled"): from the code its view carries
 * — "locked" (the DM's lock), "speed0" (a Speed of 0 by other means), or the condition holding it.
 */
export function stuckName(code: string): string {
  if (code === "locked") return "Locked by the DM";
  if (code === "speed0") return "Speed 0";
  return statusName(code);
}

/**
 * Why a creature can't act (SRD 5.2.1 p. 184, Incapacitated: it "can't take any action, Bonus Action, or Reaction"):
 * the name of the first of its conditions that incapacitates it — Incapacitated, or one that includes it (Stunned,
 * Paralyzed, Petrified, Unconscious); null when none does (rules audit A11).
 */
export function cantActBecause(conditions: readonly string[]): string | null {
  for (const id of conditions) {
    const all = expandConditions([id]);
    if (all.some((x) => (CONDITIONS as Record<string, ConditionInfo>)[x]?.incapacitated))
      return (CONDITIONS as Record<string, ConditionInfo>)[id]?.name ?? null;
  }
  return null;
}

/**
 * A creature's conditions as they bear on what it does now (rules audit C7), where a condition knows its source:
 * Grappled gives no Disadvantage against its grappler ("attack rolls against any target other than the grappler", SRD
 * 5.2.1 p. 182), Frightened none while the source of the fear is out of its sight ("while the source of fear is within
 * line of sight", p. 182). A condition with no source known stands as it is (the hint's note says what it depends on).
 */
export function conditionsBearing(
  conditions: readonly { id: string; sourceTokenId?: string | undefined }[],
  at: { targetId?: string | undefined; sees?: ((tokenId: string) => boolean | null) | undefined },
): string[] {
  const out = new Set<string>();
  for (const c of conditions) {
    if (c.id === "grappled" && at.targetId && c.sourceTokenId === at.targetId) continue;
    if (c.id === "frightened" && c.sourceTokenId && at.sees?.(c.sourceTokenId) === false) continue;
    out.add(c.id);
  }
  return [...out];
}

/** Whether any condition incapacitates (it breaks concentration, §8.11). */
export const incapacitates = (conditions: readonly string[]): boolean =>
  conditions.some((id) => (CONDITIONS as Record<string, ConditionInfo>)[id]?.incapacitated);
