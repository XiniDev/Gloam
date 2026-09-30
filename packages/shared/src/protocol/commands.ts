import { z } from "zod";
import { ABILITIES, CONDITION_IDS, DAMAGE_TYPES, MARKER_IDS, SIZES, SKILL_IDS } from "../constants.ts";
import { isSafeKey } from "../safeKeys.ts";

/** Command payload schemas (SPEC §13.5). All strict: unknown keys are rejected (AC-SEC-01). */

const Id = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z]{3}_[A-Za-z0-9]{8,32}$/);
const Ft = z.number().finite().min(0).max(100_000);
const Coord = z.number().finite().min(-100_000).max(100_000);
export const Vec2In = z.strictObject({ x: Coord, y: Coord });
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Name = z.string().trim().min(1).max(80);

export const FLOOR_STYLES = ["stone", "wood", "grass", "sand", "parchment", "cavern"] as const;

export const SceneCreate = z.strictObject({
  name: Name,
  mapKind: z.enum(["image", "model", "procedural", "blank"]),
  mapAssetId: z.string().max(40).optional(),
  floorStyle: z.enum(FLOOR_STYLES).optional(),
  widthFt: z.number().min(10).max(5000).optional(),
  heightFt: z.number().min(10).max(5000).optional(),
  /** Image maps: calibration as pixels per 5 ft (presets 50/70/100/140/200). */
  pxPer5ft: z.number().min(5).max(2000).optional(),
  fogMode: z.enum(["off", "painted", "dynamic"]).optional(),
  ambient: z.enum(["bright", "dim", "dark"]).optional(),
});

export const SceneUpdate = z.strictObject({
  sceneId: Id,
  name: Name.optional(),
  ambientLevel: z.enum(["bright", "dim", "dark"]).optional(),
  ambientTint: Hex.optional(),
  fogMode: z.enum(["off", "painted", "dynamic"]).optional(),
  floorStyle: z.enum(FLOOR_STYLES).optional(),
  walls3d: z.boolean().optional(),
  spawn: Vec2In.optional(),
  bounds: z.strictObject({ minX: Coord, minY: Coord, maxX: Coord, maxY: Coord }).optional(),
  dmNotes: z.string().max(20_000).optional(),
  music: z
    .strictObject({ preset: z.string().max(40).optional(), trackId: z.string().max(40).optional() })
    .nullable()
    .optional(),
});

export const SceneCalibrate = z.union([
  z.strictObject({ sceneId: Id, ftPerPx: z.number().positive().max(100) }),
  z.strictObject({
    sceneId: Id,
    transform: z.strictObject({
      position: z.strictObject({ x: Coord, y: Coord, z: Coord }),
      rotationYDeg: z.number().min(-360).max(360),
      scale: z.number().positive().max(1000),
    }),
    /** Generate walls' slice height, remembered per 3D map (SPEC §8.3: 5 ft, configurable 1–20 ft). */
    sliceFt: z.number().min(1).max(20).optional(),
  }),
]);

export const SceneRef = z.strictObject({ sceneId: Id });
export const SceneReorder = z.strictObject({ order: z.array(Id).max(500) });

export const TokenStatsIn = z.strictObject({
  hp: z.number().int().min(-9999).max(99_999),
  hpMax: z.number().int().min(0).max(99_999),
  hpTemp: z.number().int().min(0).max(99_999).default(0),
  ac: z.number().int().min(0).max(99),
  speeds: z
    .strictObject({
      walk: Ft.max(5000),
      fly: Ft.max(5000).default(0),
      swim: Ft.max(5000).default(0),
      climb: Ft.max(5000).default(0),
      burrow: Ft.max(5000).default(0),
      hover: z.boolean().default(false),
    })
    .default({ walk: 30, fly: 0, swim: 0, climb: 0, burrow: 0, hover: false }),
  senses: z
    .strictObject({
      darkvision: Ft.max(5000).default(0),
      blindsight: Ft.max(5000).default(0),
      tremorsense: Ft.max(5000).default(0),
      truesight: Ft.max(5000).default(0),
    })
    .default({ darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0 }),
  saves: z
    .partialRecord(z.enum(["str", "dex", "con", "int", "wis", "cha"]), z.number().int().min(-20).max(40))
    .default({}),
  dexMod: z.number().int().min(-10).max(20).default(0),
  initBonus: z.number().int().min(-20).max(40).default(0),
  resist: z.array(z.enum(DAMAGE_TYPES)).max(13).default([]),
  immune: z.array(z.enum(DAMAGE_TYPES)).max(13).default([]),
  vuln: z.array(z.enum(DAMAGE_TYPES)).max(13).default([]),
  conditionImmune: z.array(z.enum(CONDITION_IDS)).max(15).default([]),
  reachFt: Ft.max(100).default(5),
  size: z.enum(SIZES).optional(),
  isPC: z.boolean().default(false),
});

