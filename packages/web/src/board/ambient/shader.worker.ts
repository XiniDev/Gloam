/**
 * Renders an ambient `ShaderCanvas` off the main thread (OffscreenCanvas): context creation, shader compilation,
 * every frame and the final context release happen here, so the page's text and inputs never wait on GL work —
 * which on software GL (no GPU acceleration) cost hundreds of milliseconds per screen change.
 */
import { createShaderRenderer, runLoop, type Uniforms } from "./renderer.ts";

export type ShaderWorkerIn =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      frag: string;
      still: boolean;
      preserve: boolean;
      uniforms: Uniforms;
    }
  | { type: "size"; w: number; h: number }
  | { type: "uniforms"; uniforms: Uniforms }
  | { type: "visible"; visible: boolean }
  | { type: "dispose" };
export type ShaderWorkerOut = { type: "lit" } | { type: "failed" };

/** The parts of DedicatedWorkerGlobalScope used here (the project compiles against the DOM lib). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<ShaderWorkerIn>) => void) | null;
  postMessage(m: ShaderWorkerOut): void;
  close(): void;
  requestAnimationFrame?: (fn: (now: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
}
const scope = self as unknown as WorkerScope;
let size = { w: 0, h: 0 };
let uniforms: Uniforms = {};
let loop: ReturnType<typeof runLoop> | null = null;
let dispose: (() => void) | null = null;

const schedule = (fn: (now: number) => void): (() => void) => {
  const raf = scope.requestAnimationFrame;
  const caf = scope.cancelAnimationFrame;
  if (raf && caf) {
    const id = raf.call(scope, fn);
    return () => caf.call(scope, id);
  }
  const id = setTimeout(() => fn(performance.now()), 33);
  return () => clearTimeout(id);
};

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    uniforms = m.uniforms;
    const renderer = createShaderRenderer(m.canvas, m.frag, m.preserve);
    if (!renderer) {
      scope.postMessage({ type: "failed" } satisfies ShaderWorkerOut);
      scope.close();
      return;
    }
    loop = runLoop({
      renderer,
      still: m.still,
      size: () => size,
      uniforms: () => uniforms,
      schedule,
      onFirstFrame: () => scope.postMessage({ type: "lit" } satisfies ShaderWorkerOut),
    });
    dispose = () => renderer.dispose();
  } else if (m.type === "size") {
    size = { w: m.w, h: m.h };
    loop?.resume();
  } else if (m.type === "uniforms") {
    uniforms = m.uniforms;
  } else if (m.type === "visible") {
    if (m.visible) loop?.resume();
    else loop?.pause();
  } else if (m.type === "dispose") {
    loop?.stop();
    // Blocks only this worker while queued frames drain; the page has already moved on.
    dispose?.();
    scope.close();
  }
};
