/** Auto mode (SPEC §8.5, AC-TOK-11): coin above this camera pitch, standee below. */
export const AUTO_COIN_PITCH = 70;
/** …crossfading over this long. */
export const CROSSFADE_S = 0.2;

/** Auto mode's coin weight after one frame: linear toward `want` (0 standee, 1 coin) over CROSSFADE_S. */
export function crossfadeStep(w: number, want: number, dt: number): number {
  const step = dt / CROSSFADE_S;
  return want > w ? Math.min(1, w + step) : Math.max(0, w - step);
}