/**
 * Patch shapes for `token.update`. Deliberately separate from the create schemas: zod 4 applies `.default()`
 * values inside `.partial()`, so a partial of a defaulted schema would silently reset every omitted field.
 */
const DamageTypes = z.array(z.enum(DAMAGE_TYPES)).max(13);
export const TokenStatsPatch = z.strictObject({
  hp: z.number().int().min(-9999).max(99_999).optional(),
  hpMax: z.number().int().min(0).max(99_999).optional(),
  hpTemp: z.number().int().min(0).max(99_999).optional(),
  ac: z.number().int().min(0).max(99).optional(),
  speeds: z
    .strictObject({
      walk: Ft.max(5000).optional(),
      fly: Ft.max(5000).optional(),
      swim: Ft.max(5000).optional(),
      climb: Ft.max(5000).optional(),
      burrow: Ft.max(5000).optional(),
      hover: z.boolean().optional(),
    })
    .optional(),
  senses: z
    .strictObject({
      darkvision: Ft.max(5000).optional(),
      blindsight: Ft.max(5000).optional(),
      tremorsense: Ft.max(5000).optional(),
      truesight: Ft.max(5000).optional(),
    })
    .optional(),
  saves: z
    .partialRecord(z.enum(["str", "dex", "con", "int", "wis", "cha"]), z.number().int().min(-20).max(40))
    .optional(),
  dexMod: z.number().int().min(-10).max(20).optional(),
  initBonus: z.number().int().min(-20).max(40).optional(),
  resist: DamageTypes.optional(),
  immune: DamageTypes.optional(),
  vuln: DamageTypes.optional(),
  conditionImmune: z.array(z.enum(CONDITION_IDS)).max(15).optional(),
  reachFt: Ft.max(100).optional(),
  isPC: z.boolean().optional(),
});

export const AppearancePatch = z.strictObject({
  mode: z.enum(["model", "standee", "coin", "auto"]).optional(),
  assetId: z.string().max(40).nullable().optional(),
  portraitAssetId: z.string().max(40).nullable().optional(),
  scale: z.number().positive().max(100).optional(),
  offsetY: z.number().min(-100).max(100).optional(),
  rotationOffsetDeg: z.number().min(-360).max(360).optional(),
  tint: Hex.nullable().optional(),
});

export const Appearance = z.strictObject({
  mode: z.enum(["model", "standee", "coin", "auto"]),
  assetId: z.string().max(40).optional(),
  portraitAssetId: z.string().max(40).optional(),
  scale: z.number().positive().max(100).default(1),
  offsetY: z.number().min(-100).max(100).default(0),
  rotationOffsetDeg: z.number().min(-360).max(360).default(0),
  tint: Hex.optional(),
});

export const TokenCreate = z.strictObject({
  sceneId: Id,
  name: Name,
  pos: Vec2In,
  elevation: z.number().min(-1000).max(10_000).default(0),
  size: z.enum(SIZES).default("medium"),
  sizeFt: Ft.max(200).optional(),
  disposition: z.enum(["party", "friendly", "neutral", "hostile"]).default("hostile"),
  appearance: Appearance.default({ mode: "auto", scale: 1, offsetY: 0, rotationOffsetDeg: 0 }),
  hpDisplay: z.enum(["exact", "bar", "descriptor", "hidden"]).optional(),
  stats: TokenStatsIn.optional(),
  actorId: Id.optional(),
  link: z.enum(["linked", "unlinked"]).optional(),
  ownerIds: z.array(Id).max(20).default([]),
  hidden: z.boolean().default(false),
});

export const TokenUpdate = z.strictObject({
  tokenId: Id,
  name: Name.optional(),
  elevation: z.number().min(-1000).max(10_000).optional(),
  rotationDeg: z.number().min(-3600).max(3600).optional(),
  size: z.enum(SIZES).optional(),
  sizeFt: Ft.max(200).optional(),
  disposition: z.enum(["party", "friendly", "neutral", "hostile"]).optional(),
  appearance: AppearancePatch.optional(),
  hpDisplay: z.enum(["exact", "bar", "descriptor", "hidden"]).optional(),
  stats: TokenStatsPatch.optional(),
  ownerIds: z.array(Id).max(20).optional(),
  hidden: z.boolean().optional(),
  revealTo: z.union([z.enum(["vision", "all"]), z.array(Id).max(20)]).optional(),
  locked: z.boolean().optional(),
  dmNote: z.string().max(20_000).optional(),
  /** Vision sharing (SPEC §8.8): players who also see what this token sees (DM). */
  shareVisionWith: z.array(Id).max(20).optional(),
  /**
   * Per-token overrides (SPEC §8.19, DM): a speed override; bonus movement for this turn, N rounds or until removed
   * (§19.4, never doubled by Dash); free movement in combat; movement locked; condition speed effects ignored; a DM's
   * move counted against the budget. null clears one.
   */
  overrides: z
    .strictObject({
      speedOverride: Ft.max(1000).nullable().optional(),
      bonusMove: z
        .strictObject({
          ft: Ft.max(1000),
          until: z.enum(["turn", "rounds", "removed"]),
          rounds: z.number().int().min(1).max(100).optional(),
        })
        .nullable()
        .optional(),
      freeMovement: z.boolean().optional(),
      lockMovement: z.boolean().optional(),
      ignoreConditionSpeed: z.boolean().optional(),
      countAsMovement: z.boolean().optional(),
    })
    .optional(),
});

