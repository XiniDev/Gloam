/**
 * Single source of product constants. The app name lives here and only here (SPEC header: "rename freely").
 * Colour values mirror packages/web/src/styles/tokens.css; board shaders import them from here (SPEC §27.2).
 */
export const APP_NAME = "Gloam";
export const APP_VERSION = "0.1.0";

/** Network defaults (SPEC §11, Appendix J). */
export const DEFAULT_PORT = 4747;
export const DEFAULT_METRICS_PORT = 4748;
export const VITE_HMR_PORT = 24678;

/** Hard limits that both sides enforce (SPEC §13.5, §18.1, §22.1). */
export const LIMITS = {
  wsMaxPayload: 256 * 1024,
  movePreviewPoints: 64,
  moveCommitPoints: 256,
  sheetPatchOps: 200,
  batchItems: 500,
  formulaLength: 200,
  diceCountPerTerm: 100,
  diceTotal: 500,
  diceSides: 1000,
  explosionDepth: 20,
  rerollDepth: 20,
  displayNameMin: 2,
  displayNameMax: 24,
  pinMin: 4,
  pinMax: 8,
  customPhrases: 6,
  customPhraseLength: 40,
  undoStack: 200,
  historyPageSize: 200,
  assetFetchConcurrency: 6,
} as const;

/** Comparisons against movement budgets use this epsilon in feet (SPEC §8.6 Units). */
export const FT_EPSILON = 0.05;

/** 12-colour player palette (SPEC §27.2). Names are shown next to swatches (never colour-only). */
export const PLAYER_COLORS = [
  { id: "amber", name: "Amber", hex: "#E6B450" },
  { id: "sky", name: "Sky", hex: "#5FB3E6" },
  { id: "coral", name: "Coral", hex: "#E0605C" },
  { id: "mint", name: "Mint", hex: "#6CC98A" },
  { id: "orchid", name: "Orchid", hex: "#C77DDB" },
  { id: "citrine", name: "Citrine", hex: "#F2E266" },
  { id: "teal", name: "Teal", hex: "#4FD1C5" },
  { id: "rose", name: "Rose", hex: "#F08FB0" },
  { id: "periwinkle", name: "Periwinkle", hex: "#9AA7FF" },
  { id: "copper", name: "Copper", hex: "#D08B4F" },
  { id: "lime", name: "Lime", hex: "#B5D264" },
  { id: "silver", name: "Silver", hex: "#D9DEE6" },
] as const;
export type PlayerColorId = (typeof PLAYER_COLORS)[number]["id"];

/** NPC disposition ring colours (SPEC §27.2). Party tokens use the owner's player colour. */
export const DISPOSITION_COLORS = {
  friendly: "#5FBF9A",
  neutral: "#D4AF6A",
  hostile: "#E0584B",
} as const;

/** Colour-blind (Okabe–Ito derived) swaps (SPEC §27.2). */
export const CB_COLORS = {
  pathOk: "#56B4E9",
  pathOver: "#E69F00",
  hpHigh: "#009E73",
  hpMid: "#F0E442",
  hpLow: "#D55E00",
  dispHostile: "#D55E00",
  dispFriendly: "#009E73",
  dispNeutral: "#F0E442",
} as const;

/** Board colours used by shaders and WebGL overlays (mirrors of the CSS tokens). */
export const BOARD_COLORS = {
  ink950: "#07090C",
  ink900: "#0D1117",
  bone100: "#EDE6D6",
  brass300: "#E6C98B",
  brass400: "#D4AF6A",
  brass600: "#9C7A3C",
  ember400: "#F08A4B",
  blood500: "#C8413B",
  verdigris400: "#5FBF9A",
  arcane400: "#7FA7E8",
  hex400: "#B07FE0",
  ice300: "#9FDCF0",
  hpGhost: "#F4E9D8",
  hemiSky: "#1A2230",
  hemiGround: "#0A0C10",
  keyLight: "#FFD9A8",
  warFog: "#0A0F1A",
  exploredTint: "#6F86A8",
  oak: "#5A3A22",
  oakDark: "#2A1A10",
  mapPaper: "#C9B68B",
  mapInk: "#3A2A1C",
  candle: "#FFB35C",
  flameCore: "#FFF3D0",
  flameOuter: "#FF9A3C",
  flameBlue: "#6E8CFF",
  /** Table wood grain (the oak table the maps lie on). */
  oakLight: "#7A5234",
  /** Standee card edge. */
  cardboard: "#B59A72",
  /** Token base top. */
  baseInk: "#141A22",
  selectGlow: "#E6C98B",
  hoverRing: "#EDE6D6",
  /** Procedural floors (SPEC §8.3): base, variation and joint colours per style. */
  stoneA: "#6E6A63",
  stoneB: "#8A857C",
  stoneJoint: "#2B2926",
  plankA: "#6B4A2E",
  plankB: "#8A6440",
  plankJoint: "#2A1A10",
  grassA: "#3F5A2A",
  grassB: "#6B8A3A",
  grassDry: "#8A8A4A",
  sandA: "#C9A874",
  sandB: "#E1C595",
  parchmentA: "#E3D5B3",
  parchmentB: "#C4AE7E",
  parchmentStain: "#A88B5A",
  caveA: "#3A3836",
  caveB: "#5A5550",
  caveCrack: "#151413",
} as const;

