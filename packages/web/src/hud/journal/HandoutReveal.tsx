import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { nextReveal, useFun } from "../../net/fun.ts";
import { prefersReducedMotion } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { HandoutCard } from "./HandoutCard.tsx";

const closeReveal = nextReveal;

/**
 * A handout or secret note arriving (SPEC §8.18; AC-FUN-04): the parchment unfurls from its top edge over the table
 * (with the paper sound), to be read and put away with the rest of this person's handouts (Journal → Handouts).
 */
export function HandoutReveal() {
  const h = useFun((s) => s.reveal);
  const keep = useRef<HTMLButtonElement>(null);
  const still = prefersReducedMotion();
  const close = closeReveal;
  useEffect(() => {
    if (!h) return;
    const t = setTimeout(() => keep.current?.focus(), 350);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeReveal();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [h]);
  return createPortal(
    // One leaves before the next comes (mode "wait"): never two parchments over each other.
    <AnimatePresence mode="wait">
      {h ? (
        <motion.div
          key={h.id}
          className="fixed inset-0 z-[80] grid place-items-center bg-[var(--scrim)] p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
          data-testid="handout-reveal"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={h.kind === "note" ? "A secret note for you" : `Handout: ${h.title}`}
            className="flex max-h-[88vh] w-[min(520px,100%)] flex-col gap-4 overflow-y-auto"
            style={{ transformOrigin: "50% 0%" }}
            // Unrolled from its top: the scroll drops open, then settles.
            initial={still ? { opacity: 0 } : { scaleY: 0.04, opacity: 0.4, y: -30 }}
            animate={{ scaleY: 1, opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={still ? { duration: 0.14 } : { duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          >
            <HandoutCard h={h} eyebrow={h.kind === "note" ? "A secret note" : "A handout from the DM"} />
            <div className="flex justify-center gap-2">
              <Button
                variant="secondary"
                size="M"
                onClick={() => {
                  close();
                  useUi.getState().set({ dock: "journal" });
                }}
              >
                All my handouts
              </Button>
              <Button ref={keep} variant="primary" size="M" onClick={close}>
                Keep it
              </Button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
