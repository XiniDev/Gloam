import { z } from "zod";
import { ABILITIES, CONDITION_IDS, DAMAGE_TYPES, SIZES } from "../constants.ts";

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
  context: z.strictObject({ tokenId: Id.optional() }).optional(),
});
/** `dice.manual` (req, ≤ 5/s): a physical roll — one value per die of the formula, in order, or just its total. */
export const DiceManual = z.strictObject({
  formula: z.string().min(1).max(200, "A formula is at most 200 characters."),
  values: z.array(z.number().int().min(1).max(1000)).min(1).max(500).optional(),
  total: z.number().int().min(-100_000).max(100_000).optional(),
  label: RollLabel.optional(),
  visibility: z.enum(ROLL_VISIBILITIES).default("public"),
});
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
  path: z.array(z.union([z.string().min(1).max(60), z.number().int().min(0).max(999)])).max(8),
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