/** Colour-blind swaps for dispositions and HP bands (SPEC §27.2, Okabe–Ito). */
/** A zone's default colour by kind (SPEC §8.7 Zones; the DM can change it). */
export const ZONE_COLORS = {
  difficult: BOARD_COLORS.brass600,
  water: BOARD_COLORS.arcane400,
  hazard: BOARD_COLORS.ember400,
  impassable: BOARD_COLORS.blood500,
  label: BOARD_COLORS.bone100,
} as const;
/** The colours the Zones tool offers. */
export const ZONE_SWATCHES = [
  BOARD_COLORS.brass600,
  BOARD_COLORS.arcane400,
  BOARD_COLORS.ember400,
  BOARD_COLORS.blood500,
  BOARD_COLORS.bone100,
  BOARD_COLORS.verdigris400,
  BOARD_COLORS.hex400,
  BOARD_COLORS.ice300,
] as const;

export const CB_BOARD_COLORS = {
  hostile: "#D55E00",
  friendly: "#009E73",
  neutral: "#F0E442",
  hpHigh: "#009E73",
  hpMid: "#F0E442",
  hpLow: "#D55E00",
} as const;

export const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** Damage-type colours (SPEC §27.2); healing uses verdigris. */
export const DAMAGE_TYPE_COLORS: Record<DamageType | "healing", string> = {
  acid: "#B5D33D",
  bludgeoning: "#B8B2A7",
  cold: "#7FD3F5",
  fire: "#FF7A2F",
  force: "#8FA8FF",
  lightning: "#F5E663",
  necrotic: "#8C6BB1",
  piercing: "#D9D3C7",
  poison: "#5FAE6B",
  psychic: "#F07BC8",
  radiant: "#FFD66B",
  slashing: "#E4E6EA",
  thunder: "#6FA3C9",
  healing: "#5FBF9A",
};

/** Icon badge categories (SPEC §27.2, Appendix G). */
export const BADGE_CATEGORY_COLORS = {
  senses: "#4E7BC4",
  mind: "#8E5CC8",
  body: "#A67C3D",
  incapacity: "#C8643B",
  affliction: "#5E9A4E",
  vital: "#B43A36",
  boon: "#3F9C78",
  tactical: "#56657A",
} as const;
export type BadgeCategory = keyof typeof BADGE_CATEGORY_COLORS;

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Ability = (typeof ABILITIES)[number];

export const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const;
export type Size = (typeof SIZES)[number];

/** Base diameter per size in feet (SPEC §8.5, SRD p. 14). */
export const SIZE_BASE_FT: Record<Size, number> = {
  tiny: 2.5,
  small: 5,
  medium: 5,
  large: 10,
  huge: 15,
  gargantuan: 20,
};

/** Normalised 3D mini height per size in feet (SPEC §8.5). */
export const SIZE_MINI_HEIGHT_FT: Record<Size, number> = {
  tiny: 1.5,
  small: 3.5,
  medium: 5.5,
  large: 11,
  huge: 17,
  gargantuan: 25,
};

export const SPELL_SCHOOLS = [
  "abjuration",
  "conjuration",
  "divination",
  "enchantment",
  "evocation",
  "illusion",
  "necromancy",
  "transmutation",
] as const;
export type SpellSchool = (typeof SPELL_SCHOOLS)[number];

export const VFX_PRESETS = [
  "fire",
  "cold",
  "lightning",
  "thunder",
  "acid",
  "poison",
  "necrotic",
  "radiant",
  "force",
  "psychic",
  "healing",
  "arcane",
] as const;
export type VfxPreset = (typeof VFX_PRESETS)[number];

/** The 15 SRD 5.2.1 conditions (SPEC §8.11). */
export const CONDITION_IDS = [
  "blinded",
  "charmed",
  "deafened",
  "exhaustion",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
] as const;
export type ConditionId = (typeof CONDITION_IDS)[number];

/** Status markers (SPEC §8.11). */
export const MARKER_IDS = [
  "bloodied",
  "concentrating",
  "deathsaves",
  "stable",
  "dead",
  "hidden",
  "surprised",
  "dodging",
  "disengaged",
  "dashing",
  "inspiration",
  "blessed",
  "baned",
  "hasted",
  "slowed",
  "burning",
  "flying",
  "readied",
] as const;
export type MarkerId = (typeof MARKER_IDS)[number];

export const SKILLS = {
  acrobatics: "dex",
  animalHandling: "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  sleightOfHand: "dex",
  stealth: "dex",
  survival: "wis",
} as const satisfies Record<string, Ability>;
export type SkillId = keyof typeof SKILLS;
export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

/** SRD 5.2.1 attribution statement, verbatim (SPEC Appendix I). */
export const SRD_521_ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';

/** SRD 5.1 attribution statement, verbatim (SPEC Appendix I; only used with the optional 5.1 pack). */
export const SRD_51_ATTRIBUTION =
  'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.';

/** SRD 5.2.1 spell counts per level, cantrip → 9th (SPEC §34.7). */
export const SRD_521_SPELL_COUNTS = [27, 57, 57, 42, 34, 38, 31, 20, 17, 16] as const;
export const SRD_521_SPELL_TOTAL = 339;