export const TokenPlace = z.strictObject({
  tokenId: Id,
  pos: Vec2In,
  elevation: z.number().min(-1000).max(10_000).optional(),
});
export const TokenDelete = z.strictObject({ tokenIds: z.array(Id).min(1).max(500) });
export const TokenDuplicate = z.strictObject({
  tokenIds: z.array(Id).min(1).max(100),
  offset: Vec2In.optional(),
  at: Vec2In.optional(),
});

/** Controller commands (SPEC §13.5): raise/lower in 5-ft steps, face a direction. */
export const TokenElevation = z.strictObject({
  tokenId: Id,
  elevation: z.number().min(-1000).max(10_000).optional(),
  delta: z.number().min(-1000).max(1000).optional(),
});
export const TokenFacing = z.strictObject({
  tokenId: Id,
  rotationDeg: z.number().min(-3600).max(3600).optional(),
  delta: z.number().min(-360).max(360).optional(),
});

export const WALL_KINDS = ["wall", "door", "window", "curtain", "invisible", "secret"] as const;
export const WallIn = z.strictObject({
  a: Vec2In,
  b: Vec2In,
  kind: z.enum(WALL_KINDS).default("wall"),
  doorState: z.enum(["closed", "open", "locked"]).nullable().optional(),
  hidden: z.boolean().default(false),
});
/** `wall.create`: one or many segments (batches ≤ 500, SPEC §13.5). */
export const WallCreate = z.strictObject({ sceneId: Id, walls: z.array(WallIn).min(1).max(500) });
export const WallPatch = z.strictObject({
  wallId: Id,
  a: Vec2In.optional(),
  b: Vec2In.optional(),
  kind: z.enum(WALL_KINDS).optional(),
  doorState: z.enum(["closed", "open", "locked"]).nullable().optional(),
  hidden: z.boolean().optional(),
});
/**
 * `wall.update`: one wall, or many at once (≤ 500) — moving a joint shared by several walls, or a bulk kind change,
 * is one atomic, undoable edit. A wall an edit collapses to a point is removed.
 */
export const WallUpdate = z.union([WallPatch, z.strictObject({ walls: z.array(WallPatch).min(1).max(500) })]);
export const WallDelete = z.strictObject({ wallIds: z.array(Id).min(1).max(500) });
/** `wall.split`: a joint on the wall at (the point on it nearest to) `at`; the two halves keep its properties. */
export const WallSplit = z.strictObject({ wallId: Id, at: Vec2In });
/** `wall.join`: two walls sharing an endpoint become one, from the far end of the first to the far end of the second. */
export const WallJoin = z.strictObject({ wallIds: z.tuple([Id, Id]) });
/**
 * `door.toggle` (SPEC §8.7 Doors): open/close for players whose token is within 5 ft of the door; DMs also lock and
 * unlock, anywhere. "toggle" opens a shut door and shuts an open one.
 */
export const DoorToggle = z.strictObject({
  wallId: Id,
  action: z.enum(["toggle", "open", "close", "lock", "unlock"]).default("toggle"),
});

