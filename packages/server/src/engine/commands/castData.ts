import type { Ability, ConditionId, DamageType, SpellMarkerId } from "@gloam/shared";
import type { Cover } from "@gloam/shared/aoe";
import type { Spell } from "@gloam/shared/schemas";

/**
 * A resolution card's document (SPEC §8.13, §29.5): what was cast (or swung, or triggered), by whom, at whom, and
 * where each target stands — its save or attack, the damage, what it takes, what's applied. Every step on the card
 * is a command that sets a path in here, so each is undoable on its own and conflicts are per target.
 */
export interface CastData {
  kind: "spell" | "attack" | "trigger";
  /** "Fireball", "Longsword", "Moonbeam". */
  name: string;
  /** "3rd level", "cantrip", "melee attack", "start of its turn in Moonbeam". */
  subtitle: string;
  /** The spell as it was cast (a homebrew spell may change later; the card keeps what was cast). */
  spell: Spell | null;
  spellId: string | null;
  /** The level it was cast at (a slot's level; a cantrip 0). */
  level: number | null;
  /** The slot spent (the refund on Cancel), or none (a cantrip, a ritual, a free cast, an attack, a trigger). */
  spent: { actorId: string; kind: "slot" | "pact"; level: number } | null;
  caster: {
    tokenId: string | null;
    actorId: string | null;
    name: string;
  };
  /** The point the area spreads from, or the caster (the cover hint's rays start here). */
  origin: { x: number; y: number; z: number } | null;
  /** The area as placed (stored shape, §17.1), for the card's "blocked" and the VFX. */
  area: unknown;
  /** `ignoresCover`: the target gains nothing from half or three-quarters cover for this save (Sacred Flame). */
  save: { ability: Ability; onSuccess: "half" | "none" | "special"; ignoresCover?: true } | null;
  dc: number | null;
  dcRevealed: boolean;
  /** An attack roll's formula ("1d20 + 7"), per target. */
  /** `normalFt`: a weapon's normal range, where it has a long one ("80/320"): past it, Disadvantage. */
  attack: { formula: string; kind: "melee" | "ranged"; normalFt?: number } | null;
  damage: {
    parts: { formula: string; type: DamageType }[];
    healing: boolean;
    /** Rolled once for every target (a save spell) or per target (an attack's hit, a dart). */
    per: "cast" | "target";
    /** The cast's roll (per "cast"). */
    roll: DamageRoll | null;
  } | null;
  /** Markers the spell's card lands (Bane's Baned, Slow's Slowed on a failed save; rules audit Q6). */
  markers?: { id: SpellMarkerId; onFailedSave: boolean }[];
  /** Conditions the spell applies (on a failed save, or always). */
  conditions: {
    /** Until the end of the caster's next turn, the start of it, the end of the creature's own next turn. */
    until?: "casterTurnEnd" | "casterTurnStart" | "ownTurnEnd";
    /** Alternatives (one of the group is imposed), a later stage, the DM's judgement: see SpellConditionApplied. */
    choice?: string;
    stage?: number;
    pick?: boolean;
    id: ConditionId;
    onFailedSave: boolean;
    rounds?: number;
    /** Until the end of the creature's current turn (Stinking Cloud's Poisoned). */
    endsTurn?: boolean;
  }[];
  /** A failed save also ends the creature's Concentration (Sleet Storm). */
  breaksConcentration?: boolean;
  targets: CastTargetData[];
  /** The persistent effect the cast made, if any. */
  effectId: string | null;
  /**
   * A trigger's card: the cast that made its effect — what the conditions it lands are stamped with, so they end with
   * that spell (rules audit I1: Web's Restrained outlived the web).
   */
  sourceCastId?: string;
  /** Whether the caster concentrates on it. */
  concentration: boolean;
  /** The save cards sent to the players. */
  requestId: string | null;
  vfx: Spell["vfx"];
  /** The trigger it came from (an effect's). */
  trigger?: {
    effectId: string;
    when: "enter" | "startTurn" | "endTurn" | "per5ft" | "moveInto" | "action";
    note?: string;
    /** What the creatures did ("entered it", "moved 10 ft in it"): each reader's subtitle names only those it perceives. */
    verb?: string;
  };
  createdBy: string;
}

export interface DamageRoll {
  total: number;
  /** The amounts by type (the HP pipeline's instances). */
  parts: { amount: number; type: DamageType }[];
  formula: string;
  entered?: boolean;
  rollId?: string;
  crit?: boolean;
}

export interface CastTargetData {
  /** The row: its creature's id, or "id#n" for another ray or beam at the same creature (an attack of its own). */
  key: string;
  id: string;
  name: string;
  pc: boolean;
  /** Darts at it (Magic Missile: each a hit of its own, rolled together as one bigger roll). */
  times: number;
  state: "in" | "removed" | "blocked" | "applied" | "skipped";
  cover: Cover;
  save?: {
    total?: number;
    success?: boolean | null;
    pending?: boolean;
    by?: "npc" | "player" | "dm";
    autoFail?: boolean;
    /** The DM's own verdict on it (cast.set): a later DC leaves it be. */
    byHand?: boolean;
  };
  /** `rollId`: the app's roll (a die of it can be rolled again — Heroic Inspiration); `inspired`: it was. */
  attack?: {
    total: number;
    natural: number | null;
    crit: boolean;
    hit?: boolean | null;
    entered?: boolean;
    rollId?: string;
    inspired?: boolean;
    /** Its dice as they fell (the app's roll): which one Heroic Inspiration rolls again. */
    dice?: { sides: number; value: number; kept: boolean }[];
    /** The DM has called it (hit, miss, critical): Heroic Inspiration's moment — just after the roll — has passed. */
    ruled?: boolean;
  };
  /** Its own damage (a spell attack's hit, a dart): rolled for it. */
  roll?: DamageRoll;
  /** The DM's override of full / half / none. */
  outcome?: "full" | "half" | "none";
  ignore: { resist: boolean; vuln: boolean; immune: boolean };
  /** The DM's choice of conditions to apply (absent: as the spell and the save say). */
  conditions?: ConditionId[];
  /** The spell's markers this row lands, as the DM ticked them (else as its save or hit says). */
  markers?: SpellMarkerId[];
  /** The DM's final number. */
  final?: number | null;
}
