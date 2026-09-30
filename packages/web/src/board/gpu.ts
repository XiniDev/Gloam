import type { WebGLRenderer, WebGLRenderTarget } from "three";
import { create } from "zustand";

/**
 * The board's WebGL context, lost and given back (SPEC §40). A phone takes a page's graphics memory back when it runs
 * short (the page in the background, a game in another app), a desktop when its driver resets. three.js keeps its
 * objects and makes their GPU copies again as they're next drawn — buffers, textures from their images, render
 * targets — but what only ever lived on the GPU comes back blank or gone: environment maps drawn once, the vision
 * passes' targets, every compiled program. Each such thing says how to draw itself again (`redrawOnRestore`,
 * `keepDrawn`), and the board shows "Restoring board…" until the shader warm-up has compiled everything again.
 */
export interface GpuState {
  /** The context is gone right now. */
  lost: boolean;
  /** Losses so far (0: the board has never lost it). */
  losses: number;
  /** Restorations so far: layers that keep drawn state redraw it on a change. */
  restores: number;
  /** When the last loss happened (performance.now()). */
  lostAt: number;
}

export const useGpu = create<GpuState>(() => ({ lost: false, losses: 0, restores: 0, lostAt: 0 }));

/** Whether this renderer's context is lost now (three's own compile throws on one). */
export function contextLost(gl: WebGLRenderer): boolean {
  return gl.getContext().isContextLost();
}

/**
 * Follows the board renderer's context into `useGpu`. three's own listeners (added when the renderer was made) run
 * first: by the time `onRestored` runs, three has its new context state and everything can draw again.
 */
export function watchContext(gl: WebGLRenderer, onRestored: () => void): () => void {
  const el = gl.domElement;
  const lost = () =>
    useGpu.setState((s) => ({ lost: true, losses: s.losses + 1, lostAt: performance.now() }));
  const restored = () => {
    onRestored();
    useGpu.setState((s) => ({ lost: false, restores: s.restores + 1 }));
  };
  el.addEventListener("webglcontextlost", lost);
  el.addEventListener("webglcontextrestored", restored);
  return () => {
    el.removeEventListener("webglcontextlost", lost);
    el.removeEventListener("webglcontextrestored", restored);
  };
}

/** Runs `fn` each time this renderer's context comes back (after three's own restoration). */
export function redrawOnRestore(gl: WebGLRenderer, fn: () => void): () => void {
  const el = gl.domElement;
  el.addEventListener("webglcontextrestored", fn);
  return () => el.removeEventListener("webglcontextrestored", fn);
}

/**
 * A render target drawn once (an environment map) drawn again after a restoration: `make` draws a fresh one, which is
 * copied into it and let go. Its texture stays the same object, so the materials and scenes holding it need no telling.
 */
export function keepDrawn(
  gl: WebGLRenderer,
  rt: WebGLRenderTarget,
  make: () => WebGLRenderTarget,
): () => void {
  return redrawOnRestore(gl, () => {
    const fresh = make();
    gl.initRenderTarget(rt);
    gl.copyTextureToTexture(fresh.texture, rt.texture);
    fresh.dispose();
  });
}
