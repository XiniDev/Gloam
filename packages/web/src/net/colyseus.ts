import { Client, type Room } from "@colyseus/sdk";
import { ERROR_TOAST, type ErrorCode, type Rejection } from "@gloam/shared/protocol";

let client: Client | null = null;

/** One Colyseus client for the page, on the same origin (cookies ride along with matchmaking and the socket). */
export function colyseus(): Client {
  if (!client) client = new Client(window.location.origin);
  return client;
}

/** Turns a rejected `room.request()` into a friendly message (SPEC §13.5 rejection codes → toasts). */
export function rejectionMessage(err: unknown): {
  code: ErrorCode | "NETWORK";
  message: string;
  detail?: unknown;
} {
  const e = err as { name?: string; reason?: Rejection; message?: string };
  if (e?.name === "rejected" && e.reason?.code) {
    return {
      code: e.reason.code,
      message: e.reason.message || ERROR_TOAST[e.reason.code],
      ...(e.reason.detail !== undefined ? { detail: e.reason.detail } : {}),
    };
  }
  return { code: "NETWORK", message: "The table didn't answer — trying again may help." };
}

/** Maps a matchmaking failure (onAuth rejection) to our codes. */
export function joinErrorCode(err: unknown): ErrorCode | "NETWORK" {
  const e = err as { code?: number; message?: string };
  const msg = e?.message ?? "";
  if (/TABLE_CLOSED/.test(msg)) return "TABLE_CLOSED";
  if (/RATE_LIMITED/.test(msg) || e?.code === 429) return "RATE_LIMITED";
  if (/UNAUTHENTICATED/.test(msg) || e?.code === 401) return "UNAUTHENTICATED";
  if (/FORBIDDEN/.test(msg) || e?.code === 403) return "FORBIDDEN";
  return "NETWORK";
}

/**
 * Leaves a room once, only while its socket is open. The SDK's `leave()` sends unconditionally (a console error on
 * a closed socket) and its promise never settles when the room already left, so every caller goes through here.
 */
export function leaveRoom(room: Room | null | undefined): void {
  if (!room?.connection?.isOpen) return;
  void room.leave();
}
