import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { audio } from "../../audio/engine.ts";
import { cameraRig } from "../../board/CameraRig.tsx";
import { yourTurn } from "../../net/combat.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { prefersReducedMotion, useSettings } from "../../state/settings.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { keepHyphenated } from "../../ui/text.tsx";
import { useCover, useHudInsets, useIsPhone } from "../insets.ts";

/** How long the banner stays (ms). */
const SHOW_MS = 2600;
/** How long the camera takes to reach the creature (ms; the camera's own glide, §8.4). */
const FOCUS_MS = 600;

/** Turn starts announced here (tests: what was heard and shown, and whether the camera went). */
const announced: { tokenId: string; round: number; focused: boolean; at: number }[] = [];

/**
 * A turn of this person's begins (SPEC §8.12 Turn flow, §27.7): the "your turn" bell, a banner under the tracker
 * naming the creature, and — when they've asked for it (Settings → Focus camera on my turn) — the view gliding to it.
 */
export function TurnBanner() {
  const [shown, setShown] = useState<{ name: string; round: number; key: number } | null>(null);
  const top = useHudInsets((s) => s.top + s.banner + s.tracker);
  const phone = useIsPhone();
  // While it shows, the name plates keep out from under where it comes to rest — from its first frame, not where its
  // entrance starts (critic P8 r1 #3, r2 B2).
  const card = useRef<HTMLDivElement>(null);
  useCover("turn-banner", card, shown !== null, true);
  useEffect(() => {
    if (__GLOAM_TEST__) provideTestHook("turnsAnnounced", () => announced.map((a) => ({ ...a })));
    return yourTurn.on((t) => {
      void audio.play("yourTurn");
      setShown({ name: t.name, round: t.round, key: Date.now() });
      let focused = false;
      if (useSettings.getState().focusOnMyTurn) {
        const token = boardData(useEntities.getState()).tokens.get(t.tokenId);
        if (token) {
          cameraRig.moveTargetTo(token.pos.x, token.pos.y, prefersReducedMotion() ? 0 : FOCUS_MS);
          focused = true;
        }
      }
      if (__GLOAM_TEST__) announced.push({ tokenId: t.tokenId, round: t.round, focused, at: Date.now() });
    });
  }, []);
  useEffect(() => {
    if (!shown) return;
    const id = window.setTimeout(() => setShown(null), SHOW_MS);
    return () => window.clearTimeout(id);
  }, [shown]);
  return (
    <div
      className="pointer-events-none absolute z-40 flex justify-center"
      // A phone: between its corner clusters (the tools button, the dock's rail), on two lines if it must.
      style={phone ? { top: top + 12, left: 84, right: 84 } : { top: top + 12, left: 0, right: 0 }}
    >
      <AnimatePresence>
        {shown ? (
          <motion.div
            ref={card}
            key={shown.key}
            role="status"
            aria-live="polite"
            data-testid="turn-banner"
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.2 } }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className={`panel flex border-brass/70 shadow-[0_0_0_2px_var(--glow-brass),var(--shadow-float)] ${
              phone
                ? "flex-col items-center gap-0.5 px-4 py-2 text-center"
                : "items-baseline gap-3 px-5 py-2.5"
            }`}
          >
            <span className="display text-22 text-brass-bright">Your turn</span>
            <span className="text-16 font-bold text-bone">{keepHyphenated(shown.name)}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
