import { type P, pathLength, pointAtLength } from "@gloam/shared/geometry";
import type { TokenView } from "@gloam/shared/state";
import { setAnimating } from "../frames.ts";

/**
 * Committed moves, animated (SPEC §8.6 Others see planning, §16.7): every viewer glides the token along the path
 * the server accepted, at 30 ft/s (the server sends the duration: 250 ms–2 s), easing in and out over the first and
 * last 120 ms, instead of cutting straight across to the new position (which could pass through a wall).
 */
export interface MoveAnim {
  path: P[];
  length: number;
  start: number;
  duration: number;
  /** Feet travelled when the last footstep sounded. */
  stepAt: number;
  /** Seen partially (§15.6): it comes into view at the path's start, fades out at its end. */
  appear: boolean;
  disappear: boolean;
}

const anims = new Map<string, MoveAnim>();
export const EASE_MS = 120;
/** How long a creature takes to fade in where it comes into view, or out where it leaves it. */
export const FADE_MS = 300;

export function startMoveAnim(
  tokenId: string,
  path: P[],
  durationMs: number,
  now = performance.now(),
  seen: { delayMs?: number; appear?: boolean; disappear?: boolean } = {},
): void {
  if (path.length < 2 && !seen.appear && !seen.disappear) return;
  const pts = path.length >= 2 ? path : [path[0] as P, path[0] as P];
  anims.set(tokenId, {
    path: pts,
    length: pathLength(pts),
    start: now + (seen.delayMs ?? 0),
    duration: Math.max(1, durationMs),
    stepAt: 0,
    appear: seen.appear === true,
    disappear: seen.disappear === true,
  });
  setAnimating(`move:${tokenId}`, true);
}

/** The looks of a creature this viewer never holds (it crosses their view mid-move): the server sends them along. */
export interface GhostLooks {
  name: string;
  size: string;
  sizeFt: number;
  elevation: number;
  rotation: number;
  mode: string;
  assetId: string;
  portraitAssetId: string;
  scale: number;
  offsetY: number;
  rotOffset: number;
  tint: string;
  ringColor: string;
  disposition: string;
}

/** `token.moved` as this viewer perceives it (SPEC §15.6). */
export interface TokenMovedMessage {
  id: string;
  path: P[];
  durationMs: number;
  delayMs?: number;
  appear?: boolean;
  disappear?: boolean;
  ghost?: GhostLooks;
}

/**
 * Creatures drawn without being in the state: one leaving this viewer's perception keeps gliding to where it was
 * last seen and fades there (the state has already dropped it); one crossing their view is drawn from the looks the
 * server sent. Forgotten when their move ends.
 */
const ghosts = new Map<string, TokenView>();
const ghostListeners = new Set<() => void>();
export const ghostTokens = (): ReadonlyMap<string, TokenView> => ghosts;
export function onGhosts(fn: () => void): () => void {
  ghostListeners.add(fn);
  return () => ghostListeners.delete(fn);
}
const ghostsChanged = () => {
  for (const fn of ghostListeners) fn();
};

/** The moves this viewer received, as it received them (test builds read it: what did a player learn?). */
export const movedLog: TokenMovedMessage[] = [];

export function onTokenMoved(
  m: TokenMovedMessage,
  held: TokenView | undefined,
  now = performance.now(),
): void {
  movedLog.push(m);
  if (movedLog.length > 200) movedLog.splice(0, 50);
  startMoveAnim(m.id, m.path, m.durationMs, now, m);
  if (!m.disappear) return;
  const looks: TokenView | null = held ?? (m.ghost ? ghostView(m.id, m.ghost, m.path[0] as P) : null);
  if (!looks) return;
  ghosts.set(m.id, { ...looks, pos: { ...(m.path[m.path.length - 1] as P) } });
  ghostsChanged();
}

function ghostView(id: string, g: GhostLooks, at: P): TokenView {
  return {
    id,
    actorId: "",
    kind: "unit",
    name: g.name,
    pos: { x: at.x, y: at.y },
    elevation: g.elevation,
    rotation: g.rotation,
    size: g.size,
    sizeFt: g.sizeFt,
    mode: g.mode,
    assetId: g.assetId,
    portraitAssetId: g.portraitAssetId,
    scale: g.scale,
    offsetY: g.offsetY,
    rotOffset: g.rotOffset,
    tint: g.tint,
    ringColor: g.ringColor,
    disposition: g.disposition,
    ownerIds: [],
    hpDisplay: "hidden",
    hpBand: 255,
    hpFrac: -1,
    tempFrac: -1,
    conditions: [],
    markers: [],
    exhaustion: 0,
    concentrating: false,
    prone: false,
    dead: false,
    invisibleFx: false,
    outlined: false,
    lightOn: false,
    reachFt: 5,
    locked: false,
    moveSeq: 0,
    pinnedBars: [],
    customMarkers: [],
  };
}

/** A creature's opacity from its move: fading in where it came into view, out where it left it (0…1). */
export function moveAnimFade(tokenId: string, now = performance.now()): number {
  const a = anims.get(tokenId);
  if (!a) return 1;
  const t = now - a.start;
  let o = 1;
  if (a.appear) o = Math.min(o, Math.max(0, t / FADE_MS));
  if (a.disappear) o = Math.min(o, Math.max(0, 1 - (t - a.duration) / FADE_MS));
  return o;
}

/**
 * Distance travelled along the path at time t (ms) for a trapezoid speed profile: accelerate over the first `ease` ms,
 * cruise, decelerate over the last `ease` ms, covering exactly `length` in `duration`.
 */
export function travelled(length: number, duration: number, t: number, ease = EASE_MS): number {
  if (t <= 0) return 0;
  if (t >= duration) return length;
  const r = Math.min(ease, duration / 2);
  const v = length / (duration - r);
  if (t < r) return (v * t * t) / (2 * r);
  if (t > duration - r) return length - (v * (duration - t) * (duration - t)) / (2 * r);
  return v * (t - r / 2);
}

/**
 * Where an animated token is now, its heading (radians, for auto-facing) and whether a footstep is due (every 5 ft);
 * null once the move has finished (the animation is then forgotten).
 */
export function moveAnimAt(
  tokenId: string,
  now = performance.now(),
): { pos: P; heading: number | null; step: boolean } | null {
  const a = anims.get(tokenId);
  if (!a) return null;
  const t = now - a.start;
  // Leaving view: it stays where it was last seen while it fades.
  const end = a.duration + (a.disappear ? FADE_MS : 0);
  if (t >= end) {
    anims.delete(tokenId);
    setAnimating(`move:${tokenId}`, false);
    if (ghosts.delete(tokenId)) ghostsChanged();
    return null;
  }
  if (t >= a.duration) return { pos: a.path[a.path.length - 1] as P, heading: null, step: false };
  const s = travelled(a.length, a.duration, t);
  const { point, index } = pointAtLength(a.path, s);
  const from = a.path[Math.max(0, index - 1)] as P;
  const to = a.path[index] as P;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const heading = Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dx, dy) : null;
  const step = s - a.stepAt >= 5;
  if (step) a.stepAt += 5 * Math.floor((s - a.stepAt) / 5);
  return { pos: point, heading, step };
}

export function cancelMoveAnim(tokenId: string): void {
  if (anims.delete(tokenId)) setAnimating(`move:${tokenId}`, false);
}

/** Test/diagnostic: tokens currently animating. */
export function animatingTokens(): string[] {
  return [...anims.keys()];
}
