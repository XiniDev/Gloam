import type { CommandBus, CommandDef } from "./commandBus.ts";
import { ASSET_COMMANDS } from "./commands/asset.ts";
import { campaignUpdate } from "./commands/campaign.ts";
import { FOG_COMMANDS } from "./commands/fog.ts";
import { LIGHT_COMMANDS } from "./commands/light.ts";
import { MOVE_COMMANDS } from "./commands/move.ts";
import { SCENE_COMMANDS } from "./commands/scene.ts";
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
};

export function registerCommands(bus: CommandBus): void {
  for (const d of ALL_COMMANDS) bus.register(d);
}
