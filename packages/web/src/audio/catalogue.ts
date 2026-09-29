import type { SfxName } from "./recipes.ts";

/** Every built-in sound event (SPEC §31), grouped and named as the audition page lists them. */
export const SOUND_GROUPS: { title: string; sounds: { name: SfxName; label: string }[] }[] = [
  {
    title: "Dice",
    sounds: [
      { name: "diceTrayResin", label: "Die hits tray · resin" },
      { name: "diceTrayGemstone", label: "Die hits tray · gemstone" },
      { name: "diceTrayMetal", label: "Die hits tray · metal" },
      { name: "diceTrayBone", label: "Die hits tray · bone" },
      { name: "diceTrayObsidian", label: "Die hits tray · obsidian" },
      { name: "diceDieResin", label: "Die hits die" },
      { name: "diceSettle", label: "Dice settle" },
      { name: "nat20", label: "Natural 20" },
      { name: "nat1", label: "Natural 1" },
    ],
  },
  {
    title: "Turns and the lobby",
    sounds: [
      { name: "yourTurn", label: "Your turn" },
      { name: "turnPass", label: "Turn passes" },
      { name: "knock", label: "Knock" },
      { name: "admitted", label: "Admitted" },
      { name: "chime", label: "Notification" },
      { name: "tick", label: "Tick" },
    ],
  },
  {
    title: "Tokens, movement and doors",
    sounds: [
      { name: "tokenPickUp", label: "Token picked up" },
      { name: "tokenPutDown", label: "Token put down" },
      { name: "footstep", label: "Footstep" },
      { name: "doorOpen", label: "Door opens" },
      { name: "doorClose", label: "Door closes" },
      { name: "lockRattle", label: "Locked door rattles" },
    ],
  },
  {
    title: "Combat, HP and conditions",
    sounds: [
      { name: "initiativeStart", label: "Initiative" },
      { name: "meleeHit", label: "Melee hit" },
      { name: "damage", label: "Damage taken" },
      { name: "heal", label: "Heal" },
      { name: "down", label: "Down (0 HP)" },
      { name: "deathSaveSuccess", label: "Death save · success" },
      { name: "deathSaveFail", label: "Death save · failure" },
      { name: "conditionVital", label: "Condition · vital" },
      { name: "conditionIncapacity", label: "Condition · incapacity" },
      { name: "conditionBody", label: "Condition · body" },
      { name: "conditionAffliction", label: "Condition · affliction" },
      { name: "conditionTactical", label: "Condition · tactical" },
      { name: "conditionSenses", label: "Condition · senses" },
      { name: "conditionMind", label: "Condition · mind" },
      { name: "conditionBoon", label: "Condition · boon" },
    ],
  },
  {
    title: "Spells",
    sounds: [
      { name: "spellCast", label: "Spell cast" },
      { name: "fire", label: "Fire" },
      { name: "cold", label: "Cold" },
      { name: "lightning", label: "Lightning" },
      { name: "thunder", label: "Thunder" },
      { name: "acid", label: "Acid" },
      { name: "poison", label: "Poison" },
      { name: "necrotic", label: "Necrotic" },
      { name: "radiant", label: "Radiant" },
      { name: "force", label: "Force" },
      { name: "psychic", label: "Psychic" },
    ],
  },
  {
    title: "Table flavour",
    sounds: [
      { name: "emotePop", label: "Emote" },
      { name: "ping", label: "Ping" },
      { name: "handRaised", label: "Hand raised" },
      { name: "handoutReveal", label: "Handout" },
      { name: "sceneTravel", label: "Scene travel" },
      { name: "error", label: "Not allowed" },
    ],
  },
];
