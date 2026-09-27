import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../state/settings.ts";
import { createShaderRenderer, runLoop, type Uniforms } from "./renderer.ts";
import type { ShaderWorkerIn, ShaderWorkerOut } from "./shader.worker.ts";

export type { Uniforms };

/**
 * Main-thread fallback only: after the loop stops, queued frames drain before the context is released, because
 * `loseContext()` is synchronous and waits behind them (≈ 600 ms of frames on software GL; ~3 ms once drained).
 */
const RELEASE_AFTER_MS = 1000;
/** Backstop for a worker that never acknowledges `dispose` (it closes itself after releasing its context). */
const WORKER_TERMINATE_AFTER_MS = 5000;

const offscreenSupported = (): boolean =>
  typeof Worker === "function" &&
  typeof OffscreenCanvas === "function" &&
  "transferControlToOffscreen" in HTMLCanvasElement.prototype;

/** Runs `fn` after the browser has painted the current frame (so the page's text never waits on GL setup). */
function afterPaint(fn: () => void): () => void {
  let timer = 0;
  const raf = requestAnimationFrame(() => {
    timer = window.setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}

/** Drawing-buffer size for the canvas's CSS box (no layout reads: sizes come from a ResizeObserver). */
function bufferSize(entry: ResizeObserverEntry, scale: number): { w: number; h: number } {
  const box = entry.contentBoxSize[0];
  const cssW = box ? box.inlineSize : entry.contentRect.width;
  const cssH = box ? box.blockSize : entry.contentRect.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
  return { w: Math.max(1, Math.floor(cssW * dpr)), h: Math.max(1, Math.floor(cssH * dpr)) };
}

/**
 * A full-screen fragment-shader backdrop (the join and waiting-room candle). Rendering runs in a worker on an
 * OffscreenCanvas where supported, else on the main thread; either way it starts after the first paint, fades in
 * once its first frame is drawn (the candle "lights"), renders at a reduced resolution (`scale`) and ≤ 30 fps, and
 * draws a single still frame under reduced motion.
 */
export function ShaderCanvas({
  frag,
  uniforms = {},
  scale = 0.5,
  className = "",
  label,
}: {
  frag: string;
  uniforms?: Uniforms;
  scale?: number;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const uni = useRef(uniforms);
  const pushUniforms = useRef<((u: Uniforms) => void) | null>(null);
  const [lit, setLit] = useState(false);
  // A canvas can hand its control to a worker only once, so a new shader gets a fresh element.
  const [key, setKey] = useState(0);

  const uniformsJson = JSON.stringify(uniforms);
  useEffect(() => {
    uni.current = JSON.parse(uniformsJson) as Uniforms;
    pushUniforms.current?.(uni.current);
  }, [uniformsJson]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` remounts the canvas for a new shader
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const still = prefersReducedMotion();
    let teardown: (() => void) | null = null;
    let transferred = false;
    const cancelInit = afterPaint(() => {
      teardown = offscreenSupported() ? startInWorker(canvas, still) : startOnPage(canvas, still);
    });
    return () => {
      cancelInit();
      teardown?.();
      pushUniforms.current = null;
      setLit(false);
      if (transferred) setKey((k) => k + 1);
    };

    function startInWorker(canvas: HTMLCanvasElement, still: boolean): () => void {
      const worker = new Worker(new URL("./shader.worker.ts", import.meta.url), { type: "module" });
      const send = (m: ShaderWorkerIn, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
      worker.onmessage = (e: MessageEvent<ShaderWorkerOut>) => {
        if (e.data.type === "lit") setLit(true);
      };
      const offscreen = canvas.transferControlToOffscreen();
      transferred = true;
      send(
        { type: "init", canvas: offscreen, frag, still, preserve: __GLOAM_TEST__, uniforms: uni.current },
        [offscreen],
      );
      pushUniforms.current = (u) => send({ type: "uniforms", uniforms: u });
      const ro = new ResizeObserver(([entry]) => {
        if (entry) send({ type: "size", ...bufferSize(entry, scale) });
      });
      ro.observe(canvas);
      const onVis = () => send({ type: "visible", visible: !document.hidden });
      document.addEventListener("visibilitychange", onVis);
      return () => {
        ro.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        worker.onmessage = null;
        send({ type: "dispose" });
        window.setTimeout(() => worker.terminate(), WORKER_TERMINATE_AFTER_MS);
      };
    }

    function startOnPage(canvas: HTMLCanvasElement, still: boolean): (() => void) | null {
      const renderer = createShaderRenderer(canvas, frag, __GLOAM_TEST__);
      if (!renderer) return null;
      let size = { w: 0, h: 0 };
      const loop = runLoop({
        renderer,
        still,
        size: () => size,
        uniforms: () => uni.current,
        schedule: (fn) => {
          const id = requestAnimationFrame(fn);
          return () => cancelAnimationFrame(id);
        },
        onFirstFrame: () => setLit(true),
      });
      const ro = new ResizeObserver(([entry]) => {
        if (!entry) return;
        size = bufferSize(entry, scale);
        loop.resume();
      });
      ro.observe(canvas);
      const onVis = () => (document.hidden ? loop.pause() : loop.resume());
      document.addEventListener("visibilitychange", onVis);
      return () => {
        ro.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        loop.stop();
        window.setTimeout(() => renderer.dispose(), RELEASE_AFTER_MS);
      };
    }
  }, [frag, scale, key]);

  return (
    <canvas
      key={key}
      ref={ref}
      className={`transition-opacity duration-[var(--dur-scene)] ease-[var(--ease-out)] ${lit ? "opacity-100" : "opacity-0"} ${className}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
