import { type P, pathLength, pointAtLength } from "@gloam/shared/geometry";
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
}

const anims = new Map<string, MoveAnim>();
export const EASE_MS = 120;

export function startMoveAnim(tokenId: string, path: P[], durationMs: number, now = performance.now()): void {
  if (path.length < 2) return;
  anims.set(tokenId, {
    path,
    length: pathLength(path),
    start: now,
    duration: Math.max(1, durationMs),
    stepAt: 0,
  });
  setAnimating(`move:${tokenId}`, true);
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
  if (t >= a.duration) {
    anims.delete(tokenId);
    setAnimating(`move:${tokenId}`, false);
    return null;
  }
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
