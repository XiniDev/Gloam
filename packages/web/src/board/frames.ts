import { invalidate } from "@react-three/fiber";

/**
 * On-demand rendering (the board's Canvas uses frameloop="demand"): an idle table draws nothing, which matters on
 * the host PC (it also runs the server), on laptops and phones (battery), and under software GL, where two boards
 * rendering idle frames starved each other. Anything that changes the picture either calls `wake()` — frames keep
 * coming for a moment, long enough for follow-up work like texture decodes and short fades — or registers as
 * animating while it moves.
 */
let awakeUntil = 0;
const animating = new Set<string>();

/** Render for the next `ms` milliseconds (at least one frame). */
export function wake(ms = 1000): void {
  awakeUntil = Math.max(awakeUntil, performance.now() + ms);
  invalidate();
}

/** Keeps frames coming while `active` (selection pulse, idle animations, tests forcing frame times). */
export function setAnimating(key: string, active: boolean): void {
  if (active) {
    if (!animating.has(key)) {
      animating.add(key);
      invalidate();
    }
  } else animating.delete(key);
}

/** Called once per rendered frame: should another one follow? */
export function wantsNextFrame(now: number): boolean {
  return animating.size > 0 || now < awakeUntil;
}

/**
 * Ambient motion (dust motes): low priority. When nothing else wants frames, ambient animators get at most
 * AMBIENT_FPS; those paced frames are marked so the tier governor doesn't mistake the pacing for slowness.
 */
const AMBIENT_FPS = 30;
const ambient = new Set<string>();
let ambientTimer: ReturnType<typeof setTimeout> | null = null;
let pacedFrame = false;

export function setAmbient(key: string, active: boolean): void {
  if (active) {
    if (!ambient.has(key)) {
      ambient.add(key);
      invalidate();
    }
  } else ambient.delete(key);
}

/** After a rendered frame that wants no successor: schedule a paced one if something ambient is running. */
export function scheduleAmbientFrame(): void {
  if (!ambient.size || ambientTimer) return;
  ambientTimer = setTimeout(() => {
    ambientTimer = null;
    if (!ambient.size) return;
    pacedFrame = true;
    invalidate();
  }, 1000 / AMBIENT_FPS);
}

/** True once for a frame that was paced for ambient motion (not rendered as fast as possible). */
export function takePacedFrame(): boolean {
  const p = pacedFrame;
  pacedFrame = false;
  return p;
}

/**
 * The animation step for this frame. With on-demand rendering the first frame after an idle pause would carry the
 * whole pause as its delta, and every dt-driven animation (token glides, the auto crossfade, idle minis) would jump
 * to its end; that frame gets a nominal 1/60 s instead. Continuous frames use their real time (capped at 250 ms).
 */
let delta = 1 / 60;
export const frameDelta = (): number => delta;
export function setFrameDelta(dt: number, continuous: boolean): void {
  delta = continuous ? Math.min(dt, 0.25) : 1 / 60;
}
