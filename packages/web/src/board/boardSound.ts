import { Vector3 } from "three";
import { audio, type PlayOptions } from "../audio/engine.ts";
import type { SfxName } from "../audio/recipes.ts";
import { cameraRig } from "./CameraRig.tsx";

const v = new Vector3();
const target = new Vector3();

/**
 * Where a point on the board sits in the mix (SPEC §25.1, docs/research/sound.md §6.5; AC-AUD-05): its pan from where
 * it is on screen (−1 at the left edge, 1 at the right; off-screen clamps; the engine maps it to ±0.8), and its
 * distance in feet from the camera's target across the table (the engine turns that into 1/(1 + d/60)).
 */
export function boardMix(x: number, y: number, z = 0): { pan: number; distanceFt: number } {
  const c = cameraRig.controls;
  if (!c) return { pan: 0, distanceFt: 0 };
  c.getTarget(target);
  v.set(x, z, y).project(c.camera);
  // Behind the camera the projection mirrors: the side it's on is the other one.
  const sx = v.z > 1 ? -v.x : v.x;
  return {
    pan: Math.max(-1, Math.min(1, sx)),
    distanceFt: Math.hypot(x - target.x, y - target.z),
  };
}

/** A sound from a place on the board (feet; `z` its height), panned and attenuated by where it is. */
export function playOnBoard(
  name: SfxName,
  at: { x: number; y: number; z?: number },
  opts: Omit<PlayOptions, "pan" | "distanceFt"> = {},
): boolean {
  return audio.play(name, { ...boardMix(at.x, at.y, at.z ?? 0), ...opts });
}

/** Footsteps at most 8 a second across the board (sound.md §6.6), alternating feet (odd steps a little lower). */
const stepTimes: number[] = [];
let foot = 0;
export function footstepAt(at: { x: number; y: number; z?: number }): boolean {
  const now = performance.now();
  while (stepTimes.length && (stepTimes[0] as number) < now - 1000) stepTimes.shift();
  if (stepTimes.length >= 8) return false;
  stepTimes.push(now);
  foot ^= 1;
  const rate = (1 + (Math.random() * 2 - 1) * 0.08) * (foot ? 0.94 : 1);
  // ±2 dB, so a walk isn't a metronome.
  const gain = 10 ** (((Math.random() * 2 - 1) * 2) / 20);
  return playOnBoard("footstep", at, { rate, gain });
}
