import { schema, t } from "@colyseus/schema";

/**
 * Synchronised state shared by the server and the browser (SPEC §13.3). Keep every schema under 63 fields
 * (G3). View tags are bitmasks — powers of two (G4). `.view()` collections are per client and are `undefined`
 * on a client until the server first adds an item to its view.
 */

export const TAG_HP = 1; // exact HP numbers: DMs, the token's controllers, and players when HP display is Exact
export const TAG_OWNER = 2; // controller-only numbers: AC, movement budget, speeds, turn start
export const TAG_VISION = 4; // senses: controllers, players the token's vision is shared with, DMs
export const TAG_DM = 8; // DM-only fields
export const TAG_LINK = 16; // token links of carried lights and attached effects: only while perceivable

export const V2 = schema({ x: t.float32(), y: t.float32() }, "V2");

export const Presence = schema(
  {
    userId: t.string(),
    name: t.string(),
    color: t.string(),
    role: t.string(), // "admin" | "dm" | "player" | "spectator"
    online: t.boolean(),
    handRaised: t.boolean(),
    spectator: t.boolean(),
    diceSkin: t.string(), // JSON DiceSkin, visible to everyone (AC-DICE-07)
  },
  "Presence",
);

export const TokenHp = schema({ hp: t.int32(), hpMax: t.int32(), hpTemp: t.int32() }, "TokenHp");

export const TokenOwner = schema(
  {
    ac: t.int16(),
    budgetFt: t.float32(),
    usedFt: t.float32(),
    turnStart: V2,
    mode: t.string(),
    pips: t.uint8(), // bitmask: 1 action, 2 bonus action, 4 reaction, 8 object interaction (used)
    dashes: t.uint8(),
    bonusMoveFt: t.float32(),
    speedWalk: t.float32(),
    speedFly: t.float32(),
    speedSwim: t.float32(),
    speedClimb: t.float32(),
    speedBurrow: t.float32(),
    hover: t.boolean(),
    segments: t.uint16(),
    freeMovement: t.boolean(),
    lockMovement: t.boolean(),
  },
  "TokenOwner",
);

export const TokenVision = schema(
  {
    darkvision: t.float32(),
    blindsight: t.float32(),
    tremorsense: t.float32(),
    truesight: t.float32(),
    blinded: t.boolean(),
    unconscious: t.boolean(),
    seeInvisible: t.boolean(),
  },
  "TokenVision",
);

export const TokenDm = schema(
  {
    secretNote: t.string(),
    dmHidden: t.boolean(),
    link: t.string(),
    overridesJson: t.string(),
    revealJson: t.string(),
  },
  "TokenDm",
);

export const Token = schema(
  {
    id: t.string(),
    actorId: t.string(),
    kind: t.string(), // "character" | "npc" | "unit"
    name: t.string(),
    pos: V2,
    elevation: t.float32(),
    rotation: t.float32(),
    size: t.string(), // size category (mini height; SPEC §8.5)
    sizeFt: t.float32(),
    mode: t.string(),
    assetId: t.string(),
    portraitAssetId: t.string(),
    scale: t.float32(),
    offsetY: t.float32(),
    rotOffset: t.float32(),
    tint: t.string(),
    ringColor: t.string(),
    disposition: t.string(),
    ownerIds: t.array("string"),
    hpDisplay: t.string(),
    hpBand: t.uint8(), // 0 down, 1 critical, 2 bloodied, 3 hurt, 4 healthy
    hpFrac: t.float32(), // per display rules (bar and exact modes); −1 when hidden
    tempFrac: t.float32(),
    conditions: t.array("string"),
    markers: t.array("string"),
    exhaustion: t.uint8(),
    concentrating: t.boolean(),
    prone: t.boolean(),
    dead: t.boolean(),
    invisibleFx: t.boolean(),
    outlined: t.boolean(),
    lightOn: t.boolean(),
    reachFt: t.float32(),
    locked: t.boolean(),
    moveSeq: t.uint32(),
    pinnedBars: t.array("string"), // "label|value|max" for counters pinned to the token
    customMarkers: t.array("string"), // "id|label|#colour|glyph|description", the DM's custom markers (§8.11)
    hp: t.ref(TokenHp).view(TAG_HP),
    own: t.ref(TokenOwner).view(TAG_OWNER),
    vis: t.ref(TokenVision).view(TAG_VISION),
    dm: t.ref(TokenDm).view(TAG_DM),
  },
  "Token",
);

/** Tremorsense marker; `id` is per viewer and opaque. */
export const Sensed = schema({ id: t.string(), pos: V2 }, "Sensed");

