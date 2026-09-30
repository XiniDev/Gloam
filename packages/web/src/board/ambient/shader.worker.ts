/**
 * The shared ambient renderer (SPEC §29.2 backdrops, §8.4 first-load candle): one worker and one WebGL context on
 * an OffscreenCanvas for the page's whole lifetime. Every `ShaderCanvas` on screen is a view: the worker draws its
 * shader at ≤ 30 fps (or one still frame under reduced motion) and hands the frame back as a transferable
 * ImageBitmap, which the page shows through a `bitmaprenderer` canvas — no copy, no GL work on the main thread.
 *
 * Contexts are never created or released per screen: on software GL (no GPU acceleration), releasing a context froze
 * every other context in the page — the board included — for seconds.
 */
import { createMultiShaderGl, type MultiShaderGl, type Uniforms } from "./renderer.ts";

export type ShaderWorkerIn =
  | { type: "add"; id: number; frag: string; still: boolean; uniforms: Uniforms; w: number; h: number }
  | { type: "size"; id: number; w: number; h: number }
  | { type: "uniforms"; id: number; uniforms: Uniforms }
  | { type: "remove"; id: number }
  | { type: "visible"; visible: boolean };
export type ShaderWorkerOut =
  | { type: "frame"; id: number; bitmap: ImageBitmap }
  | { type: "failed"; id: number }
  | { type: "unavailable" };

/** The parts of DedicatedWorkerGlobalScope used here (the project compiles against the DOM lib). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<ShaderWorkerIn>) => void) | null;
  postMessage(m: ShaderWorkerOut, transfer?: Transferable[]): void;
  requestAnimationFrame?: (fn: (now: number) => void) => number;
}
const scope = self as unknown as WorkerScope;

interface View {
  frag: string;
  still: boolean;
  uniforms: Uniforms;
  w: number;
  h: number;
  t0: number;
  last: number;
  /** A still view (reduced motion) draws once per change. */
  dirty: boolean;
}

const views = new Map<number, View>();
let gl: MultiShaderGl | null | undefined;
let canvas: OffscreenCanvas | null = null;
let visible = true;
let scheduled = false;

function ensureGl(): MultiShaderGl | null {
  if (gl !== undefined) return gl;
  canvas = new OffscreenCanvas(1, 1);
  // A lost context given back: every view drawn again (a still one too).
  gl = createMultiShaderGl(canvas, () => {
    for (const v of views.values()) v.dirty = true;
    wake();
  });
  return gl;
}

const next = (fn: (now: number) => void) => {
  if (scope.requestAnimationFrame) scope.requestAnimationFrame.call(scope, fn);
  else setTimeout(() => fn(performance.now()), 33);
};

function wake(): void {
  if (scheduled || !visible) return;
  scheduled = true;
  next(frame);
}

function frame(now: number): void {
  scheduled = false;
  const g = gl;
  // (Lost: nothing drawn — a blank frame would replace the last good one — until it's given back and wakes the loop.)
  if (!g || !canvas || !visible || g.lost()) return;
  let animating = false;
  for (const [id, v] of views) {
    if (v.w < 1 || v.h < 1) continue;
    if (!v.still) animating = true;
    const due = v.still ? v.dirty : now - v.last >= 33;
    if (!due) continue;
    v.last = now;
    v.dirty = false;
    if (!g.draw(v.frag, v.still ? 12 : (now - v.t0) / 1000, v.w, v.h, v.uniforms)) {
      views.delete(id);
      scope.postMessage({ type: "failed", id });
      continue;
    }
    const bitmap = canvas.transferToImageBitmap();
    scope.postMessage({ type: "frame", id, bitmap }, [bitmap]);
  }
  if (animating) wake();
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "add") {
    if (!ensureGl()) {
      scope.postMessage({ type: "unavailable" });
      return;
    }
    views.set(m.id, {
      frag: m.frag,
      still: m.still,
      uniforms: m.uniforms,
      w: m.w,
      h: m.h,
      t0: performance.now(),
      last: 0,
      dirty: true,
    });
    wake();
  } else if (m.type === "size" || m.type === "uniforms") {
    const v = views.get(m.id);
    if (!v) return;
    if (m.type === "size") {
      v.w = m.w;
      v.h = m.h;
    } else v.uniforms = m.uniforms;
    v.dirty = true;
    wake();
  } else if (m.type === "remove") {
    views.delete(m.id);
  } else if (m.type === "visible") {
    visible = m.visible;
    for (const v of views.values()) v.dirty = true;
    wake();
  }
};
