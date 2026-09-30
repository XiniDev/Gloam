import type { CommandBus, CommandDef } from "./commandBus.ts";
import { ACTOR_COMMANDS } from "./commands/actor.ts";
import { ASSET_COMMANDS } from "./commands/asset.ts";
import { AUDIO_COMMANDS } from "./commands/audio.ts";
import { campaignUpdate } from "./commands/campaign.ts";
import { COMBAT_COMMANDS } from "./commands/combat.ts";
import { CONTENT_COMMANDS } from "./commands/content.ts";
import { FOG_COMMANDS } from "./commands/fog.ts";
import { HANDOUT_COMMANDS } from "./commands/handout.ts";
import { HEALTH_COMMANDS } from "./commands/health.ts";
import { IMPORT_COMMANDS } from "./commands/imports.ts";
import { LIGHT_COMMANDS } from "./commands/light.ts";
import { MOVE_COMMANDS } from "./commands/move.ts";
import { PARTY_COMMANDS } from "./commands/party.ts";
import { REST_COMMANDS } from "./commands/rest.ts";
import { SCENE_COMMANDS } from "./commands/scene.ts";
import { SPELL_COMMANDS } from "./commands/spells.ts";
import { TOKEN_COMMANDS } from "./commands/token.ts";
import { WALL_COMMANDS } from "./commands/wall.ts";
import { ZONE_COMMANDS } from "./commands/zone.ts";

/** Every command definition, in one list. Phases add their command modules here. */
export const ALL_COMMANDS: CommandDef<never, unknown>[] = [
  campaignUpdate as CommandDef<never, unknown>,
  ...SCENE_COMMANDS,
  ...TOKEN_COMMANDS,
  ...ASSET_COMMANDS,
  ...WALL_COMMANDS,
  ...MOVE_COMMANDS,
  ...ZONE_COMMANDS,
  ...LIGHT_COMMANDS,
  ...FOG_COMMANDS,
  ...ACTOR_COMMANDS,
  ...PARTY_COMMANDS,
  ...HEALTH_COMMANDS,
  ...REST_COMMANDS,
  ...COMBAT_COMMANDS,
  ...SPELL_COMMANDS,
  ...CONTENT_COMMANDS,
  ...IMPORT_COMMANDS,
  ...AUDIO_COMMANDS,
  ...HANDOUT_COMMANDS,
];

/** Room message rate limits per command (SPEC §13.5); default 10/s. */
export const COMMAND_RATES: Record<string, { capacity: number; perSecond: number }> = {
  "campaign.update": { capacity: 5, perSecond: 5 },
  ...Object.fromEntries(SCENE_COMMANDS.map((d) => [d.type, { capacity: 5, perSecond: 5 }])),
  ...Object.fromEntries(TOKEN_COMMANDS.map((d) => [d.type, { capacity: 20, perSecond: 20 }])),
  ...Object.fromEntries(ASSET_COMMANDS.map((d) => [d.type, { capacity: 10, perSecond: 5 }])),
  ...Object.fromEntries(WALL_COMMANDS.map((d) => [d.type, { capacity: 20, perSecond: 20 }])),
  "token.elevation": { capacity: 10, perSecond: 10 },
  "token.facing": { capacity: 10, perSecond: 10 },
  ...Object.fromEntries(ZONE_COMMANDS.map((d) => [d.type, { capacity: 20, perSecond: 20 }])),
  "move.commit": { capacity: 5, perSecond: 5 },
  ...Object.fromEntries(LIGHT_COMMANDS.map((d) => [d.type, { capacity: 10, perSecond: 10 }])),
  // A brush stroke is sent in pieces while the DM paints.
  "fog.paint": { capacity: 20, perSecond: 20 },
  "fog.resetExplored": { capacity: 3, perSecond: 1 },
  "door.toggle": { capacity: 5, perSecond: 5 },
  // Sheets (§8.10): edits come as a player types and ticks; the rest are deliberate.
  ...Object.fromEntries(ACTOR_COMMANDS.map((d) => [d.type, { capacity: 5, perSecond: 2 }])),
  "actor.change": { capacity: 20, perSecond: 10 },
  // Health (§8.11): a burst of damage from an area, conditions ticked on and off.
  "hp.apply": { capacity: 10, perSecond: 5 },
  "status.change": { capacity: 10, perSecond: 5 },
  "rest.apply": { capacity: 3, perSecond: 1 },
  // Combat (§13.5: 10/s): the DM steps through turns; a pip ticked, a dash, a reset.
  ...Object.fromEntries(COMBAT_COMMANDS.map((d) => [d.type, { capacity: 10, perSecond: 10 }])),
  "combat.start": { capacity: 3, perSecond: 1 },
  "combat.quickStart": { capacity: 3, perSecond: 1 },
  // Spells (§8.13): a cast, then the card's steps as the DM works through them.
  ...Object.fromEntries(SPELL_COMMANDS.map((d) => [d.type, { capacity: 10, perSecond: 5 }])),
  "spell.cast": { capacity: 5, perSecond: 2 },
  "attack.start": { capacity: 5, perSecond: 2 },
  ...Object.fromEntries(CONTENT_COMMANDS.map((d) => [d.type, { capacity: 5, perSecond: 2 }])),
  "content.spell.import": { capacity: 2, perSecond: 0.5 },
  // (Imports come over the local API, not the room; were one sent there, it's as slow as a spell import.)
  ...Object.fromEntries(IMPORT_COMMANDS.map((d) => [d.type, { capacity: 2, perSecond: 0.5 }])),
  // Audio (§13.5: 5/s): the player's buttons, the mixer's sliders (sent as they move, a few a second).
  ...Object.fromEntries(AUDIO_COMMANDS.map((d) => [d.type, { capacity: 8, perSecond: 5 }])),
  // Handouts and secret notes (§13.5: 2/s).
  ...Object.fromEntries(HANDOUT_COMMANDS.map((d) => [d.type, { capacity: 4, perSecond: 2 }])),
};

export function registerCommands(bus: CommandBus): void {
  for (const d of ALL_COMMANDS) bus.register(d);
}
