import type { WebGLRenderer } from "three";

const pinned = new WeakSet<object>();

/**
 * Keeps every shader program the board has compiled for the rest of the session. three.js frees a program when the
 * last material using it is disposed, so overlays that come and go — a ruler, a move ribbon, a ping, the Walls tool's
 * selection glow — recompiled their shaders each time they reappeared: a stall of tens of milliseconds on a GPU
 * (and a second under software GL) at the moment the player starts to act. Programs are few (one per material
 * variant) and small, so holding them costs nothing that matters. Called once per frame; `renderer.info.programs` is
 * three's own list, and each program's `usedTimes` is the count three releases it by.
 */
export function pinPrograms(gl: WebGLRenderer): void {
  const list = gl.info.programs as unknown as { usedTimes: number }[] | null;
  if (!list) return;
  for (const p of list) {
    if (pinned.has(p)) continue;
    pinned.add(p);
    p.usedTimes++;
  }
}
