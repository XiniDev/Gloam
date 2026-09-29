/**
 * What the server sends about combat (SPEC §8.12, §13.4 "Combat tracker"): the tracker, per client — it depends on
 * what each person perceives — and the moments of a turn.
 */

/** One place in the tracker as this client may know it. */
export interface CombatViewEntry {
  /** Opaque and per client (never a token id for a combatant this client doesn't perceive). */
  key: string;
  /** Only for combatants this client perceives or controls. */
  tokenId?: string;
  name: string;
  portraitAssetId?: string;
  /** Only for combatants this client perceives or controls; absent while it hasn't been found. */
  initiative?: number;
  /** A placeholder for a combatant this client doesn't perceive ("Unknown"; only when the DM reveals the count). */
  unknown: boolean;
  /** HP as the token's display mode lets this client see it: a fraction for a bar, else a band (0 down … 4). */
  hpFrac?: number;
  hpBand?: number;
  /** This client controls it (a player's own creature). */
  mine?: boolean;
  /** Its initiative is still being found (a card out, an NPC not yet rolled). */
  pending?: boolean;
  /** DMs: its group of identical creatures (one roll), and surprised at the start. */
  group?: string;
  surprised?: boolean;
  pc?: boolean;
}

export interface CombatView {
  /** No combat on the active scene: an empty tracker. */
  active: boolean;
  /** Turns have begun (before: initiative is being found). */
  begun: boolean;
  round: number;
  entries: CombatViewEntry[];
  /** The active entry's index, or −1 when it's hidden from this client and no placeholder stands in. */
  activeIndex: number;
  /** DMs: how initiative is found, and whether everyone moves freely. */
  method?: "rollAll" | "playersRoll" | "fixed" | "skip";
  freeMovement: boolean;
}

/** A turn began (`combat.turn`), to everyone who perceives the creature. */
export interface CombatTurnMessage {
  tokenId: string;
  name: string;
  round: number;
  /** It's this client's creature: the chime, the banner, the camera if the player asked for it. */
  yours: boolean;
}

/** Something that lasted a number of rounds ran out (`combat.expired`), to the DM and the creature's controllers. */
export interface CombatExpiredMessage {
  tokenId: string | null;
  name: string;
  what: string;
}
