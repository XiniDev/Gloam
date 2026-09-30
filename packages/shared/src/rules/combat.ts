import { CONDITIONS, type ConditionInfo, expandConditions } from "./conditions.ts";

/**
 * Combat and initiative as pure rules (SPEC §8.12, §19.4–19.5, §34.6): the order, the turn cycle, initiative and its
 * hints, identical creatures' shared rolls, movement budgets, action pips and durations. The server keeps a combat's
 * state in `combats.data_json` (CombatData) and every change goes through the command bus.
 */

export type InitiativeMethod = "rollAll" | "playersRoll" | "fixed" | "skip";
export const INITIATIVE_METHODS: readonly InitiativeMethod[] = ["rollAll", "playersRoll", "fixed", "skip"];

/** How ties in initiative break (house rule, §19.6). */
export type TieBreak = "dexThenPcs" | "dm";

export interface CombatantEntry {
  tokenId: string;
  /** Its name when it joined (the tracker's label). */
  name: string;
  /** Its initiative, or null until rolled, entered or set. */
  initiative: number | null;
  /** Dexterity modifier (ties; the unrolled go last by it). */
  dexMod: number;
  /** A player character (ties: PCs before NPCs). */
  pc: boolean;
  /** Identical creatures sharing one roll share a group key. */
  group?: string;
  /** Surprised at the start (disadvantage on its initiative). */
  surprised?: boolean;
}

/** One combatant's own turn: its movement bookkeeping (§16.5). */
export interface TurnState {
  tokenId: string;
  /** Movement spent this turn (ft). */
  usedFt: number;
  /** Dashes taken this turn. */
  dashes: number;
  /** Where it stood when the turn began — Reset puts it back exactly (prone included). */
  turnStart: { x: number; y: number; elevation: number; prone: boolean };
  /** Each move this turn: its cost (Undo refunds the last). */
  segments: { cost: number }[];
  /** Stood up this turn (its cost is in usedFt). */
  stood: boolean;
}

/** Action economy (§8.12): the used ones, as bits. */
export const PIP = { action: 1, bonus: 2, reaction: 4, object: 8 } as const;
export type PipName = keyof typeof PIP;

export interface CombatTally {
  /** HP of damage each combatant dealt and took, by token id (the summary, AC-CMB-07). */
  dealt: Record<string, number>;
  taken: Record<string, number>;
  /** Combatants that dropped to 0 HP, in order. */
  downed: string[];
}

export interface CombatData {
  method: InitiativeMethod;
  /** In tracker order (the DM may reorder); the active one is `turnIndex`. */
  combatants: CombatantEntry[];
  /** Whether turns have begun (initiative collection comes first). */
  begun: boolean;
  /** The active combatant's turn, once begun. */
  turn: TurnState | null;
  /** Everyone moves freely (the DM's switch); single tokens use their own override. */
  freeMovement: boolean;
  /** Pips used per combatant: all clear at the start of the creature's own turn (its Reaction only then). */
  pips: Record<string, number>;
  tally: CombatTally;
}

export const emptyTally = (): CombatTally => ({ dealt: {}, taken: {}, downed: [] });

/** Whether any condition incapacitates — directly or as part of another (Stunned, Paralyzed, …). */
const incapacitatedBy = (conditions: readonly string[]): string[] =>
  conditions
    .map((id) => (CONDITIONS as Record<string, ConditionInfo>)[id])
    .filter((c): c is ConditionInfo => Boolean(c?.incapacitated))
    .map((c) => c.name)
    .slice(0, 1);

/**
 * What a creature's conditions do to its ability checks — initiative is a Dexterity check (SRD 5.2.1 p. 13): Poisoned;
 * Frightened while the source of its fear is in sight (rules audit A7).
 */
const checkDisBy = (conditions: readonly string[]): string[] =>
  conditions
    .map((id) => (CONDITIONS as Record<string, ConditionInfo>)[id])
    .filter((c): c is ConditionInfo => Boolean(c && !c.incapacitated && c.own.check === "dis"))
    .map((c) => (c.note ? `${c.name} (${c.note})` : c.name));

