import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../state/settings.ts";
import { type AmbientView, addAmbientView, ambientSupported } from "./ambientHost.ts";
import { createShaderRenderer, runLoop, type Uniforms } from "./renderer.ts";

export type { Uniforms };

/**
 * Main-thread fallback only: after the loop stops, queued frames drain before the context is released, because
 * `loseContext()` is synchronous and waits behind them (≈ 600 ms of frames on software GL; ~3 ms once drained).
 */
const RELEASE_AFTER_MS = 1000;
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
  // A canvas whose on-page context was released can't be reused, so a restart gets a fresh element.
  const [key, setKey] = useState(0);
  const [onPage, setOnPage] = useState(() => !ambientSupported());

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
    let consumed = false;
    const cancelInit = afterPaint(() => {
      teardown = onPage ? startOnPage(canvas, still) : startShared(canvas, still);
    });
    return () => {
      cancelInit();
      teardown?.();
      pushUniforms.current = null;
      setLit(false);
      if (consumed) setKey((k) => k + 1);
    };

    /** The shared ambient worker: frames arrive as ImageBitmaps for a `bitmaprenderer` canvas. */
    function startShared(canvas: HTMLCanvasElement, still: boolean): (() => void) | null {
      const ctx = canvas.getContext("bitmaprenderer");
      if (!ctx) {
        setOnPage(true);
        return null;
      }
      let view: AmbientView | null = null;
      let shown = false;
      const ro = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const size = bufferSize(entry, scale);
        if (view) view.size(size.w, size.h);
        else
          view = addAmbientView(
            { frag, still, uniforms: uni.current, ...size },
            {
              onFrame(bitmap) {
                if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                  canvas.width = bitmap.width;
                  canvas.height = bitmap.height;
                }
                ctx.transferFromImageBitmap(bitmap);
                if (!shown) {
                  shown = true;
                  setLit(true);
                }
              },
              // No WebGL in workers here: draw on the page instead (a fresh canvas; this one is a bitmap canvas).
              onFailed() {
                consumed = true;
                setOnPage(true);
              },
            },
          );
      });
      ro.observe(canvas);
      pushUniforms.current = (u) => view?.uniforms(u);
      return () => {
        ro.disconnect();
        view?.remove();
      };
    }

    function startOnPage(canvas: HTMLCanvasElement, still: boolean): (() => void) | null {
      // (A lost context given back draws again at once — a still frame under reduced motion too.)
      const renderer = createShaderRenderer(canvas, frag, __GLOAM_TEST__, () => loop.resume());
      if (!renderer) return null;
      consumed = true;
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
  }, [frag, scale, key, onPage]);

  return (
    <canvas
      key={key}
      ref={ref}
      className={`transition-opacity duration-[var(--dur-scene)] ease-[var(--ease-out)] ${lit ? "opacity-100" : "opacity-0"} ${className}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-lit={lit ? "true" : undefined}
    />
  );
}
