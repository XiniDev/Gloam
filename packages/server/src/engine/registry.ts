import type { CommandBus, CommandDef } from "./commandBus.ts";
import { ASSET_COMMANDS } from "./commands/asset.ts";
import { campaignUpdate } from "./commands/campaign.ts";
import { SCENE_COMMANDS } from "./commands/scene.ts";
import { TOKEN_COMMANDS } from "./commands/token.ts";
import { WALL_COMMANDS } from "./commands/wall.ts";

/** Every command definition, in one list. Phases add their command modules here. */
export const ALL_COMMANDS: CommandDef<never, unknown>[] = [
  campaignUpdate as CommandDef<never, unknown>,
  ...SCENE_COMMANDS,
  ...TOKEN_COMMANDS,
  ...ASSET_COMMANDS,
  ...WALL_COMMANDS,
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
};

export function registerCommands(bus: CommandBus): void {
  for (const d of ALL_COMMANDS) bus.register(d);
}
