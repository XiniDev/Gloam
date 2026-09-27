import type { P } from "@gloam/shared/geometry";
import { create } from "zustand";
import { wake } from "../frames.ts";

/**
 * Other viewers' drags (SPEC §8.6 Others see planning): the latest `move.preview` per token, shown as a ghost and a
 * path until it's cleared (empty path), committed (`token.moved`), or goes stale (no update for 1.5 s — a dropped
 * connection mid-drag).
 */
export interface RemotePreview {
  points: P[];
  cost: number;
  color: string;
  by: string;
  at: number;
}

export const useRemoteMoves = create<{ byToken: Map<string, RemotePreview> }>(() => ({ byToken: new Map() }));

const STALE_MS = 1500;
/** Diagnostics (test hooks): when previews arrived (the sender throttles them to 15 Hz). */
export const remoteLog: { tokenId: string; at: number; points: number }[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function onRemotePreview(m: {
  tokenId: string;
  points: P[];
  cost: number;
  color: string;
  by: string;
}): void {
  remoteLog.push({ tokenId: m.tokenId, at: performance.now(), points: m.points.length });
  if (remoteLog.length > 400) remoteLog.splice(0, 100);
  const next = new Map(useRemoteMoves.getState().byToken);
  const t = timers.get(m.tokenId);
  if (t) clearTimeout(t);
  if (!m.points.length) next.delete(m.tokenId);
  else {
    next.set(m.tokenId, { points: m.points, cost: m.cost, color: m.color, by: m.by, at: performance.now() });
    timers.set(
      m.tokenId,
      setTimeout(() => clearRemotePreview(m.tokenId), STALE_MS),
    );
  }
  useRemoteMoves.setState({ byToken: next });
  wake();
}

export function clearRemotePreview(tokenId: string): void {
  const cur = useRemoteMoves.getState().byToken;
  if (!cur.has(tokenId)) return;
  const next = new Map(cur);
  next.delete(tokenId);
  useRemoteMoves.setState({ byToken: next });
  const t = timers.get(tokenId);
  if (t) clearTimeout(t);
  timers.delete(tokenId);
  wake();
}