/**
 * Initiative's automatic hints (§19.5, AC-CMB-02): Invisible → advantage; Incapacitated (or a condition that includes
 * it) → disadvantage; what gives ability checks disadvantage (Poisoned, Frightened) → disadvantage, initiative being a
 * Dexterity check; Surprised → disadvantage. Each with why; the roller may set them aside. Advantage and
 * disadvantage cancel.
 */
export function initiativeHints(
  conditions: readonly string[],
  surprised: boolean,
  /** SRD 5.1: nothing from Invisible or Incapacitated; its Exhaustion (level 1 on) gives checks — initiative too —
   * Disadvantage (rules audit C2). */
  pack?: string,
  exhaustion = 0,
): { mode: "normal" | "adv" | "dis"; adv: string[]; dis: string[] } {
  const all = expandConditions(conditions);
  const srd51 = pack === "srd-5.1";
  const adv = all.includes("invisible") && !srd51 ? ["Invisible"] : [];
  const dis = [
    ...(srd51 ? [] : incapacitatedBy(all)),
    ...checkDisBy(all),
    ...(srd51 && exhaustion >= 1 ? [`Exhaustion ${Math.min(6, Math.trunc(exhaustion))}`] : []),
    ...(surprised ? ["Surprised"] : []),
  ];
  const mode = adv.length && dis.length ? "normal" : adv.length ? "adv" : dis.length ? "dis" : "normal";
  return { mode, adv, dis };
}

/** The initiative roll (§19.5): `1d20 + initMod`, with the hint's word. */
export function initiativeFormula(initMod: number, mode: "normal" | "adv" | "dis"): string {
  const m = Math.trunc(initMod);
  const base = m === 0 ? "1d20" : `1d20 ${m < 0 ? "-" : "+"} ${Math.abs(m)}`;
  return mode === "normal" ? base : `${base} ${mode}`;
}

/** Fixed initiative (2024 optional rule): 10 + initMod, +5 with advantage, −5 with disadvantage. */
export function fixedInitiative(initMod: number, mode: "normal" | "adv" | "dis"): number {
  return 10 + Math.trunc(initMod) + (mode === "adv" ? 5 : mode === "dis" ? -5 : 0);
}

