import type { KnockCard } from "@gloam/shared/protocol";
import type { CommandBus } from "../engine/commandBus.ts";
import type { CampaignModel } from "../engine/model.ts";

/** What services need from the lobby room (kept narrow to avoid import cycles). */
export interface LobbyRoomApi {
  upsertKnock(card: KnockCard & { status: string }): void;
  setKnockStatus(sessionId: string, status: string): void;
  removeKnock(sessionId: string): void;
  /** Sends a message to the lobby client(s) of a session, then optionally closes them. */
  notifySession(sessionId: string, type: string, payload: unknown, close?: number): void;
  broadcastToWatchers(type: string, payload: unknown): void;
  closeAllPending(code: number, type: string, payload: unknown): void;
  pendingKnocks(): KnockCard[];
  counts(): { pending: number };
}

/** What services need from a table room. */
export interface TableRoomApi {
  campaignId: string;
  /** The campaign's in-memory model and command bus (type-only here: no runtime import cycle). */
  model: CampaignModel;
  bus: CommandBus;
  /** Sends to every connected client whose role is admin/dm (knock cards, approvals). */
  toDms(type: string, payload: unknown): void;
  broadcastAll(type: string, payload: unknown): void;
  /** Disconnects a user's clients (kick/ban/table close) within 500 ms (AC-AUTH-05). */
  disconnectUser(userId: string, type: string, payload: unknown, code: number): void;
  disconnectNonAdmins(type: string, payload: unknown, code: number): void;
  counts(): { admitted: number; spectators: number };
  onlineUserIds(): Set<string>;
  reloadFromDatabase(): Promise<void>;
  flushFog(): void;
  /** A track's length became known: time the music again (SPEC §25.3). */
  audioChanged(): void;
  /** Someone's profile changed (renamed): their presence follows. */
  profileChanged(userId: string): void;
  /** An entry for the campaign log from outside the room (the local API), sent to its readers. */
  appendLog(kind: string, text: string, data: Record<string, unknown>): void;
  /** Hands a person's characters and token ownership to someone else, or no one, through the bus. */
  reassignOwner(fromUserId: string, toUserId: string | null, adminUserId: string): void;
}

/** Live room instances, registered by the rooms themselves on create/dispose. */
export class RoomRegistry {
  lobby: LobbyRoomApi | null = null;
  readonly tables = new Map<string, TableRoomApi>();

  table(campaignId: string | null | undefined): TableRoomApi | null {
    return campaignId ? (this.tables.get(campaignId) ?? null) : null;
  }
}

/** WebSocket close codes used by Gloam (4000–4999, never 4010; R3 deviation 12). */
export const CLOSE = {
  kicked: 4001,
  banned: 4003,
  denied: 4004,
  tableClosed: 4005,
  /** Their role at this table changed (the Admin made them a DM, or a player again): rejoin to take it up. */
  roleChanged: 4012,
  rateLimited: 4029,
  revoked: 4401,
} as const;
