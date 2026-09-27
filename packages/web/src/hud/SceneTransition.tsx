import { useEffect, useRef, useState } from "react";
import { useLoading } from "../board/diag.ts";
import { useEntities } from "../state/entities.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";
import { Divider } from "../ui/ornaments.tsx";

/**
 * Scene travel (SPEC §8.3 Scene activation, §27.7; AC-SCN-02, AC-BRD-05): fade through black with the scene name in
 * the display face. The old scene stays on the board while the screen darkens; the new one is swapped in under the
 * black, its assets load (the parchment bar shows if that takes over 400 ms), then it fades in. The HUD stays put.
 */
type Phase = "idle" | "out" | "title" | "in";

const OUT_MS = 400;
const TITLE_MIN_MS = 550;
const IN_MS = 500;
/** Never keep the table dark longer than this waiting for assets; they finish loading in view. */
const LOAD_WAIT_MAX_MS = 8000;

const log: { sceneId: string; phase: Phase; at: number }[] = [];

export function SceneTransition() {
  const travel = useEntities((s) => s.travel);
  const [phase, setPhase] = useState<Phase>("idle");
  const [name, setName] = useState("");
  const phaseRef = useRef<Phase>("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const reduced = prefersReducedMotion();
  const out = reduced ? 150 : OUT_MS;
  const fadeIn = reduced ? 150 : IN_MS;

  useEffect(() => {
    provideTestHook("travel", () => ({ phase: phaseRef.current, log: [...log] }));
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
      useEntities.getState().releaseHeld();
      const waitLoaded = () => {
        const waited = performance.now() - titleAt;
        const idle = useLoading.getState().pending === 0;
        if ((idle && waited >= (reduced ? 200 : TITLE_MIN_MS)) || waited >= LOAD_WAIT_MAX_MS) {
          to("in");
          after(fadeIn, () => {
            to("idle");
            useEntities.getState().endTravel();
          });
          return;
        }
        raf = requestAnimationFrame(waitLoaded);
      };
      // Two frames after the swap so the new scene's loads have registered before we look at them.
      raf = requestAnimationFrame(() => (raf = requestAnimationFrame(waitLoaded)));
    };

    // Already dark (a second activation while the name is up): swap straight away.
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
        <h2 className="font-display text-36 leading-[var(--leading-display)] text-bone sm:text-48">{name}</h2>
        <Divider className="w-40" />
      </div>
    </div>
  );
}
