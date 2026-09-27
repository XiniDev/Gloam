import { matchMaker } from "@colyseus/core";
import type { ServerContext } from "../context.ts";

/**
 * Creates the table room for a campaign unless it already exists. `createRoom` with an existing fixed roomId
 * silently returns the old room after running onCreate on a throwaway instance, so guard first (R3 deviation 9).
 */
export async function ensureTableRoom(ctx: ServerContext, campaignId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(campaignId)) throw new Error("invalid campaign id");
  if (matchMaker.getLocalRoomById(campaignId)) return;
  await matchMaker.createRoom("table", { campaignId });
  ctx.log.info({ campaignId }, "table room created");
}

export async function disposeTableRoom(ctx: ServerContext, campaignId: string): Promise<void> {
  const room = matchMaker.getLocalRoomById(campaignId);
  if (!room) return;
  await room.disconnect();
  ctx.rooms.tables.delete(campaignId);
}

export async function ensureLobbyRoom(): Promise<void> {
  if (matchMaker.getLocalRoomById("lobby")) return;
  await matchMaker.createRoom("lobby", {});
}
