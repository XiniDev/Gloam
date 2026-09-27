import type { Ability, ConditionId, DamageType, MarkerId, Size, VfxPreset } from "../constants.ts";
import type { CampaignSettings, HouseRules } from "./campaign.ts";
import type { Vec2 } from "./common.ts";

/**
 * Core documents held by the server's in-memory model and persisted in SQLite (SPEC §12.3). Coordinates are
 * feet on the map plane: `x` = world X, `y` = world Z.
 */

type Ft = number;
export interface Vec3 {
  x: Ft;
  y: Ft;
  z: Ft;
}

export interface SensesT {
  darkvision: Ft;
  blindsight: Ft;
  tremorsense: Ft;
  truesight: Ft;
}
export interface SpeedsT {
  walk: Ft;
  fly: Ft;
  swim: Ft;
  climb: Ft;
  burrow: Ft;
  hover: boolean;
}
export const ZERO_SENSES: SensesT = { darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0 };
export const DEFAULT_SPEEDS: SpeedsT = { walk: 30, fly: 0, swim: 0, climb: 0, burrow: 0, hover: false };

export interface CampaignEntity {
  id: string;
  name: string;
  coverAssetId: string | null;
  rulesPack: string;
  units: "ft" | "m";
  houseRules: HouseRules;
  settings: CampaignSettings;
  activeSceneId: string | null;
  sessionNo: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export type MapKind = "image" | "model" | "procedural" | "blank";
export type FloorStyle = "stone" | "wood" | "grass" | "sand" | "parchment" | "cavern";
export type AmbientLevel = "bright" | "dim" | "dark";
export type FogMode = "off" | "painted" | "dynamic";

export interface Bounds {
  minX: Ft;
  minY: Ft;
  maxX: Ft;
  maxY: Ft;
}

export interface Calibration {
  /** Image maps: feet per source pixel. */
  ftPerPx?: number;
  /** Source image size in pixels. */
  imageW?: number;
  imageH?: number;
  /** Model maps: transform. */
  position?: Vec3;
  rotationYDeg?: number;
  scale?: number;
  /** Generate-walls slice height for GLB maps. */
  sliceFt?: number;
}

export interface SceneEntity {
  id: string;
  campaignId: string;
  name: string;
  sort: number;
  mapKind: MapKind;
  mapAssetId: string | null;
  calibration: Calibration;
  floor: { style: FloorStyle; tint?: string };
  ambient: { level: AmbientLevel; tint: string };
  fogMode: FogMode;
  fogCellFt: number;
  bounds: Bounds;
  spawn: Vec2;
  music: { preset?: string; trackId?: string } | null;
  walls3d: boolean;
  thumbnailAssetId: string | null;
  /** DM notes for the scene (never sent to players, AC-DMP-05). */
  dmNotes: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
}

export type WallKind = "wall" | "door" | "window" | "curtain" | "invisible" | "secret";
export type DoorState = "closed" | "open" | "locked";

export interface WallEntity {
  id: string;
  sceneId: string;
  a: Vec2;
  b: Vec2;
  kind: WallKind;
  doorState: DoorState | null;
  hidden: boolean;
}

export type LightAnimation = "none" | "torch" | "candle" | "pulse" | "shimmer";

export interface LightEntity {
  id: string;
  sceneId: string;
  tokenId: string | null;
  pos: Vec2;
  elevation: Ft;
  bright: Ft;
  dim: Ft;
  color: string;
  intensity: number;
  animation: LightAnimation;
  coneDeg: number | null;
  directionDeg: number;
  magical: boolean;
  pierceDarkness: boolean;
  enabled: boolean;
  dmOnly: boolean;
  preset: string | null;
  /** Hooded lantern shutter lowered (bright 0, dim 5). */
  shuttered?: boolean;
}

export type ZoneKind = "difficult" | "water" | "hazard" | "impassable" | "label";
export type ZoneShape =
  | { kind: "polygon"; points: Vec2[] }
  | { kind: "rect"; x: Ft; y: Ft; w: Ft; h: Ft }
  | { kind: "circle"; x: Ft; y: Ft; r: Ft };

export interface ZoneTrigger {
  when: "enter" | "startTurn" | "endTurn";
  label: string;
  save?: { ability: Ability; dc: number; onSuccess: "half" | "none" };
  damage?: { formula: string; type: DamageType };
}

export interface ZoneEntity {
  id: string;
  sceneId: string;
  kind: ZoneKind;
  shape: ZoneShape;
  label: string;
  color: string;
  visible: boolean;
  triggers: ZoneTrigger[];
  note: string;
}

export interface TokenStatusT {
  conditions: { id: ConditionId; source?: string; untilRound?: number; sourceTokenId?: string }[];
  markers: {
    id: MarkerId | `custom:${string}`;
    label?: string;
    untilRound?: number;
    color?: string;
    glyph?: string;
  }[];
  exhaustion: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  concentration?: { effectId?: string; spellId?: string; spellName?: string } | undefined;
  deathSaves?:
    | { successes: 0 | 1 | 2 | 3; failures: 0 | 1 | 2 | 3; stable: boolean; dead: boolean }
    | undefined;
  outlined: boolean;
  seeInvisible: boolean;
}
export const EMPTY_STATUS: TokenStatusT = {
  conditions: [],
  markers: [],
  exhaustion: 0,
  outlined: false,
  seeInvisible: false,
};

export interface TokenStats {
  hp: number;
  hpMax: number;
  hpTemp: number;
  ac: number;
  speeds: SpeedsT;
  senses: SensesT;
  saves: Partial<Record<Ability, number>>;
  dexMod: number;
  initBonus: number;
  resist: DamageType[];
  immune: DamageType[];
  vuln: DamageType[];
  conditionImmune: ConditionId[];
  reachFt: Ft;
  size: Size;
  isPC: boolean;
}

export interface TokenOverrides {
  speedOverride?: Ft;
  bonusMove?: { ft: Ft; until: "turn" | "rounds" | "removed"; rounds?: number; untilRound?: number };
  freeMovement?: boolean;
  lockMovement?: boolean;
  ignoreConditionSpeed?: boolean;
  shareVisionWith?: string[];
  countAsMovement?: boolean;
}

export type TokenMode = "model" | "standee" | "coin" | "auto";
export type Disposition = "party" | "friendly" | "neutral" | "hostile";
export type HpDisplay = "exact" | "bar" | "descriptor" | "hidden";

export interface TokenEntity {
  id: string;
  sceneId: string;
  actorId: string | null;
  link: "linked" | "unlinked";
  name: string;
  pos: Vec2;
  elevation: Ft;
  rotationDeg: number;
  sizeFt: Ft;
  appearance: {
    mode: TokenMode;
    assetId?: string;
    portraitAssetId?: string;
    scale: number;
    offsetY: Ft;
    rotationOffsetDeg: number;
    tint?: string;
  };
  ownerIds: string[];
  disposition: Disposition;
  hidden: boolean;
  revealTo: "vision" | "all" | string[];
  hpDisplay: HpDisplay;
  stats: TokenStats | null;
  status: TokenStatusT | null;
  overrides: TokenOverrides;
  lightId: string | null;
  locked: boolean;
  /** DM note per token (never sent to players). */
  dmNote: string;
  /** Movement mode selected on the action bar. */
  moveMode: "walk" | "fly" | "swim" | "climb" | "burrow";
  createdAt: number;
  updatedAt: number;
}

export type AreaShape =
  | { kind: "sphere"; origin: Vec3; radius: Ft }
  | { kind: "cylinder"; origin: Vec3; radius: Ft; height: Ft }
  | { kind: "cone"; origin: Vec3; dirDeg: number; length: Ft }
  | { kind: "cube"; origin: Vec3; dirDeg: number; size: Ft; originOnFace: boolean }
  | { kind: "line"; origin: Vec3; dirDeg: number; length: Ft; width: Ft }
  | { kind: "emanation"; sourceTokenId: string; distance: Ft }
  | {
      kind: "wall";
      points: Vec2[];
      closed: boolean;
      height: Ft;
      thickness: Ft;
      opaque: boolean;
      blocksMove: boolean;
      damagingSide?: "left" | "right" | "both";
    };

export interface EffectProps {
  difficult?: boolean;
  obscurement?: "light" | "heavy";
  magicalDarkness?: boolean;
  opaque?: boolean;
  light?: { bright: Ft; dim: Ft; color: string; magical: boolean; pierceDarkness: boolean };
  silence?: boolean;
  outline?: boolean;
}

export interface EffectTrigger {
  when: "enter" | "startTurn" | "endTurn" | "per5ft";
  save?: { ability: Ability; dc: number; onSuccess: "half" | "none" | "special" };
  damage?: { formula: string; type: DamageType };
  condition?: ConditionId;
  note?: string;
}

export interface EffectEntity {
  id: string;
  sceneId: string;
  name: string;
  source: { kind: "spell" | "feature" | "custom"; contentId?: string; casterTokenId?: string; slot?: number };
  shape: AreaShape;
  attachedTokenId: string | null;
  props: EffectProps;
  triggers: EffectTrigger[];
  concentrationTokenId: string | null;
  expires: { round: number; turnOf: string; when: "start" | "end" } | { never: true };
  visibility: "everyone" | "dm";
  vfx: VfxPreset;
  movement: {
    by: "caster" | "dm";
    maxFt?: Ft;
    drift?: { ft: Ft; direction: "awayFromCaster" | "chosen" };
  } | null;
  createdAt: number;
}
