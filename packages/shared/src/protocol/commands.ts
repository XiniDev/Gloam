import { z } from "zod";
import { CONDITION_IDS, DAMAGE_TYPES, SIZES } from "../constants.ts";

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

export type SceneCreate = z.infer<typeof SceneCreate>;
export type SceneUpdate = z.infer<typeof SceneUpdate>;
export type TokenCreate = z.infer<typeof TokenCreate>;
export type TokenUpdate = z.infer<typeof TokenUpdate>;
