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
