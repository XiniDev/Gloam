import type { SfxName } from "./recipes.ts";

/** How a sound's visual counterpart shows (SPEC §8.22: "a toast, badge or animation"). */
export type VisualKind = "toast" | "badge" | "animation" | "card" | "banner";

/**
 * Every sound's visual counterpart (SPEC §8.22 "Visual equivalents for sound"; AC-A11Y-05): what is on screen whenever
 * it plays, for a player with the sound off, muted or hard of hearing. Typed by the recipes, so a sound added without
 * one doesn't build; each names what shows it (and holds with reduced motion — the shakes stop, what's named here
 * doesn't).
 */
export const SOUND_VISUALS: Record<SfxName, { kind: VisualKind; shows: string }> = {
  diceTrayResin: {
    kind: "animation",
    shows: "The 3D dice tumbling on the board (their roll card in the feed)",
  },
  diceTrayGemstone: {
    kind: "animation",
    shows: "The 3D dice tumbling on the board (their roll card in the feed)",
  },
  diceTrayMetal: {
    kind: "animation",
    shows: "The 3D dice tumbling on the board (their roll card in the feed)",
  },
  diceTrayBone: {
    kind: "animation",
    shows: "The 3D dice tumbling on the board (their roll card in the feed)",
  },
  diceTrayObsidian: {
    kind: "animation",
    shows: "The 3D dice tumbling on the board (their roll card in the feed)",
  },
  diceDieResin: { kind: "animation", shows: "Two dice meeting as they tumble" },
  diceDieGemstone: { kind: "animation", shows: "Two dice meeting as they tumble" },
  diceDieMetal: { kind: "animation", shows: "Two dice meeting as they tumble" },
  diceDieBone: { kind: "animation", shows: "Two dice meeting as they tumble" },
  diceDieObsidian: { kind: "animation", shows: "Two dice meeting as they tumble" },
  diceSettle: { kind: "card", shows: "The roll card's total appearing as the dice come to rest" },
  nat20: { kind: "card", shows: "The natural 20 on the roll card in gold" },
  nat1: { kind: "card", shows: "The natural 1 on the roll card in ember" },
  yourTurn: { kind: "banner", shows: 'The "Your turn" banner' },
  turnPass: { kind: "animation", shows: "The tracker's active portrait moving on to the next creature" },
  knock: { kind: "toast", shows: "The knock card with Admit, As spectator and Deny" },
  admitted: { kind: "animation", shows: "The waiting room's \"You're in\" and the table opening" },
  chime: { kind: "card", shows: "The request or prompt card that arrives with it" },
  tick: { kind: "animation", shows: "Not played at the table (a /dev/sounds sample): nothing to show" },
  tokenPickUp: { kind: "animation", shows: "The token lifting under the pointer" },
  tokenPutDown: { kind: "animation", shows: "The token settling on its square" },
  footstep: { kind: "animation", shows: "The token gliding along its path" },
  doorOpen: { kind: "animation", shows: "The door's leaf swinging open (its handle's state)" },
  doorClose: { kind: "animation", shows: "The door's leaf swinging shut" },
  lockRattle: { kind: "toast", shows: '"The door is locked" (and its lock shaking, without reduced motion)' },
  initiativeStart: { kind: "banner", shows: "The initiative tracker appearing across the top" },
  meleeHit: { kind: "animation", shows: "The red flash on the creature hit, and its damage number" },
  damage: { kind: "animation", shows: "The floating damage number and the HP bar draining" },
  heal: { kind: "animation", shows: "The green glow and the floating healing number" },
  down: { kind: "badge", shows: "The creature falling, and its Unconscious or Dead badge" },
  deathSaveSuccess: { kind: "card", shows: "A heart filling on the death-save card" },
  deathSaveFail: { kind: "card", shows: "A skull filling on the death-save card" },
  conditionVital: {
    kind: "badge",
    shows: "The condition's badge on the token and its name in the hover card",
  },
  conditionIncapacity: {
    kind: "badge",
    shows: "The condition's badge on the token and its name in the hover card",
  },
  conditionBody: {
    kind: "badge",
    shows: "The condition's badge on the token and its name in the hover card",
  },
  conditionAffliction: {
    kind: "badge",
    shows: "The condition's badge on the token and its name in the hover card",
  },
  conditionTactical: {
    kind: "badge",
    shows: "The condition's badge on the token and its name in the hover card",
  },
  conditionSenses: {
    kind: "badge",
    shows: "The condition's badge on the token and its name in the hover card",
  },
  conditionMind: {
    kind: "badge",
    shows: "The condition's badge on the token and its name in the hover card",
  },
  conditionBoon: {
    kind: "badge",
    shows: "The condition's badge on the token and its name in the hover card",
  },
  spellCast: { kind: "animation", shows: "The spell's cast glow at its caster, and its resolution card" },
  fire: { kind: "animation", shows: "The spell's fire effect on the board" },
  cold: { kind: "animation", shows: "The spell's frost effect on the board" },
  lightning: { kind: "animation", shows: "The spell's lightning effect on the board" },
  thunder: { kind: "animation", shows: "The spell's thunder wave on the board" },
  acid: { kind: "animation", shows: "The spell's acid effect on the board" },
  poison: { kind: "animation", shows: "The spell's poison cloud on the board" },
  necrotic: { kind: "animation", shows: "The spell's necrotic effect on the board" },
  radiant: { kind: "animation", shows: "The spell's radiant effect on the board" },
  force: { kind: "animation", shows: "The spell's force effect on the board" },
  psychic: { kind: "animation", shows: "The spell's psychic effect on the board" },
  emotePop: { kind: "animation", shows: "The emote popping over the sender's token or portrait" },
  ping: { kind: "animation", shows: "The ping's ripple on the board" },
  handRaised: { kind: "badge", shows: "The hand badge on the player's portrait, and a toast for the DM" },
  handoutReveal: { kind: "card", shows: "The handout unrolling over the table" },
  sceneTravel: { kind: "animation", shows: "The scene transition: the map turning over to the next" },
  error: { kind: "toast", shows: "The error message beside the field that was wrong" },
};