export const ZONE_KINDS = ["difficult", "water", "hazard", "impassable", "label"] as const;
export const ZoneShapeIn = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("polygon"), points: z.array(Vec2In).min(3).max(256) }),
  z.strictObject({ kind: z.literal("rect"), x: Coord, y: Coord, w: Ft.min(0.1), h: Ft.min(0.1) }),
  z.strictObject({ kind: z.literal("circle"), x: Coord, y: Coord, r: Ft.min(0.1) }),
]);
export const ZoneTriggerIn = z.strictObject({
  when: z.enum(["enter", "startTurn", "endTurn"]),
  label: z.string().trim().min(1).max(80),
  save: z
    .strictObject({
      ability: z.enum(ABILITIES),
      dc: z.number().int().min(1).max(40),
      onSuccess: z.enum(["half", "none"]),
    })
    .optional(),
  damage: z
    .strictObject({ formula: z.string().trim().min(1).max(60), type: z.enum(DAMAGE_TYPES) })
    .optional(),
});
export const ZoneIn = z.strictObject({
  kind: z.enum(ZONE_KINDS),
  shape: ZoneShapeIn,
  label: z.string().trim().max(80).default(""),
  color: Hex.optional(),
  visible: z.boolean().default(true),
  triggers: z.array(ZoneTriggerIn).max(6).default([]),
  note: z.string().max(2000).default(""),
});
// ── Fog (SPEC §8.8 DM fog tools, §15.8) ──
/** Whom a fog operation is for: every player (`all`) or one player (a user id). */
export const FogTarget = z.union([z.literal("all"), Id]);
export const FogShapeIn = z.discriminatedUnion("kind", [
  /** A brush stroke: circles of `radius` along the points. */
  z.strictObject({
    kind: z.literal("brush"),
    points: z.array(Vec2In).min(1).max(4000),
    radius: Ft.min(0.25).max(100),
  }),
  z.strictObject({ kind: z.literal("rect"), x: Coord, y: Coord, w: Ft.min(0.1), h: Ft.min(0.1) }),
  z.strictObject({ kind: z.literal("polygon"), points: z.array(Vec2In).min(3).max(512) }),
  /** Reveal room: the region enclosed by sight-blocking walls around the point. */
  z.strictObject({ kind: z.literal("room"), x: Coord, y: Coord }),
  /** Reveal all / Hide all. */
  z.strictObject({ kind: z.literal("all") }),
]);
/** `fog.paint` (DM): reveal or hide part of a scene's painted fog for all players or one. */
export const FogPaint = z.strictObject({
  sceneId: Id,
  mode: z.enum(["reveal", "hide"]),
  target: FogTarget,
  shape: FogShapeIn,
});
/** `fog.resetExplored` (DM): forget explored memory for one player or everyone (SPEC §8.8, AC-VIS-14). */
export const FogResetExplored = z.strictObject({ sceneId: Id, userId: Id.optional() });

// ── Lights (SPEC §8.8 Light) ──
export const LIGHT_ANIMATIONS = ["none", "torch", "candle", "pulse", "shimmer"] as const;
const LightFields = z.strictObject({
  bright: Ft.max(1000),
  dim: Ft.max(1000),
  color: Hex,
  intensity: z.number().finite().min(0).max(4),
  animation: z.enum(LIGHT_ANIMATIONS),
  /** A cone's full angle (e.g. 53.13 for a bullseye lantern); null for all around. */
  coneDeg: z.number().finite().min(1).max(359).nullable(),
  directionDeg: z.number().finite().min(-3600).max(3600),
  magical: z.boolean(),
  pierceDarkness: z.boolean(),
  enabled: z.boolean(),
  dmOnly: z.boolean(),
  elevation: z.number().finite().min(-1000).max(10_000),
  /** Its name in the DM's lists ("" clears it). */
  label: z.string().trim().max(60),
});
/** `light.create` (DM): a free-standing light, or one carried by a token; `preset` fills radii from §34.3. */
export const LightCreate = LightFields.partial().extend({
  sceneId: Id,
  pos: Vec2In.optional(),
  tokenId: Id.optional(),
  preset: z.string().max(40).optional(),
});
/** `light.update` (DM): any field; the hood of a hooded lantern (`shuttered`). */
export const LightUpdate = LightFields.partial().extend({
  lightId: Id,
  pos: Vec2In.optional(),
  shuttered: z.boolean().optional(),
  preset: z.string().max(40).nullable().optional(),
});
export const LightDelete = z.strictObject({ lightIds: z.array(Id).min(1).max(200) });
/** `light.toggle` (DM, or the owners of the token carrying it): on/off, and a hooded lantern's hood. */
export const LightToggle = z.strictObject({
  lightId: Id,
  enabled: z.boolean().optional(),
  shuttered: z.boolean().optional(),
});
/** `light.carry` (DM, or the token's owners): give the token a light from a preset, or none (`preset: null`). */
export const LightCarry = z.strictObject({ tokenId: Id, preset: z.string().max(40).nullable() });

/** `zone.create` (DM): one zone (SPEC §8.7 Zones). */
export const ZoneCreate = ZoneIn.extend({ sceneId: Id });
export const ZoneUpdate = z.strictObject({
  zoneId: Id,
  kind: z.enum(ZONE_KINDS).optional(),
  shape: ZoneShapeIn.optional(),
  label: z.string().trim().max(80).optional(),
  color: Hex.optional(),
  visible: z.boolean().optional(),
  triggers: z.array(ZoneTriggerIn).max(6).optional(),
  note: z.string().max(2000).optional(),
});
export const ZoneDelete = z.strictObject({ zoneIds: z.array(Id).min(1).max(500) });

