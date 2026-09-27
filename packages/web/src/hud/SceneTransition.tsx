import { useEffect, useRef, useState } from "react";
import { boardApi } from "../board/boardApi.ts";
import { useLoading } from "../board/diag.ts";
import { travelHooks, useEntities } from "../state/entities.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";
import { Divider } from "../ui/ornaments.tsx";

/**
 * Scene travel (SPEC §8.3 Scene activation, §27.7; AC-SCN-02, AC-BRD-05): fade through black with the scene name in
 * the display face. The moment the live scene changes, the old board is frozen into a still that covers the canvas
 * (captured synchronously, before the switch, so it can only show the old scene) and the real board switches to the
 * new scene underneath — its warm-up overlaps the fade-out. The still fades to black, the name shows, and the new
 * scene fades in once it has drawn and its assets are in (the parchment bar shows if that takes over 400 ms). The HUD
 * stays put.
 */
type Phase = "idle" | "out" | "title" | "in";

const OUT_MS = 400;
const TITLE_MIN_MS = 550;
const IN_MS = 500;
/** The new scene must have drawn this many frames before it's revealed. */
const WARM_FRAMES = 2;
/** Never keep the table dark longer than this waiting for assets; they finish loading in view. */
const LOAD_WAIT_MAX_MS = 8000;

const log: { sceneId: string; phase: Phase; at: number }[] = [];

export function SceneTransition() {
  const travel = useEntities((s) => s.travel);
  const [phase, setPhase] = useState<Phase>("idle");
  const [name, setName] = useState("");
  const phaseRef = useRef<Phase>("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stillHost = useRef<HTMLDivElement>(null);
  /** Board frame count when the switch happened (the new scene's frames come after it). */
  const switchedAt = useRef(0);
  const reduced = prefersReducedMotion();
  const out = reduced ? 150 : OUT_MS;
  const fadeIn = reduced ? 150 : IN_MS;

  useEffect(() => {
    provideTestHook("travel", () => ({ phase: phaseRef.current, log: [...log] }));
    // Synchronously, before the store switches scenes: freeze the old board over the canvas.
    travelHooks.beforeTravel = () => {
      const host = stillHost.current;
      const still = boardApi.snapshot();
      switchedAt.current = boardApi.frames;
      if (!host) return;
      host.replaceChildren();
      if (!still) return;
      still.className = "absolute inset-0 h-full w-full";
      host.appendChild(still);
    };
    return () => {
      travelHooks.beforeTravel = null;
    };
  }, []);

  useEffect(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    if (!travel) return;
    const to = (p: Phase) => {
      phaseRef.current = p;
      setPhase(p);
      log.push({ sceneId: travel.sceneId, phase: p, at: performance.now() });
    };
    const after = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    let raf = 0;
    setName(travel.name);

    const reveal = () => {
      const titleAt = performance.now();
      to("title");
      stillHost.current?.replaceChildren(); // under the black now
      const waitReady = () => {
        const waited = performance.now() - titleAt;
        const drawn = boardApi.frames - switchedAt.current >= WARM_FRAMES;
        const idle = useLoading.getState().pending === 0;
        if ((drawn && idle && waited >= (reduced ? 200 : TITLE_MIN_MS)) || waited >= LOAD_WAIT_MAX_MS) {
          to("in");
          after(fadeIn, () => {
            to("idle");
            useEntities.getState().endTravel();
          });
          return;
        }
        raf = requestAnimationFrame(waitReady);
      };
      raf = requestAnimationFrame(waitReady);
    };

    // Already dark (a second activation while the name is up): the new name shows straight away.
    if (phaseRef.current === "title") reveal();
    else {
      to("out");
      after(out, reveal);
    }
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
  }, [travel, out, fadeIn, reduced]);

  const dark = phase === "out" || phase === "title";
  const duration = phase === "out" ? out : fadeIn;
  return (
    <>
      {/* The old scene's still, shown only while the screen fades out. */}
      <div ref={stillHost} aria-hidden className="pointer-events-none absolute inset-0 z-[19]" />
      <div
        aria-hidden={phase === "idle"}
        data-testid="scene-transition"
        data-phase={phase}
        className="absolute inset-0 z-20 grid place-items-center bg-ink-950"
        style={{
          opacity: dark ? 1 : 0,
          pointerEvents: phase === "idle" ? "none" : "auto",
          transition: `opacity ${duration}ms var(--ease-in-out)`,
        }}
      >
        <div
          role={phase === "title" ? "status" : undefined}
          className="flex flex-col items-center gap-3 px-6 text-center"
          style={{
            opacity: phase === "title" ? 1 : 0,
            transform: phase === "title" || reduced ? "none" : "translateY(6px)",
            transition: `opacity ${reduced ? 120 : 360}ms var(--ease-out), transform ${reduced ? 0 : 480}ms var(--ease-out)`,
          }}
        >
          <p className="caps text-12 text-fog">The party travels to</p>
          <h2 className="font-display text-36 leading-[var(--leading-display)] text-bone sm:text-48">
            {name}
          </h2>
          <Divider className="w-40" />
        </div>
      </div>
    </>
  );
}
