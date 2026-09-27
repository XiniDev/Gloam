/** Auto mode (SPEC §8.5, AC-TOK-11): coin above this camera pitch, standee below. */
export const AUTO_COIN_PITCH = 70;
/** …crossfading over this long. */
export const CROSSFADE_S = 0.2;

/** `value` moved toward `target` by at most `step`; at the target it stays there. */
export function approach(value: number, target: number, step: number): number {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

/** Auto mode's coin weight after one frame: linear toward `want` (0 standee, 1 coin) over CROSSFADE_S. */
export function crossfadeStep(w: number, want: number, dt: number): number {
  return approach(w, want, dt / CROSSFADE_S);
}
