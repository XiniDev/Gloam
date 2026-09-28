/**
 * What the server sends about health (SPEC §8.11): the DM's prompts (what follows from damage or a condition, a
 * player's damage to check) and the feedback everyone who can see a token gets when its HP change.
 */
import type { DamageType } from "../constants.ts";

/** One thing a prompt offers to apply (a consequence), with a choice where it has one. */
export interface PromptItemView {
  /** The consequence's kind: the key the DM keeps it by. */
  key: string;
  consequence: { kind: string; [k: string]: unknown };
  /** What applying it does, in words ("Unconscious and Prone; death saves start"). */
  label: string;
  choices?: { id: string; label: string }[];
  /** The choice preselected (a house rule's default). */
  choice?: string;
}

/** A prompt as the DMs have it. */
export interface DmPromptView {
  id: string;
  createdAt: number;
  kind: "consequences" | "playerDamage";
  /** The creature it's about (a token; a character with none on the board). */
  tokenId: string | null;
  actorId: string | null;
  name: string;
  /** "Goblin dropped to 0 HP", "Mira: concentration broken", "Dave's damage to the Goblin". */
  title: string;
  /** Why it's asked (the damage, the failed save). */
  detail?: string;
  items: PromptItemView[];
  /** A player's damage waiting on the DM: as the player sent it. */
  damage?: {
    by: string;
    byName: string;
    kind: "damage" | "heal" | "temp";
    parts?: { amount: number; type: DamageType | "untyped" }[];
    amount?: number;
    halved: boolean;
    crit: boolean;
    label?: string;
  };
  status: "open" | "applied" | "skipped";
  resolvedAt: number | null;
}

/**
 * A token's HP changed (AC-HP-11): floating numbers coloured by damage type, the hit shake and flash, the heal glow,
 * the lie-down when it goes down or dies — for everyone who can see the token.
 */
export interface HpFx {
  tokenId: string;
  kind: "damage" | "heal" | "temp";
  /** What it took or regained (temporary HP gained for "temp"). */
  amount: number;
  /** Damage by type, largest first (the floating numbers' colours). */
  parts?: { type: DamageType | "untyped"; amount: number }[];
  /** Taken by temporary HP (damage). */
  fromTemp?: number;
  down?: boolean;
  dead?: boolean;
  revived?: boolean;
}