/** A creature's name without a trailing number ("Goblin 3" → "goblin"): identical Quick Units share it. */
const baseName = (name: string) =>
  name
    .trim()
    .replace(/\s*#?\d+$/, "")
    .toLowerCase();

/**
 * Identical NPCs (§8.12, AC-CMB-03): one roll per group. Identical means the same creature — unlinked tokens of the same
 * actor (a Bestiary entry spawned several times) — or, for tokens with no actor, the same name before any number and
 * the same Dex modifier. PCs never group. Returns token id → group key for the tokens in a group of two or more.
 */
export function groupIdentical(
  creatures: readonly {
    tokenId: string;
    actorId: string | null;
    linked: boolean;
    name: string;
    dexMod: number;
    pc: boolean;
  }[],
): Map<string, string> {
  const byKey = new Map<string, string[]>();
  for (const c of creatures) {
    if (c.pc || c.linked) continue;
    const key = c.actorId ? `actor:${c.actorId}` : `name:${baseName(c.name)}|${c.dexMod}`;
    byKey.set(key, [...(byKey.get(key) ?? []), c.tokenId]);
  }
  const out = new Map<string, string>();
  for (const [key, ids] of byKey) if (ids.length > 1) for (const id of ids) out.set(id, key);
  return out;
}

/**
 * The tracker's order (§8.12, AC-CMB-10): initiative descending; the unrolled last, by Dex modifier; ties by Dex
 * modifier, then PCs before NPCs, then name — or, under "the DM decides", in the order they already stand (the DM
 * drags them). Stable.
 */
export function orderCombatants(entries: readonly CombatantEntry[], ties: TieBreak): CombatantEntry[] {
  const index = new Map(entries.map((e, i) => [e.tokenId, i]));
  return [...entries].sort((a, b) => {
    const ai = a.initiative;
    const bi = b.initiative;
    if (ai === null && bi !== null) return 1;
    if (bi === null && ai !== null) return -1;
    if (ai !== null && bi !== null && ai !== bi) return bi - ai;
    if (ties === "dm" && ai !== null) return (index.get(a.tokenId) ?? 0) - (index.get(b.tokenId) ?? 0);
    if (a.dexMod !== b.dexMod) return b.dexMod - a.dexMod;
    if (a.pc !== b.pc) return a.pc ? -1 : 1;
    const n = a.name.localeCompare(b.name);
    return n || (index.get(a.tokenId) ?? 0) - (index.get(b.tokenId) ?? 0);
  });
}

/** The next or previous turn: the round goes up after the last combatant and back before the first. */
export function stepTurn(
  at: { index: number; round: number },
  count: number,
  dir: 1 | -1,
): { index: number; round: number } {
  if (count <= 0) return { index: 0, round: at.round };
  let index = at.index + dir;
  let round = at.round;
  if (index >= count) {
    index = 0;
    round++;
  } else if (index < 0) {
    if (round <= 1) return { index: 0, round: 1 };
    index = count - 1;
    round--;
  }
  return { index, round };
}

/**
 * Delay (§8.12): the combatant moves later in the order — to just after `after` (a token id), keeping its initiative
 * slot out of the sort (a delayed creature acts where it chose). Returns the new order.
 */
export function moveAfter(
  order: readonly CombatantEntry[],
  tokenId: string,
  after: string,
): CombatantEntry[] {
  const me = order.find((e) => e.tokenId === tokenId);
  if (!me || tokenId === after) return [...order];
  const rest = order.filter((e) => e.tokenId !== tokenId);
  const at = rest.findIndex((e) => e.tokenId === after);
  if (at < 0) return [...order];
  return [...rest.slice(0, at + 1), me, ...rest.slice(at + 1)];
}

/** Bonus movement a DM granted (§8.19, AC-MOV-18). */
export interface BonusMove {
  ft: number;
  until: "turn" | "rounds" | "removed";
  rounds?: number;
  /** For "rounds": the last round it counts in; for "turn": the round of the turn it was given for. */
  untilRound?: number;
}

/** Whether bonus movement still counts in `round` (a "this turn" grant: only in the round it was given). */
export function bonusMoveActive(b: BonusMove | undefined, round: number): boolean {
  if (!b || b.ft <= 0) return false;
  if (b.until === "removed") return true;
  if (b.untilRound === undefined) return true;
  return round <= b.untilRound;
}

/**
 * A turn's movement budget (§19.4): speed after conditions and Exhaustion, times (1 + dashes), plus DM bonus movement
 * (never doubled by Dash).
 */
export function turnBudget(speed: number, dashes: number, bonusFt: number): number {
  return Math.max(0, speed) * (1 + Math.max(0, dashes)) + Math.max(0, bonusFt);
}

/** What's left of it. */
export const remainingFt = (budget: number, usedFt: number): number => Math.max(0, budget - usedFt);

/** Standing up from Prone costs half the creature's (walking) speed, rounded down (§19.4, SRD p. 190). */
export const standUpCost = (walkSpeed: number): number => Math.floor(Math.max(0, walkSpeed) / 2);

/** Toggle a pip. */
export const togglePip = (pips: number, pip: PipName): number => pips ^ PIP[pip];

/**
 * A duration measured in rounds from its creator's turn (§8.12, AC-CMB-09): it expires at the start or end of the
 * creator's turn in `round`. Given the moment now (a turn start or end of `turnOf` in `round`), whether it has.
 */
export function durationExpired(
  expires: { round: number; turnOf: string; when: "start" | "end" },
  now: { round: number; turnOf: string; when: "start" | "end" },
): boolean {
  if (now.round > expires.round) return true;
  if (now.round < expires.round) return false;
  if (now.turnOf !== expires.turnOf) return false;
  return expires.when === "start" || now.when === "end";
}

/**
 * "Lasts N rounds" given on `turnOf`'s turn in `round`: it ends at the start of that creature's turn N rounds on
 * (SRD: "until the start of your next turn" is 1).
 */
export const roundsFrom = (
  round: number,
  turnOf: string,
  n: number,
): { round: number; turnOf: string; when: "start" } => ({
  round: round + Math.max(1, Math.trunc(n)),
  turnOf,
  when: "start",
});
