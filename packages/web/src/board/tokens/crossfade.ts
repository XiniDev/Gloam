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

/** A crossfade's state from frame to frame: its weight and the target it was last heading for. */
export interface Fade {
  w: number;
  want: number;
}

/**
 * One frame of a fade: toward `want` by `dt` — except on the frame its target changes, which starts the fade where it
 * is: `dt` then is time that passed before the change (a paced ambient frame's up to 250 ms), and spent on the fade it
 * finished a 200-ms fade in a single frame, the crossfade never seen.
 */
export function fadeFrame(f: Fade, want: number, dt: number): Fade {
  if (want !== f.want) return { w: f.w, want };
  return { w: crossfadeStep(f.w, want, dt), want };
}
