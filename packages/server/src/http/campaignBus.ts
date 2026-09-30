import { GloamError } from "@gloam/shared/protocol";
import { applyPatch } from "@gloam/shared/rules";
import type { ServerContext } from "../context.ts";
import { CommandBus } from "../engine/commandBus.ts";
import { CampaignModel } from "../engine/model.ts";
import { registerCommands } from "../engine/registry.ts";

/**
 * A campaign's command bus for work from outside its room (imports over HTTP, the local API): the open table's own —
 * everyone sees the change at once and it's in its history — or, with no table open for it, the campaign's, straight
 * to the database with its history (the table loads it when it opens).
 */
export function campaignBus(ctx: ServerContext, campaignId: string): CommandBus {
  const room = ctx.rooms.table(campaignId);
  if (room) return room.bus;
  const model = CampaignModel.load(ctx.db, campaignId);
  if (!model) throw new GloamError("NOT_FOUND", "That campaign no longer exists.");
  const bus = new CommandBus(ctx, model, {
    onCommitted: () => {},
    sheet: { apply: (sheet, patch) => applyPatch(sheet, patch) },
  });
  registerCommands(bus);
  return bus;
}

/** A campaign's entities as they stand: the open table's model, else loaded from the database. */
export function campaignModel(ctx: ServerContext, campaignId: string): CampaignModel {
  const room = ctx.rooms.table(campaignId);
  if (room) return room.model;
  const model = CampaignModel.load(ctx.db, campaignId);
  if (!model) throw new GloamError("NOT_FOUND", "That campaign no longer exists.");
  return model;
}