export const MOVE_MODES = ["walk", "fly", "swim", "climb", "burrow"] as const;
/**
 * `move.commit` (SPEC §13.5, §16.5): a token's move along a path the client previewed — routed, freehand or through
 * waypoints. Points in feet, the first within 0.5 ft of the token; `elevations` (one per point) for flying.
 */
export const MoveCommit = z.strictObject({
  tokenId: Id,
  points: z.array(Vec2In).min(2).max(256),
  mode: z.enum(MOVE_MODES).default("walk"),
  elevations: z.array(z.number().finite().min(-1000).max(10_000)).max(256).optional(),
});
/** `move.preview` (msg, ≤ 15/s): the path a controller is dragging, relayed to everyone who can see the token. */
export const MovePreview = z.strictObject({
  tokenId: Id,
  points: z.array(Vec2In).max(64),
  cost: z.number().finite().min(0).max(100_000),
});

// ── Dice (SPEC §8.9, §18) ──
export const ROLL_VISIBILITIES = ["public", "dm", "blind", "self"] as const;
const RollLabel = z.string().trim().max(60);
/** `dice.roll` (req, ≤ 5/s): the server rolls a formula (§18.1) — players Public / Private to DM / Self, DMs Public
 * or Private; `context.tokenId` resolves `@` references from that token. */
export const DiceRoll = z.strictObject({
  formula: z.string().min(1).max(200, "A formula is at most 200 characters."),
  label: RollLabel.optional(),
  visibility: z.enum(ROLL_VISIBILITIES).default("public"),
  purpose: z.string().max(40).optional(),
  /** Rolled for a creature: its token, or its character sheet (a roll from the sheet) — `@` references answer from it. */
  context: z.strictObject({ tokenId: Id.optional(), actorId: Id.optional() }).optional(),
});
/** `dice.manual` (req, ≤ 5/s): a physical roll — one value per die of the formula, in order, or just its total. */
export const DiceManual = z.strictObject({
  formula: z.string().min(1).max(200, "A formula is at most 200 characters."),
  values: z.array(z.number().int().min(1).max(1000)).min(1).max(500).optional(),
  total: z.number().int().min(-100_000).max(100_000).optional(),
  label: RollLabel.optional(),
  visibility: z.enum(ROLL_VISIBILITIES).default("public"),
});
/**
 * Roll requests (SPEC §8.9 Roll requests, §18.5; AC-DICE-06): the DM asks creatures — tokens or characters — for a
 * check (an ability, or a skill), a save, an attack or any formula, with an optional DC (hidden unless shown),
 * advantage, and who sees the results (Blind: only the DM sees the numbers).
 */
export const RequestCreate = z.strictObject({
  targets: z.array(Id).min(1).max(30),
  type: z.enum(["check", "save", "attack", "custom"]),
  ability: z.enum(ABILITIES).optional(),
  skill: z.enum(SKILL_IDS as [string, ...string[]]).optional(),
  formula: z.string().min(1).max(200).optional(),
  label: RollLabel.optional(),
  dc: z.number().int().min(1).max(50).optional(),
  showDc: z.boolean().default(false),
  adv: z.enum(["none", "adv", "dis"]).default("none"),
  visibility: z.enum(["public", "dm", "blind"]).default("public"),
});
/** A target's controller answers: the server rolls, or a physical roll is entered, or it's skipped. */
export const RequestRespond = z.strictObject({
  requestId: Id,
  target: Id,
  action: z.enum(["roll", "manual", "skip"]),
  values: z.array(z.number().int().min(1).max(1000)).min(1).max(40).optional(),
  total: z.number().int().min(-1000).max(1000).optional(),
  /** The roller sets aside the advantage or disadvantage their conditions suggest (AC-DICE-11). */
  ignoreHints: z.boolean().optional(),
});
/** The DM answers for a target: rolls with its modifiers, sets the result, or skips it. */
export const RequestAnswer = z.strictObject({
  requestId: Id,
  target: Id,
  action: z.enum(["roll", "set", "skip"]),
  total: z.number().int().min(-1000).max(1000).optional(),
  ignoreHints: z.boolean().optional(),
});
export const RequestClose = z.strictObject({ requestId: Id });

// ── HP, conditions and death (SPEC §8.11) ───────────────────────────────────────────────────────────────────

/** One damage instance: an amount and its type (untyped when none). */
export const DamagePartIn = z.strictObject({
  amount: z.number().int().min(-9999).max(99_999),
  type: z.enum([...DAMAGE_TYPES, "untyped"]),
});
/**
 * Damage, healing or temporary HP for one or more creatures (tokens): the server works out each one's result with
 * the §19.2 pipeline — or takes the DM's edited total for a target — and what follows from it (§19.1: at once under
 * Auto, as prompts under Assist).
 */
