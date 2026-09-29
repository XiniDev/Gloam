import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { audio } from "../../audio/engine.ts";
import { cameraRig } from "../../board/CameraRig.tsx";
import { yourTurn } from "../../net/combat.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { prefersReducedMotion, useSettings } from "../../state/settings.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { keepHyphenated } from "../../ui/text.tsx";
import { useHudInsets } from "../insets.ts";

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
      className="pointer-events-none absolute inset-x-0 z-40 flex justify-center"
      style={{ top: top + 12 }}
    >
      <AnimatePresence>
        {shown ? (
          <motion.div
            key={shown.key}
            role="status"
            aria-live="polite"
            data-testid="turn-banner"
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.2 } }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="panel flex items-baseline gap-3 border-brass/70 px-5 py-2.5 shadow-[0_0_0_2px_var(--glow-brass),var(--shadow-float)]"
          >
            <span className="display text-22 text-brass-bright">Your turn</span>
            <span className="text-16 font-bold text-bone">{keepHyphenated(shown.name)}</span>
            <span className="caps text-12 text-fog">Round {shown.round}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
