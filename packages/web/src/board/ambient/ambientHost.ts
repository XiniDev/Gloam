import type { Uniforms } from "./renderer.ts";
import type { ShaderWorkerIn, ShaderWorkerOut } from "./shader.worker.ts";

/**
 * The page's side of the shared ambient renderer (see shader.worker.ts): one worker, created on first use and kept
 * for the page's lifetime; each `ShaderCanvas` adds a view and receives its frames as ImageBitmaps.
 */
interface Listener {
  onFrame(bitmap: ImageBitmap): void;
  onFailed(): void;
}
export interface AmbientView {
  size(w: number, h: number): void;
  uniforms(u: Uniforms): void;
  remove(): void;
}

let worker: Worker | null = null;
let unavailable = false;
let nextId = 1;
const listeners = new Map<number, Listener>();

/** Worker WebGL on an OffscreenCanvas plus `bitmaprenderer` canvases (else: the on-page fallback). */
export function ambientSupported(): boolean {
  return (
    !unavailable &&
    typeof Worker === "function" &&
    typeof OffscreenCanvas === "function" &&
    "transferToImageBitmap" in OffscreenCanvas.prototype &&
    typeof ImageBitmapRenderingContext === "function"
  );
}

function post(m: ShaderWorkerIn): void {
  if (!worker) {
    worker = new Worker(new URL("./shader.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<ShaderWorkerOut>) => {
      const d = e.data;
      if (d.type === "frame") {
        const l = listeners.get(d.id);
        if (l) l.onFrame(d.bitmap);
        else d.bitmap.close();
      } else if (d.type === "failed") listeners.get(d.id)?.onFailed();
      else {
        unavailable = true;
        for (const l of [...listeners.values()]) l.onFailed();
        listeners.clear();
      }
    };
    document.addEventListener("visibilitychange", () => post({ type: "visible", visible: !document.hidden }));
  }
  worker.postMessage(m);
}

export function addAmbientView(
  init: { frag: string; still: boolean; uniforms: Uniforms; w: number; h: number },
  listener: Listener,
): AmbientView {
  const id = nextId++;
  listeners.set(id, listener);
  post({ type: "add", id, ...init });
  return {
    size: (w, h) => post({ type: "size", id, w, h }),
    uniforms: (uniforms) => post({ type: "uniforms", id, uniforms }),
    remove() {
      listeners.delete(id);
      post({ type: "remove", id });
    },
  };
}