export const HpApply = z.strictObject({
  targets: z.array(Id).min(1).max(40),
  kind: z.enum(["damage", "heal", "temp"]),
  parts: z.array(DamagePartIn).min(1).max(12).optional(),
  amount: z.number().int().min(0).max(99_999).optional(),
  halved: z.boolean().default(false),
  crit: z.boolean().default(false),
  /** The DM's edit of what a target takes (the preview changed before applying). */
  totals: z.record(Id, z.number().int().min(0).max(99_999)).optional(),
  /** Temporary HP when some are there already (they don't stack): keep, replace, or the higher. */
  tempChoice: z.enum(["keep", "replace", "best"]).default("best"),
  label: z.string().trim().max(80).optional(),
  /**
   * The DM's decisions about what follows, made in the preview before applying (AC-HP-12): per target, the
   * consequences kept (by kind) and a choice where one is offered (an NPC at 0 HP: dead / unconscious / keep).
   * Targets it names get no prompt; a player's are ignored.
   */
  decide: z
    .record(
      Id,
      z.strictObject({
        keep: z.array(z.string().max(40)).max(12),
        choices: z.record(z.string().max(40), z.string().max(20)).optional(),
      }),
    )
    .optional(),
});
/** A status id: a condition, a marker, or a DM's custom marker. */
const StatusId = z.union([
  z.enum(CONDITION_IDS),
  z.enum(MARKER_IDS),
  z.string().regex(/^custom:[a-z0-9-]{1,32}$/, "a custom marker id like custom:blessing-of-kord"),
]);
/** Conditions and markers on a creature (a token: its character's for a linked one), exhaustion, concentration. */
export const StatusChange = z
  .strictObject({
    tokenId: Id.optional(),
    actorId: Id.optional(),
    add: z
      .array(
        z.strictObject({
          id: StatusId,
          source: z.string().trim().max(80).optional(),
          untilRound: z.number().int().min(1).max(100_000).optional(),
          /** Custom markers: what they're called, their colour, glyph and what they mean (§8.11). */
          label: z.string().trim().max(40).optional(),
          description: z.string().trim().max(120).optional(),
          color: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .optional(),
          glyph: z.string().max(40).optional(),
        }),
      )
      .max(20)
      .optional(),
    remove: z.array(z.string().max(80)).max(40).optional(),
    exhaustion: z.number().int().min(0).max(6).optional(),
    /** What it's concentrating on (null: no longer). */
    concentration: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .refine((v) => Boolean(v.tokenId) !== Boolean(v.actorId), "A token or a character, one of them.");
/**
 * The DM's answer to a prompt: apply it (only the items kept, by their keys; a choice where an item offers one) or
 * skip it. For a player's damage put to the DM: the total as the DM edits it, and what follows as decided.
 */
export const PromptResolve = z.strictObject({
  promptId: Id,
  apply: z.boolean(),
  keep: z.array(z.string().max(40)).max(20).optional(),
  choices: z.record(z.string().max(40), z.string().max(20)).optional(),
  total: z.number().int().min(0).max(99_999).optional(),
});
/** What follows from a change of HP (rules/consequences.ts), as the server carries it to apply. */
export const ConsequenceIn = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("down"), conditions: z.array(z.enum(CONDITION_IDS)).max(4) }),
  z.strictObject({
    kind: z.literal("deathSaveFailures"),
    n: z.union([z.literal(1), z.literal(2)]),
    failures: z.number().int().min(0).max(3),
  }),
  z.strictObject({ kind: z.literal("dying"), reason: z.enum(["failures", "massive", "exhaustion"]) }),
  z.strictObject({ kind: z.literal("npcAtZero"), choice: z.enum(["dead", "unconscious", "keep"]) }),
  z.strictObject({ kind: z.literal("concentrationSave"), dc: z.number().int().min(10).max(30) }),
  z.strictObject({ kind: z.literal("concentrationEnds"), reason: z.string().max(80) }),
  z.strictObject({ kind: z.literal("revive") }),
  z.strictObject({ kind: z.literal("bloodied"), on: z.boolean() }),
]);
/**
 * `health.consequences` (internal: run by the room for the DM's answer to a prompt, a failed concentration save or a
 * death save): what follows, applied to a creature's status as it is now — one undoable step.
 */
