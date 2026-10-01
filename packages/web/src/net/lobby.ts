import { Callbacks, type Room } from "@colyseus/sdk";
import type { KnockCard } from "@gloam/shared/protocol";
import { LobbyState, type LobbyStateT } from "@gloam/shared/state";
import { colyseus, rejectionMessage } from "./colyseus.ts";

export interface KnockView {
  sessionId: string;
  userId: string;
  name: string;
  color: string;
  status: string;
  identity: KnockCard["identity"];
  deviceLabel: string;
  knockedAt: number;
}

export interface LobbyHandlers {
  onKnocks?: (knocks: KnockView[]) => void;
  onMessage?: (type: string, payload: unknown) => void;
  onLeave?: (code: number) => void;
  onDrop?: () => void;
  onReconnect?: () => void;
}

/**
 * Joins the waiting room (`lobby`). Pending players see only their own knock; the Admin console joins as a
 * watcher and sees every knock plus live `table.status` messages.
 */
export async function joinLobby(h: LobbyHandlers): Promise<Room<unknown, LobbyStateT>> {
  const room = (await colyseus().joinById("lobby", {}, LobbyState)) as unknown as Room<unknown, LobbyStateT>;
  const cb = Callbacks.get<LobbyStateT>(room as never);
  const knocks = new Map<string, KnockView>();
  const emit = () => h.onKnocks?.([...knocks.values()].sort((a, b) => a.knockedAt - b.knockedAt));
  const snapshot = (k: KnockView & object, key: string) => {
    knocks.set(key, {
      sessionId: k.sessionId,
      userId: k.userId,
      name: k.name,
      color: k.color,
      status: k.status,
      identity: k.identity as KnockCard["identity"],
      deviceLabel: k.deviceLabel,
      knockedAt: k.knockedAt,
    });
  };
  cb.onAdd("knocks", (k, key) => {
    snapshot(k as unknown as KnockView, key as string);
    emit();
    cb.onChange(k, () => {
      snapshot(k as unknown as KnockView, key as string);
      emit();
    });
  });
  cb.onRemove("knocks", (_k, key) => {
    knocks.delete(key as string);
    emit();
  });
  room.onMessage("*", (type, payload) => h.onMessage?.(String(type), payload));
  room.onLeave((code) => h.onLeave?.(code));
  room.onDrop(() => h.onDrop?.());
  room.onReconnect(() => h.onReconnect?.());
  return room;
}

/** A request in the waiting room (its own dice skin: SPEC §8.2 "Choose your dice"), answered or refused with why. */
export async function lobbyRequest<T = unknown>(
  room: Room | null,
  type: string,
  payload: unknown,
): Promise<T> {
  if (!room) throw new Error("Not connected to the waiting room.");
  try {
    return (await room.request(type, payload, { timeout: 8000 })) as T;
  } catch (err) {
    const r = rejectionMessage(err);
    throw Object.assign(new Error(r.message), { code: r.code });
  }
}
