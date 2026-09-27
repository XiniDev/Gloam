import type { ServerContext } from "../context.ts";

/**
 * Colyseus instantiates rooms itself (defineRoom), so rooms reach the server context through this holder, set
 * once in server.ts before any room is created.
 */
let current: ServerContext | null = null;

export function setRoomContext(ctx: ServerContext | null): void {
  current = ctx;
}

export function roomCtx(): ServerContext {
  if (!current) throw new Error("room context not initialised");
  return current;
}
