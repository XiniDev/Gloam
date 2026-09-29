/**
 * Spells, attacks and effects on the wire (SPEC §8.13, §29.5): the cast and its resolution card's steps, persistent
 * effects, homebrew and imports. Payloads are strict (unknown keys rejected); what the server sends back is a view
 * cut to its reader — the DM's whole card, the caster's parts, everyone else's one line (§13.4).
 */
import { z } from "zod";
import { type ABILITIES, CONDITION_IDS, DAMAGE_TYPES, type VFX_PRESETS } from "../constants.ts";

const Id = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z]{3}_[A-Za-z0-9]{8,32}$/);
/** A spell's id: an SRD slug ("fireball") or a homebrew spell's content id. */
const SpellRef = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i);
const Coord = z.number().finite().min(-100_000).max(100_000);
const Ft = z.number().finite().min(0).max(100_000);
const Deg = z.number().finite().min(-3600).max(3600);

/** Where an area was put (§17.1–17.2): its origin (a point in range, or the caster's base edge) and its facing. */
export const CastPlacement = z.strictObject({
  origin: z.strictObject({ x: Coord, y: Coord, z: Coord.default(0) }),
  dirDeg: Deg.default(0),
  /** One of the spell's alternative forms (Darkness on an object), by index. */
  alt: z.number().int().min(0).max(3).optional(),
  /** A wall's points as drawn (Wall of Fire): a line, or a ring when closed. */
  points: z
    .array(z.strictObject({ x: Coord, y: Coord }))
    .min(2)
    .max(24)
    .optional(),
  closed: z.boolean().optional(),
  /** The DM's own size for this cast (P2: the DM can always change the template's size). */
  size: Ft.optional(),
  /** The object or creature an emanation or light attaches to (Darkness on a coin a creature holds). */
  attachTo: Id.optional(),
});

/**
 * `spell.cast` (§8.13 Casting flow): a creature casts a spell — the slot (or a ritual, a free cast, a narrative one
 * that only posts the card), where its area goes or whom it targets, and whether to end the concentration it's
 * already holding. The server works out who's affected (§17.3); the DM adjusts on the card.
 */
export const SpellCast = z.strictObject({
  casterTokenId: Id,
  spellId: SpellRef,
  /** The slot spent: a level's regular slots or the pact's. Absent: a cantrip, a ritual or a free cast. */
  slot: z.strictObject({ level: z.number().int().min(1).max(9), kind: z.enum(["slot", "pact"]) }).optional(),
  /** A levelled spell cast without a slot, at this level (a ritual at its own; a free cast at any). */
  level: z.number().int().min(0).max(9).optional(),
  mode: z.enum(["slot", "ritual", "free"]).default("slot"),
  /** Post the card to the log and skip targeting (P2). */
  narrative: z.boolean().default(false),
  placement: CastPlacement.optional(),
  /** Creatures picked (a targeted spell; repeats for darts and rays). */
  targets: z.array(Id).max(40).optional(),
  /** The area's own source among those it affects (§17.2 "Include myself"). */
  includeSelf: z.boolean().default(false),
  /** The damage type chosen from the spell's options (Chromatic Orb). */
  damageType: z.enum(DAMAGE_TYPES).optional(),
  /** Casting a concentration spell while concentrating: yes, end the other one (§8.13 Concentration). */
  endConcentration: z.boolean().default(false),
});
export type SpellCastIn = z.input<typeof SpellCast>;

/**
 * `attack.start` (§8.13 Weapons and abilities): an attack or feature from a sheet through the same card — the
 * sheet's attack by index, the creatures it's aimed at.
 */
export const AttackStart = z.strictObject({
  tokenId: Id,
  attack: z.number().int().min(0).max(199),
  targets: z.array(Id).min(1).max(20),
});