export const HealthConsequences = z
  .strictObject({
    tokenId: Id.optional(),
    actorId: Id.optional(),
    items: z
      .array(z.strictObject({ consequence: ConsequenceIn, choice: z.string().max(20).optional() }))
      .max(12),
    /** Death saves as they now stand (a death save's roll), and HP regained (a natural 20: 1 HP). */
    deathSaves: z
      .strictObject({ successes: z.number().int().min(0).max(3), failures: z.number().int().min(0).max(3) })
      .optional(),
    stable: z.boolean().optional(),
    regain: z.number().int().min(1).max(99_999).optional(),
    summary: z.string().max(200),
  })
  .refine((v) => Boolean(v.tokenId) !== Boolean(v.actorId), "A token or a character, one of them.");
/**
 * A short or long rest for the chosen characters (§8.11 Rests; AC-HP-13), each with the items the DM kept from its
 * preview (rules/rests.ts): one undoable command.
 */
export const RestApply = z.strictObject({
  kind: z.enum(["short", "long"]),
  actors: z.record(Id, z.array(z.string().max(20)).max(12)),
});
/** `rest.hitDie` (internal): a Hit Die spent on a short rest, and the HP its roll brought. */
export const RestHitDie = z.strictObject({
  actorId: Id,
  die: z.enum(["d6", "d8", "d10", "d12"]),
  heal: z.number().int().min(1).max(999),
});
/** Outside combat: the DM asks the dying for a death saving throw (§8.11). */
export const DeathSaveRequest = z.strictObject({ targets: z.array(Id).min(1).max(20) });

// ── Combat (SPEC §8.12, §16.5) ─────────────────────────────────────────────────────────────────────────────

const Initiative = z.number().int().min(-20).max(60);
export const INITIATIVE_METHOD_IDS = ["rollAll", "playersRoll", "fixed", "skip"] as const;
/**
 * `combat.start` (DM): the participants (tokens on the active scene), how initiative is found, one roll per group of
 * identical NPCs or not, and who is surprised.
 */
export const CombatStart = z.strictObject({
  participants: z.array(Id).min(1).max(100),
  method: z.enum(INITIATIVE_METHOD_IDS),
  group: z.boolean().default(false),
  surprised: z.array(Id).max(100).default([]),
});
/** `combat.quickStart` (DM): every creature on the scene not hidden, the campaign's default method, no dialog. */
export const CombatQuickStart = z.strictObject({});
/** Commands on the running combat with nothing more to say (stop, next, previous, begin, roll the NPCs). */
export const CombatNone = z.strictObject({});
/** `combat.endTurn` (the active combatant's controller, or the DM). */
export const CombatEndTurn = z.strictObject({ tokenId: Id });
/** `combat.set` (DM): a combatant's initiative. */
export const CombatSet = z.strictObject({ tokenId: Id, initiative: Initiative });
/** `combat.reorder` (DM): the tracker in a new order (a drag) — every combatant, once. */
export const CombatReorder = z.strictObject({ order: z.array(Id).min(1).max(100) });
/** `combat.delay` (DM): a combatant acts later — just after another. */
export const CombatDelay = z.strictObject({ tokenId: Id, after: Id });
/** `combat.add` (DM): creatures joining (each asked for initiative). */
export const CombatAdd = z.strictObject({ tokenIds: z.array(Id).min(1).max(100) });
/** `combat.remove` (DM). */
export const CombatRemove = z.strictObject({ tokenId: Id });
/** `combat.initiative` (internal): initiatives found — rolled, entered, fixed — and whether turns begin now. */
export const CombatInitiative = z.strictObject({
  values: z.record(Id, Initiative),
  begin: z.boolean().default(false),
});
/** `combat.freeMovement` (DM): everyone moves freely, or not. */
export const CombatFreeMovement = z.strictObject({ on: z.boolean() });
/** `combat.pip` (the combatant's controller or the DM): an action pip used or not. */
export const CombatPip = z.strictObject({
  tokenId: Id,
  pip: z.enum(["action", "bonus", "reaction", "object"]),
  used: z.boolean(),
});
/** `combat.rollRemaining` (DM, a message): the NPCs still without initiative rolled — the players' too if asked. */
export const CombatRollRemaining = z.strictObject({ players: z.boolean().default(false) });
/** `move.reset`, `move.dash`, `move.stand` (the active combatant's controller, or the DM). */
export const MoveTurn = z.strictObject({ tokenId: Id });
export type CombatStart = z.infer<typeof CombatStart>;
export type DiceRoll = z.infer<typeof DiceRoll>;
export type DiceManual = z.infer<typeof DiceManual>;

const Hex6 = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "a colour like #2B3A55");
/** Your dice skin (SPEC §8.9 Dice skins): everyone sees your rolls in it (AC-DICE-07). */
export const ProfileDiceSkin = z.strictObject({
  body: Hex6,
  number: Hex6,
  material: z.enum(["resin", "gemstone", "metal", "bone", "obsidian"]),
});
export type ProfileDiceSkin = z.infer<typeof ProfileDiceSkin>;

