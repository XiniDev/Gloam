/**
 * Plain-object mirrors of the synchronised schemas (SPEC §13.3). The server's projector produces these for the
 * active scene (copied into the Colyseus state) and for DM prep scenes (sent as `prep.open` snapshots and
 * `prep.patch` messages, §13.7), so the client board consumes one shape from either source. Tagged sub-objects
 * (`hp`, `own`, `vis`, `dm`, `link`) are present only when the viewer holds that tag.
 */

export interface V2View {
  x: number;
  y: number;
}

export interface TokenHpView {
  hp: number;
  hpMax: number;
  hpTemp: number;
}

export interface TokenOwnerView {
  ac: number;
  budgetFt: number;
  usedFt: number;
  turnStart: V2View;
  mode: string;
  pips: number;
  dashes: number;
  bonusMoveFt: number;
  speedWalk: number;
  speedFly: number;
  speedSwim: number;
  speedClimb: number;
  speedBurrow: number;
  hover: boolean;
  segments: number;
  freeMovement: boolean;
  lockMovement: boolean;
  /** Why it can't move at all — a condition id ("grappled"), "speed0" or "locked" (`stuckName`) — or "" (§8.6). */
  stuck: string;
  /**
   * JSON: the effects whose slowing ground it's spared (Spirit Guardians' designated creatures) — its controllers'
   * to know; the effect itself names no creature (§13.4).
   */
  spared: string;
}

export interface TokenVisionView {
  darkvision: number;
  blindsight: number;
  tremorsense: number;
  truesight: number;
  blinded: boolean;
  unconscious: boolean;
  seeInvisible: boolean;
}

export interface TokenDmView {
  secretNote: string;
  dmHidden: boolean;
  link: string;
  overridesJson: string;
  revealJson: string;
}

export interface TokenView {
  id: string;
  actorId: string;
  /** "character" | "npc" | "unit" */
  kind: string;
  name: string;
  pos: V2View;
  elevation: number;
  rotation: number;
  /** Size category: tiny … gargantuan. */
  size: string;
  sizeFt: number;
  mode: string;
  assetId: string;
  portraitAssetId: string;
  scale: number;
  offsetY: number;
  rotOffset: number;
  tint: string;
  /** The owner's player colour for party tokens; "" → the client uses the disposition colour. */
  ringColor: string;
  disposition: string;
  ownerIds: string[];
  hpDisplay: string;
  /** 0 down … 4 healthy; 255 when HP is hidden from this display mode. */
  hpBand: number;
  /** Bar fill 0…1 in Exact/Bar modes; −1 otherwise. */
  hpFrac: number;
  tempFrac: number;
  conditions: string[];
  markers: string[];
  exhaustion: number;
  concentrating: boolean;
  prone: boolean;
  dead: boolean;
  invisibleFx: boolean;
  outlined: boolean;
  lightOn: boolean;
  reachFt: number;
  locked: boolean;
  moveSeq: number;
  pinnedBars: string[];
  /** The DM's custom markers on it: "id|label|#colour|glyph|description" (§8.11; `parseCustomMarkers`). */
  customMarkers: string[];
  hp?: TokenHpView;
  own?: TokenOwnerView;
  vis?: TokenVisionView;
  dm?: TokenDmView;
}

export interface WallView {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Player-safe kind: secret doors read "wall", hidden sight-blockers read "occluder". */
  kind: string;
  door: string;
  dmKind?: string;
  dmHidden?: boolean;
  dmDoor?: string;
}

export interface LinkView {
  tokenId: string;
  casterId: string;
}

export interface LightView {
  id: string;
  x: number;
  y: number;
  elevation: number;
  bright: number;
  dim: number;
  color: string;
  intensity: number;
  anim: string;
  coneDeg: number;
  dirDeg: number;
  magical: boolean;
  pierceDarkness: boolean;
  on: boolean;
  preset: string;
  dmOnly: boolean;
  shuttered: boolean;
  label: string;
  link?: LinkView;
}

export interface ZoneView {
  id: string;
  kind: string;
  points: V2View[];
  label: string;
  color: string;
  shapeJson: string;
  dmHidden?: boolean;
  /** `{ note, triggers }` (DMs only). */
  dmJson?: string;
}

/**
 * How an effect moves and what its caster can do with it (§8.13 "movement rules"), as the board offers it: moved by
 * its caster (up to `maxFt` a move: Moonbeam 60, Flaming Sphere 30) or only by the DM; drifting on its own
 * (Cloudkill); struck again at a point in it (`strike`: Call Lightning's bolt radius).
 */
export interface EffectControl {
  moveBy?: "caster" | "dm";
  maxFt?: number;
  drifts?: boolean;
  strike?: number;
}

export interface EffectView {
  id: string;
  shapeJson: string;
  propsJson: string;
  vfx: string;
  roundsLeft: number;
  name: string;
  /** JSON EffectControl. */
  controlJson: string;
  link?: LinkView;
  /** DMs: hidden from the players. */
  dmHidden?: boolean;
}

export interface SceneView {
  id: string;
  name: string;
  mapKind: string;
  mapAssetId: string;
  calibJson: string;
  floorJson: string;
  ambient: string;
  ambientTint: string;
  fogMode: string;
  fogCellFt: number;
  boundsJson: string;
  walls3d: boolean;
  seq: number;
}

export interface SceneCollections {
  tokens: TokenView[];
  walls: WallView[];
  lights: LightView[];
  zones: ZoneView[];
  effects: EffectView[];
}

/** `prep.open` response: a full snapshot of a non-active scene for a DM (SPEC §13.7). */
export interface PrepSnapshot extends SceneCollections {
  scene: SceneView;
  /** DM-only scene fields that aren't part of the synchronised Scene schema. */
  sceneMeta: { spawn: V2View; dmNotes: string; sort: number; archived: boolean };
}

/** `prep.patch`: changes to a prep scene since the snapshot. `scene: null` means it was deleted. */
export interface PrepPatch {
  sceneId: string;
  scene?: SceneView | null;
  sceneMeta?: PrepSnapshot["sceneMeta"];
  upsert: Partial<SceneCollections>;
  remove: { tokens?: string[]; walls?: string[]; lights?: string[]; zones?: string[]; effects?: string[] };
}

export type CollectionName = keyof SceneCollections;
export const COLLECTIONS: CollectionName[] = ["tokens", "walls", "lights", "zones", "effects"];

/** A DM's custom marker as a token carries it (§8.11). */
export interface CustomMarkerView {
  id: string;
  label: string;
  color: string;
  glyph: string;
  description: string;
}

/** A token's `customMarkers` ("id|label|#colour|glyph|description"), read. */
export function parseCustomMarkers(xs: readonly string[]): CustomMarkerView[] {
  return xs.map((s) => {
    const [id = "", label = "", color = "", glyph = "", description = ""] = s.split("|");
    return { id, label, color, glyph, description };
  });
}