const CastRef = { castId: Id };
/** A row on a card: its creature's id, and "#n" for a second ray at the same creature (each an attack of its own). */
const RowKey = z
  .string()
  .min(3)
  .max(44)
  .regex(/^[a-z]{3}_[A-Za-z0-9]{8,32}(#[0-9]{1,2})?$/);

/** The DM adds or removes a target (a blocked one "add anyway"). */
export const CastTarget = z.strictObject({ ...CastRef, targetId: RowKey, include: z.boolean() });

/** The DM rolls every NPC target's save with one click (§8.13 Resolution card: "NPC saves roll with one DM click"). */
export const CastNpcSaves = z.strictObject({ ...CastRef });

/** A roll on the card: an attack against a target, or the damage (or healing) — rolled, or a number entered. */
export const CastRoll = z.strictObject({
  ...CastRef,
  what: z.enum(["attack", "damage"]),
  /** Attacks and per-target damage (a spell attack's hit): whose row. */
  targetId: RowKey.optional(),
  /** Entered instead of rolled (the DM, or a physical roll). */
  entered: z.number().int().min(0).max(99_999).optional(),
  adv: z.enum(["none", "adv", "dis"]).default("none"),
});

/** The DM's edits of one target's row: its save, what it takes, the adjustments, conditions, the final number. */
export const CastSet = z.strictObject({
  ...CastRef,
  targetId: RowKey,
  saveSuccess: z.boolean().nullable().optional(),
  hit: z.boolean().nullable().optional(),
  outcome: z.enum(["full", "half", "none"]).optional(),
  /** Resistance, vulnerability, immunity: each toggleable (§8.13 "auto, each toggleable"). */
  ignore: z
    .strictObject({
      resist: z.boolean().optional(),
      vuln: z.boolean().optional(),
      immune: z.boolean().optional(),
    })
    .optional(),
  conditions: z.array(z.enum(CONDITION_IDS)).max(8).optional(),
  /** The final number, as the DM edits it (null: back to the computed one). */
  final: z.number().int().min(0).max(99_999).nullable().optional(),
});

/** Show the DC to the players (the save cards say it). */
export const CastRevealDc = z.strictObject({ ...CastRef, reveal: z.boolean() });

/** Apply what the card says — to these targets, or every one still waiting (Apply all). */
export const CastApply = z.strictObject({ ...CastRef, targets: z.array(RowKey).max(60).optional() });

/** Skip a target (it takes nothing). */
export const CastSkip = z.strictObject({ ...CastRef, targetId: RowKey });

/** Cancel the cast: the slot back, its effect gone, concentration on it ended. */
export const CastCancel = z.strictObject({ ...CastRef });

/** Close a finished card (nothing left waiting, or the DM is done with it). */
export const CastClose = z.strictObject({ ...CastRef });

/** Move an effect (Moonbeam up to 60 ft by its caster; the DM anything) and turn it. */
export const EffectMove = z.strictObject({
  effectId: Id,
  to: z.strictObject({ x: Coord, y: Coord }),
  dirDeg: Deg.optional(),
});

/** End an effect (the DM; its caster). */
export const EffectRemove = z.strictObject({ effectId: Id });

/** The DM changes an effect: who sees it, its properties, its size. */
export const EffectUpdate = z.strictObject({
  effectId: Id,
  visibility: z.enum(["everyone", "dm"]).optional(),
  size: Ft.optional(),
  props: z
    .strictObject({
      difficult: z.boolean().optional(),
      obscurement: z.enum(["light", "heavy"]).nullable().optional(),
      magicalDarkness: z.boolean().optional(),
      silence: z.boolean().optional(),
    })
    .optional(),
});

// ── views ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type CastOutcome = "full" | "half" | "none";
export type Cover = "none" | "half" | "threeQuarters" | "total";

/** A target's row as the DM has it. */
export interface CastTargetView {
  /** The row: its creature's id ("#n" for another ray at it). */
  key: string;
  id: string;
  name: string;
  /** In the list, left out by the DM, cut off by a wall (§17.3 "blocked"), applied, or skipped. */
  state: "in" | "removed" | "blocked" | "applied" | "skipped";
  /** A player's creature (its save is theirs to roll) or the DM's. */
  pc: boolean;
  cover: Cover;
  save?: {
    ability: (typeof ABILITIES)[number];
    total?: number;
    success?: boolean | null;
    /** Waiting on the player's card. */
    pending?: boolean;
    by?: "npc" | "player" | "dm";
    autoFail?: boolean;
  };
  attack?: { total?: number; natural?: number; hit?: boolean | null; crit?: boolean; ac?: number };
  /** Damage rolled for this target alone (a spell attack's hit). */
  roll?: { total: number; formula: string };
  outcome: CastOutcome;
  /** What its resistances do (auto, each toggleable). */
  adjust: {
    resist: boolean;
    vuln: boolean;
    immune: boolean;
    has: { resist: boolean; vuln: boolean; immune: boolean };
  };
  conditions: { id: string; on: boolean }[];
  /** The computed number and the DM's edit (the edit wins). */
  computed?: number;
  final?: number;
  /** HP now → after (the DM's card; §29.5 "HP 7 → 0"). */
  hp?: { now: number; max: number; after: number };
  /** Picked more than once (darts, rays). */
  times: number;
}

/** A resolution card (§8.13, §29.5). The DM's has everything; the caster's has what's theirs; players see a line. */
export interface CastView {
  id: string;
  kind: "spell" | "attack" | "trigger";
  name: string;
  /** "3rd level", "cantrip", "Longsword", "start of turn in Moonbeam". */
  subtitle: string;
  casterName: string;
  casterTokenId: string | null;
  spellId: string | null;
  slot: number | null;
  steps: ("targets" | "attacks" | "saves" | "damage" | "apply")[];
  save?: {
    ability: (typeof ABILITIES)[number];
    dc?: number;
    revealed: boolean;
    onSuccess: "half" | "none" | "special";
  };
  attack?: { bonus: string };
  damage?: {
    formula: string;
    types: string[];
    healing: boolean;
    /** Rolled once for everyone (a save spell), or per target (an attack's hit). */
    per: "cast" | "target";
    roll?: { total: number; formula: string; entered?: boolean };
  };
  targets: CastTargetView[];
  coverNote?: string;
  vfx: (typeof VFX_PRESETS)[number];
  effectId: string | null;
  status: "open" | "done" | "cancelled";
  /** What the reader may do on it. */
  can: { edit: boolean; roll: boolean; cancel: boolean };
  createdAt: number;
}

/** A cast as a line in the log and the feed, for everyone: "Mira casts Fireball (3rd level) — 4 creatures". */
export interface CastLine {
  castId: string;
  text: string;
  spellId: string | null;
  at: number;
}

/** A cast's VFX for everyone who can see where it happens (§8.13 "plays immediately for everyone who can see"). */
export interface CastFx {
  castId: string;
  preset: (typeof VFX_PRESETS)[number];
  from: { x: number; y: number; z: number } | null;
  /** The area as placed, or the creatures struck. */
  area?: unknown;
  to?: { x: number; y: number; z: number }[];
  kind: "burst" | "projectile" | "instant";
}
