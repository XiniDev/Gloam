import { animatingTokens } from "../board/move/anims.ts";
import { useEntities } from "../state/entities.ts";
import { type FogRectMsg, type FogSnapshotMsg, useFog } from "../state/fog.ts";
import { request, useTable } from "./table.ts";

/**
 * Keeps the fog store in step with the server (SPEC §15.8): a `fog.snapshot` whenever the active scene or its fog
 * mode changes (and on every new connection), then its patches. Explored memory seen by a token still gliding along
 * its path waits until it arrives, so the room ahead doesn't turn to memory before the character gets there.
 */
let asked = "";
let seq = 0;
const heldExplored: FogRectMsg[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadFog(): Promise<void> {
  const my = ++seq;
  try {
    const s = await request<FogSnapshotMsg | null>("fog.snapshot", {});
    if (my !== seq) return; // a newer request answers
    heldExplored.length = 0;
    useFog.getState().load(s);
  } catch {
    // Not connected any more; the next connection asks again.
  }
}

function key(): string {
  const scene = useEntities.getState().live.scene;
  const room = useTable.getState().room;
  return scene && room ? `${room.roomId}|${room.sessionId}|${scene.id}|${scene.fogMode}` : "";
}

function check(): void {
  const k = key();
  if (k === asked) return;
  asked = k;
  if (k) void loadFog();
  else useFog.getState().reset();
}

/** Starts watching (once per page). */
export function watchFog(): () => void {
  const offE = useEntities.subscribe(check);
  const offT = useTable.subscribe(check);
  check();
  return () => {
    offE();
    offT();
  };
}

function flushExplored(): void {
  flushTimer = null;
  if (animatingTokens().some((id) => mine(id))) {
    flushTimer = setTimeout(flushExplored, 80);
    return;
  }
  for (const m of heldExplored.splice(0)) useFog.getState().explore(m);
}

/** Whether a token is one this client sees through (it holds its senses). */
function mine(id: string): boolean {
  return Boolean(useEntities.getState().live.tokens.get(id)?.vis);
}

export function onExploredPatch(m: FogRectMsg): void {
  heldExplored.push(m);
  if (!flushTimer) flushTimer = setTimeout(flushExplored, 0);
}

export function onFogPatch(m: FogRectMsg): void {
  useFog.getState().patch(m);
}
