import type { Ability, ConditionId, DamageType } from "@gloam/shared";
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
  save: { ability: Ability; onSuccess: "half" | "none" | "special" } | null;
  dc: number | null;
  dcRevealed: boolean;
  /** An attack roll's formula ("1d20 + 7"), per target. */
  attack: { formula: string; kind: "melee" | "ranged" } | null;
  damage: {
    parts: { formula: string; type: DamageType }[];
    healing: boolean;
    /** Rolled once for every target (a save spell) or per target (an attack's hit, a dart). */
    per: "cast" | "target";
    /** The cast's roll (per "cast"). */
    roll: DamageRoll | null;
  } | null;
  /** Conditions the spell applies (on a failed save, or always). */
  conditions: {
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
  };
  attack?: { total: number; natural: number; crit: boolean; hit?: boolean | null };
  /** Its own damage (a spell attack's hit, a dart): rolled for it. */
  roll?: DamageRoll;
  /** The DM's override of full / half / none. */
  outcome?: "full" | "half" | "none";
  ignore: { resist: boolean; vuln: boolean; immune: boolean };
  /** The DM's choice of conditions to apply (absent: as the spell and the save say). */
  conditions?: ConditionId[];
  /** The DM's final number. */
  final?: number | null;
}