export const Wall = schema(
  {
    id: t.string(),
    ax: t.float32(),
    ay: t.float32(),
    bx: t.float32(),
    by: t.float32(),
    // players: secret doors arrive as kind "wall", door ""; hidden sight-blocking walls as kind "occluder"
    kind: t.string(),
    door: t.string(),
    dmKind: t.string().view(TAG_DM),
    dmHidden: t.boolean().view(TAG_DM),
    /** The true door state (secret and hidden doors send players nothing in `door`). */
    dmDoor: t.string().view(TAG_DM),
  },
  "Wall",
);

export const LinkS = schema({ tokenId: t.string(), casterId: t.string() }, "Link");

export const LightS = schema(
  {
    id: t.string(),
    x: t.float32(),
    y: t.float32(),
    elevation: t.float32(),
    bright: t.float32(),
    dim: t.float32(),
    color: t.string(),
    intensity: t.float32(),
    anim: t.string(),
    coneDeg: t.float32(),
    dirDeg: t.float32(),
    magical: t.boolean(),
    pierceDarkness: t.boolean(),
    on: t.boolean(),
    preset: t.string(),
    /** A DM vision aid (players never receive it; DMs leave it out of the players' fog they draw). */
    dmOnly: t.boolean(),
    /** A hooded lantern's hood is down (its radii already say so). */
    shuttered: t.boolean(),
    link: t.ref(LinkS).view(TAG_LINK), // carried lights: the server moves x/y with the carrier
  },
  "Light",
);

export const ZoneS = schema(
  {
    id: t.string(),
    kind: t.string(),
    points: t.array(V2),
    label: t.string(),
    color: t.string(),
    shapeJson: t.string(),
    /** DMs: hidden from players (`visible: false`). */
    dmHidden: t.boolean().view(TAG_DM),
    /** DMs: the zone's note and hazard triggers, as JSON. */
    dmJson: t.string().view(TAG_DM),
  },
  "Zone",
);

export const EffectS = schema(
  {
    id: t.string(),
    shapeJson: t.string(),
    propsJson: t.string(),
    vfx: t.string(),
    roundsLeft: t.int16(),
    name: t.string(),
    link: t.ref(LinkS).view(TAG_LINK), // attached token and caster, only while perceivable
  },
  "Effect",
);

export const CombatS = schema({ active: t.boolean(), round: t.uint16(), turnSeq: t.uint32() }, "Combat");

export const SceneS = schema(
  {
    id: t.string(),
    name: t.string(),
    mapKind: t.string(),
    mapAssetId: t.string(),
    calibJson: t.string(),
    floorJson: t.string(),
    ambient: t.string(),
    ambientTint: t.string(),
    fogMode: t.string(),
    fogCellFt: t.float32(),
    boundsJson: t.string(),
    walls3d: t.boolean(),
    seq: t.uint32(), // increments on every activation (drives the travel transition)
  },
  "Scene",
);

export const Table = schema(
  {
    campaignId: t.string(),
    campaignName: t.string(),
    units: t.string(),
    rulesPack: t.string(),
    sessionNo: t.uint16(),
    presence: t.map(Presence),
    scene: SceneS, // the ACTIVE scene only; DM prep scenes use prep.open (§13.7)
    tokens: t.map(Token).view(),
    sensed: t.map(Sensed).view(),
    walls: t.map(Wall).view(),
    lights: t.map(LightS).view(),
    zones: t.map(ZoneS).view(),
    effects: t.map(EffectS).view(),
    combat: CombatS,
    musicJson: t.string(),
    ambienceJson: t.string(),
    houseRulesJson: t.string(),
    settingsJson: t.string(),
  },
  "Table",
);

/** Lobby (waiting room). Each pending client sees only its own knock; Admin/DMs see all (AC-AUTH-06). */
export const Knock = schema(
  {
    sessionId: t.string(),
    userId: t.string(),
    name: t.string(),
    color: t.string(),
    status: t.string(), // "pending" | "admitted" | "denied" | "banned"
    identity: t.string(), // "new" | "pin" | "device" | "unverified"
    deviceLabel: t.string(),
    knockedAt: t.float64(),
  },
  "Knock",
);

export const LobbyState = schema(
  {
    knocks: t.map(Knock).view(),
  },
  "LobbyState",
);

export type TableState = InstanceType<typeof Table>;
export type TokenState = InstanceType<typeof Token>;
export type WallState = InstanceType<typeof Wall>;
export type LightState = InstanceType<typeof LightS>;
export type ZoneState = InstanceType<typeof ZoneS>;
export type EffectState = InstanceType<typeof EffectS>;
export type PresenceState = InstanceType<typeof Presence>;
export type KnockState = InstanceType<typeof Knock>;
export type LobbyStateT = InstanceType<typeof LobbyState>;
export * from "./views.ts";
