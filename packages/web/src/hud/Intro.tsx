import { type CSSProperties, useEffect, useRef } from "react";
import { create } from "zustand";
import { ShaderCanvas } from "../board/ambient/ShaderCanvas.tsx";
import { CANDLE_FLAME, FLAME_UNIFORMS } from "../board/ambient/shaders.ts";
import { boardDiag, useLoading } from "../board/diag.ts";
import { useEntities } from "../state/entities.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";

/**
 * The first-load sequence (SPEC §27.7 signature moments, §8.4; AC-DS-04): black → a candle flame ignites in the
 * centre (400 ms) → the board fades up from darkness (900 ms) → HUD elements stagger in 60 ms apart. Click or any key
 * skips it. It runs once per page load; reduced motion replaces it with short fades.
 */
export type IntroPhase = "ignite" | "board" | "hud" | "done";

export const IGNITE_MS = 400;
export const BOARD_FADE_MS = 900;
export const HUD_STAGGER_MS = 60;
/** HUD groups that stagger in — top bar, toolbar, dock, board hint; the last starts at (n − 1) × 60 ms. */
export const HUD_GROUPS = 4;
const HUD_RISE_MS = 240;
/** The board fades up once its first frame is drawn and its assets are in, or after this long regardless. */
const BOARD_WAIT_MAX_MS = 6000;
const SKIP_FADE_MS = 150;
/** "Runs smoothly": SMOOTH_WINDOW_MS of frames each under SMOOTH_FRAME_MS (a warm-up stall can come a moment
 * after the first frame, so a couple of quick frames aren't proof). */
const SMOOTH_WINDOW_MS = 300;
const SMOOTH_FRAME_MS = 100;
/**
 * Fully opaque, the overlay would let the compositor skip the board canvas beneath it, and the first composite (a
 * multi-second stall under software GL) would land in the middle of the fade. At 99.5 % it looks the same and the
 * board is composited — and warmed up — from the start.
 */
const COVER_OPACITY = 0.995;

interface IntroStore {
  phase: IntroPhase;
  reduced: boolean;
  marks: Partial<Record<IntroPhase | "start" | "skipped", number>>;
  go(phase: IntroPhase): void;
}

let played = false;

export const useIntro = create<IntroStore>((set, get) => ({
  phase: "ignite",
  reduced: false,
  marks: {},
  go(phase) {
    if (get().phase === "done") return;
    set({ phase, marks: { ...get().marks, [phase]: performance.now() } });
    if (phase === "done") {
      played = true;
      useEntities.getState().arm();
    }
  },
}));

/** The data attribute the table root carries so HUD groups can hide and then stagger in (see globals.css). */
export function useIntroAttr(): IntroPhase {
  return useIntro((s) => s.phase);
}

/** Props for a HUD group: its place in the stagger (0 = first). Hidden until the board is up, then rises in. */
export function hudOrder(i: number): { "data-hud-order": number; style: CSSProperties } {
  return { "data-hud-order": i, style: { "--hud-i": i } as CSSProperties };
}

export function Intro() {
  const phase = useIntro((s) => s.phase);
  const reduced = useIntro((s) => s.reduced);
  const marks = useIntro((s) => s.marks);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const intro = useIntro.getState();
    if (played) {
      intro.go("done");
      return;
    }
    const r = prefersReducedMotion();
    useIntro.setState({
      phase: "ignite",
      reduced: r,
      marks: { start: performance.now(), ignite: performance.now() },
    });
    provideTestHook("intro", () => ({ ...useIntro.getState(), played }));
    const after = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    const startedAt = performance.now();
    let raf = 0;
    let lastFrame = 0;
    let smoothSince = 0;
    // Hold on the lit candle until the board has drawn, loaded, and runs smoothly (never less than the ignition
    // itself): a slow machine pays its warm-up behind the candle instead of stuttering through the fade.
    const waitForBoard = (now: number) => {
      const elapsed = performance.now() - startedAt;
      // A frame slower than SMOOTH_FRAME_MS (a stall: shader compiles, first composites) restarts the window.
      if (boardDiag.firstFrameAt === null || !lastFrame || now - lastFrame >= SMOOTH_FRAME_MS)
        smoothSince = now;
      lastFrame = now;
      const ready =
        boardDiag.firstFrameAt !== null &&
        useLoading.getState().pending === 0 &&
        now - smoothSince >= SMOOTH_WINDOW_MS;
      if ((ready && elapsed >= (r ? 0 : IGNITE_MS)) || elapsed >= BOARD_WAIT_MAX_MS) {
        useIntro.getState().go("board");
        const fade = r ? 200 : BOARD_FADE_MS;
        after(fade, () => {
          useIntro.getState().go("hud");
          after(r ? 120 : (HUD_GROUPS - 1) * HUD_STAGGER_MS + HUD_RISE_MS, () =>
            useIntro.getState().go("done"),
          );
        });
        return;
      }
      raf = requestAnimationFrame(waitForBoard);
    };
    raf = requestAnimationFrame(waitForBoard);
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
  }, []);

  const skip = () => {
    const st = useIntro.getState();
    if (st.phase === "done" || st.phase === "hud" || st.marks.skipped) return;
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    useIntro.setState({ reduced: true, marks: { ...st.marks, skipped: performance.now() } });
    st.go("board");
    timers.current.push(setTimeout(() => useIntro.getState().go("done"), SKIP_FADE_MS));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `skip` only reads the store
  useEffect(() => {
    if (phase === "done" || phase === "hud") return;
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [phase]);

  if (phase === "done" || phase === "hud") return null;
  const fading = phase === "board";
  const skipped = marks.skipped !== undefined;
  return (
    <div
      role="presentation"
      data-testid="intro"
      onPointerDown={skip}
      className="fixed inset-0 z-[800] grid cursor-pointer place-items-center bg-ink-950"
      style={{
        opacity: fading ? 0 : COVER_OPACITY,
        transition: `opacity ${skipped ? SKIP_FADE_MS : reduced ? 200 : BOARD_FADE_MS}ms var(--ease-in-out)`,
      }}
    >
      <div
        className="relative h-[180px] w-[120px]"
        style={{
          animation: reduced ? undefined : `intro-ignite ${IGNITE_MS}ms var(--ease-out) both`,
        }}
      >
        <div
          aria-hidden
          className="absolute inset-[-120%] rounded-full"
          style={{ background: "radial-gradient(closest-side, var(--glow-candle), transparent)" }}
        />
        <ShaderCanvas
          frag={CANDLE_FLAME}
          uniforms={FLAME_UNIFORMS}
          scale={1}
          className="absolute inset-0 h-full w-full"
          label="A candle flame"
        />
      </div>
      <span className="sr-only">Lighting the table. Press any key to skip.</span>
    </div>
  );
}