export const MEASURE_SHAPES = ["ruler", "radius", "cone", "line", "cube"] as const;
const Elev = z.number().finite().min(-1000).max(10_000);
/**
 * `measure.share` (SPEC §8.6 Measurement tools): a finished measurement, shown to the others for 3 s. Points carry
 * elevation (a ruler between flying tokens measures in 3D).
 */
export const MeasureShare = z.strictObject({
  shape: z.enum(MEASURE_SHAPES),
  points: z
    .array(z.strictObject({ x: Coord, y: Coord, z: Elev.default(0) }))
    .min(2)
    .max(32),
  widthFt: z.number().finite().min(0.5).max(1000).optional(),
});

/** `ping.send` (SPEC §8.18 Ping): a point on the table everyone sees ring in the sender's colour. */
export const PingSend = z.strictObject({ x: Coord, y: Coord });

/** DM Spotlight (SPEC §8.4): pull opted-in players' cameras to a point over 600 ms. */
export const CameraSpotlight = z.strictObject({ x: z.number().finite(), y: z.number().finite() });

export type SceneCreate = z.infer<typeof SceneCreate>;
export type SceneUpdate = z.infer<typeof SceneUpdate>;
/**
 * Link or unlink a token from its character (SPEC §8.5 Linked and unlinked tokens; AC-TOK-13): unlinking copies the
 * current values into the token; relinking replaces the token's own values with the sheet's — refused as `CONFLICT`
 * (with what would be lost) unless `overwrite` says the DM agreed.
 */
export const TokenSetLink = z.strictObject({
  tokenId: Id,
  link: z.enum(["linked", "unlinked"]),
  overwrite: z.boolean().default(false),
});
export type TokenCreate = z.infer<typeof TokenCreate>;
export type MoveCommit = z.infer<typeof MoveCommit>;
export type MovePreview = z.infer<typeof MovePreview>;
export type TokenUpdate = z.infer<typeof TokenUpdate>;

// ── Character sheets (SPEC §8.10) ──────────────────────────────────────────────────────────────────────────

/** One change to a sheet: where (object keys and list indices) and the new value there (absent: remove it). */
export const SheetChangeIn = z.strictObject({
  // (Never __proto__, constructor or prototype: a path through them reaches Object.prototype — safeKeys.ts.)
  path: z
    .array(
      z.union([
        z.string().min(1).max(60).refine(isSafeKey, "not a sheet field"),
        z.number().int().min(0).max(999),
      ]),
    )
    .max(8),
  after: z.unknown(),
});
const SheetChanges = z.array(SheetChangeIn).min(1).max(200);

export const ActorCreate = z.strictObject({
  kind: z.enum(["character", "npc"]).default("character"),
  /** A player's own character (players may only create their own). */
  ownerUserId: Id.nullable().optional(),
  /** A whole sheet document (an import); validated against the sheet schema. */
  sheet: z.unknown().optional(),
  /** Start from a template's custom blocks. */
  templateId: Id.optional(),
});
/** Quick create (AC-SHEET-01): a playable character in one dialog. */
export const ActorQuickCreate = z.strictObject({
  name: Name,
  /** "Fighter 3", "Rogue 2 / Wizard 3". */
  classLevel: z.string().trim().max(80).default(""),
  hpMax: z.number().int().min(1).max(9999),
  ac: z.number().int().min(0).max(99),
  speed: Ft.max(1000).default(30),
  darkvision: Ft.max(1000).default(0),
  portraitAssetId: Id.optional(),
  tokenAssetId: Id.optional(),
  ownerUserId: Id.nullable().optional(),
  templateId: Id.optional(),
});
/** Edits applied onto the sheet as it is now (concurrent edits to other fields aren't lost). */
export const ActorChange = z.strictObject({ actorId: Id, changes: SheetChanges });
/** Replace the whole sheet (an import over an existing character, after its preview). */
export const ActorReplace = z.strictObject({ actorId: Id, sheet: z.unknown() });
/** A player's change to locked fields, for the DM to approve. */
export const ActorPropose = z.strictObject({
  actorId: Id,
  changes: SheetChanges,
  note: z.string().max(500).default(""),
});
export const ProposalDecide = z.strictObject({
  proposalId: Id,
  approve: z.boolean(),
  note: z.string().max(500).default(""),
});
export const ActorSetLock = z.strictObject({ actorId: Id, level: z.enum(["unlocked", "core", "full"]) });
export const ActorSetOwner = z.strictObject({ actorId: Id, ownerUserId: Id.nullable() });
export const ActorDelete = z.strictObject({ actorId: Id });
/** Save a sheet's custom-block layout as a template (AC-SHEET-04). */
export const TemplateSave = z.strictObject({ name: Name, fromActorId: Id });
export const TemplateDelete = z.strictObject({ templateId: Id });
