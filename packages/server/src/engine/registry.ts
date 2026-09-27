import type { CommandBus, CommandDef } from "./commandBus.ts";
import { campaignUpdate } from "./commands/campaign.ts";

/** Every command definition, in one list. Phases add their command modules here. */
export const ALL_COMMANDS: CommandDef<never, unknown>[] = [campaignUpdate as CommandDef<never, unknown>];

/** Room message rate limits per command (SPEC §13.5); default 10/s. */
export const COMMAND_RATES: Record<string, { capacity: number; perSecond: number }> = {
  "campaign.update": { capacity: 5, perSecond: 5 },
};

export function registerCommands(bus: CommandBus): void {
  for (const d of ALL_COMMANDS) bus.register(d);
}
