import { EMOTES } from "@gloam/shared/protocol";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { boardApi } from "../board/boardApi.ts";
import { bodyRectOf, plateRectOf } from "../board/tokens/declutter.ts";
import { EMOTE_MS, type LiveEmote, useFun } from "../net/fun.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";

const GLYPH = new Map<string, string>(EMOTES.map((e) => [e.id, e.glyph]));

/** Where an emote pops: above its sender's token when this page sees it on screen, else above their portrait. */
function anchorOf(e: LiveEmote): { x: number; y: number; over: "token" | "portrait" } | null {
  if (e.tokenId) {
    const t = boardData(useEntities.getState()).tokens.get(e.tokenId);
    const canvas = boardApi.element?.getBoundingClientRect();
    // Above its plate (never over its name), else above its body, as the board has placed them (canvas px).
    const top = t && canvas ? (plateRectOf(e.tokenId) ?? bodyRectOf(e.tokenId)) : null;
    if (top && canvas) {
      const x = canvas.left + (top.x0 + top.x1) / 2;
      const y = canvas.top + top.y0 - 6;
      if (x > 0 && y > 60 && x < window.innerWidth && y < window.innerHeight) return { x, y, over: "token" };
    }
  }
  const el = document.querySelector<HTMLElement>(`[data-presence="${CSS.escape(e.userId)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Below the portrait (the top bar is at the screen's top edge).
  return { x: r.left + r.width / 2, y: r.bottom + 10, over: "portrait" };
}

/** Test builds: every pop shown here — whose, over what, and for how long (AC-FUN-01). */
const popLog: {
  userId: string;
  over: string;
  emote?: string;
  phrase?: string;
  shownAt: number;
  goneAt: number | null;
}[] = [];

function Pop({ e }: { e: LiveEmote }) {
  const [at, setAt] = useState(() => anchorOf(e));
  useEffect(() => {
    if (!__GLOAM_TEST__) return;
    const entry = {
      userId: e.userId,
      over: anchorOf(e)?.over ?? "nowhere",
      ...(e.emote ? { emote: e.emote } : { phrase: e.phrase }),
      shownAt: Date.now(),
      goneAt: null as number | null,
    };
    popLog.push(entry);
    return () => {
      entry.goneAt = Date.now();
    };
  }, [e]);
  // Follows its token as the camera moves, for as long as it shows.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      setAt(anchorOf(e));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [e]);
  if (!at) return null;
  const still = prefersReducedMotion();
  const below = at.over === "portrait";
  return (
    // Placed on its anchor (centred over a token's head, or under a portrait); the pop itself bounces inside.
    <div
      className={`pointer-events-none fixed z-[45] -translate-x-1/2 ${below ? "" : "-translate-y-full"}`}
      style={{ left: at.x, top: at.y }}
      data-testid="emote-pop"
      data-over={at.over}
      data-user={e.userId}
    >
      <motion.div
        initial={still ? { opacity: 0 } : { opacity: 0, scale: 0.3, y: below ? -6 : 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.8, y: below ? 4 : -10 }}
        transition={still ? { duration: 0.12 } : { type: "spring", stiffness: 520, damping: 14, mass: 0.7 }}
        style={{ transformOrigin: below ? "50% 0%" : "50% 100%" }}
      >
        {e.emote ? (
          <span className="block text-32 leading-none drop-shadow-[0_3px_6px_rgba(0,0,0,0.55)]" aria-hidden>
            {GLYPH.get(e.emote)}
          </span>
        ) : (
          <span
            className="panel relative block max-w-[240px] whitespace-nowrap px-3 py-1.5 text-14 font-bold text-bone"
            style={{ borderColor: e.color }}
          >
            {e.phrase}
          </span>
        )}
      </motion.div>
    </div>
  );
}

/**
 * Emotes as they come (SPEC §8.18; AC-FUN-01): each pops over its sender's token — or, when this page doesn't see
 * the token, their portrait in the top bar — with a bounce for 2.5 s, and joins a small transient feed at the top
 * left (who, what) that fades after a few seconds.
 */
export function EmoteLayer() {
  const emotes = useFun((s) => s.emotes);
  useEffect(() => provideTestHook("emotePops", () => popLog.map((p) => ({ ...p }))), []);
  const [now, setNow] = useState(() => performance.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!emotes.length) return;
    timer.current = setInterval(() => setNow(performance.now()), 250);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [emotes.length]);
  const showing = emotes.filter((e) => now - e.shownAt < EMOTE_MS);
  const feed = emotes.slice(-4);
  return createPortal(
    <>
      <AnimatePresence>
        {showing.map((e) => (
          <Pop key={e.key} e={e} />
        ))}
      </AnimatePresence>
      <ol
        className="pointer-events-none fixed left-4 top-[68px] z-[35] flex flex-col gap-1"
        aria-label="Emotes"
        aria-live="polite"
        data-testid="emote-feed"
      >
        <AnimatePresence initial={false}>
          {feed.map((e) => (
            <motion.li
              key={e.key}
              layout
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="flex max-w-[260px] items-center gap-1.5 rounded-[var(--radius-chip)] bg-[var(--scrim-soft)] px-2 py-0.5 text-13 text-bone backdrop-blur-[3px]"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: e.color }} aria-hidden />
              <span className="font-bold">{e.name}</span>
              {e.emote ? (
                <span role="img" aria-label={EMOTES.find((x) => x.id === e.emote)?.label}>
                  {GLYPH.get(e.emote)}
                </span>
              ) : (
                <span className="truncate text-muted">“{e.phrase}”</span>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </>,
    document.body,
  );
}
