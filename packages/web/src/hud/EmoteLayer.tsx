import { EMOTES } from "@gloam/shared/protocol";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { boardApi } from "../board/boardApi.ts";
import { bodyRectOf, bodyRects, plateRectOf } from "../board/tokens/declutter.ts";
import { EMOTE_MS, type LiveEmote, useFun } from "../net/fun.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";
import { stackTop } from "../ui/Toast.tsx";
import { useBoardCovers, useCover, useHudInsets } from "./insets.ts";

const GLYPH = new Map<string, string>(EMOTES.map((e) => [e.id, e.glyph]));
/** An emote pop's disc (px): the glyph on ink, ringed in its sender's colour — legible over any floor. */
const DISC = 52;
/** A phrase pop's height (px). */
const PHRASE_H = 40;

/**
 * Where an emote pops: above its sender's token when this page sees it on screen — above its plate, never over its
 * name, and up past any other creature the pop would cover — else under their portrait in the top bar.
 */
function anchorOf(e: LiveEmote): { x: number; y: number; over: "token" | "portrait" } | null {
  if (e.tokenId) {
    const t = boardData(useEntities.getState()).tokens.get(e.tokenId);
    const canvas = boardApi.element?.getBoundingClientRect();
    // Above its plate, else above its body, as the board has placed them (canvas px).
    const top = t && canvas ? (plateRectOf(e.tokenId) ?? bodyRectOf(e.tokenId)) : null;
    if (top && canvas) {
      const x = (top.x0 + top.x1) / 2;
      const h = e.emote ? DISC : PHRASE_H;
      const w = e.emote ? DISC : 200;
      let y = top.y0 - 6;
      // Another creature where the pop would stand: the pop rises above it (a few at most — a crowd stacks up).
      const others = bodyRects().filter((b) => b.id !== e.tokenId);
      for (let i = 0; i < 4; i++) {
        const hit = others.find(({ r }) => r.x0 < x + w / 2 && r.x1 > x - w / 2 && r.y0 < y && r.y1 > y - h);
        if (!hit) break;
        y = hit.r.y0 - 4;
      }
      const sx = canvas.left + x;
      const sy = canvas.top + y;
      if (sx > 0 && sy - h > 60 && sx < window.innerWidth && sy < window.innerHeight)
        return { x: sx, y: sy, over: "token" };
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
        // (It bounces in; it goes in a quick fade — the entry's spring made its going last as long again.)
        exit={{ opacity: 0, scale: 0.8, y: below ? 4 : -10, transition: { duration: 0.2, ease: "easeIn" } }}
        transition={still ? { duration: 0.12 } : { type: "spring", stiffness: 520, damping: 14, mass: 0.7 }}
        style={{ transformOrigin: below ? "50% 0%" : "50% 100%" }}
      >
        {e.emote ? (
          <span
            className="grid place-items-center rounded-full bg-ink-900"
            style={{ width: DISC, height: DISC, boxShadow: `0 0 0 2px ${e.color}, var(--shadow-panel)` }}
            aria-hidden
          >
            <span className="text-36 leading-none">{GLYPH.get(e.emote)}</span>
          </span>
        ) : (
          <span
            className="panel relative block max-w-[240px] whitespace-nowrap px-3 py-2 text-16 font-bold text-bone"
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
 * left (who, what) that fades after a few seconds — below whatever HUD stands in its column (the title, the tracker;
 * on a phone it stands right of the tools button), the way the toasts keep clear.
 */
export function EmoteLayer() {
  const emotes = useFun((s) => s.emotes);
  useEffect(() => provideTestHook("emotePops", () => popLog.map((p) => ({ ...p }))), []);
  const [now, setNow] = useState(() => performance.now());
  // Each pop goes when its 2.5 s are up — a timer for the next one due, not a poll that could hold it a beat longer.
  useEffect(() => {
    const t = performance.now();
    const due = emotes.map((e) => e.shownAt + EMOTE_MS).filter((d) => d > now);
    if (!due.length) return;
    const id = setTimeout(() => setNow(performance.now()), Math.max(0, Math.min(...due) - t) + 5);
    return () => clearTimeout(id);
  }, [emotes, now]);
  const showing = emotes.filter((e) => now - e.shownAt < EMOTE_MS);
  const feed = emotes.slice(-4);
  // The feed is HUD over the board while it holds a line: plates keep out from under it.
  const ref = useRef<HTMLOListElement>(null);
  useCover("emote-feed", ref, feed.length > 0);
  const covers = useBoardCovers((s) => s.rects);
  const phone = useHudInsets((s) => s.cornerLeft) > 0;
  const x0 = phone ? (covers.toolbar?.right ?? 12) + 8 : 16;
  const width = Math.min(260, window.innerWidth - x0 - 12);
  const { "emote-feed": _self, ...others } = covers;
  const top = stackTop(phone ? 12 : 64, x0, x0 + width, others, ref.current?.offsetHeight ?? 0);
  return createPortal(
    <>
      <AnimatePresence>
        {showing.map((e) => (
          <Pop key={e.key} e={e} />
        ))}
      </AnimatePresence>
      <ol
        ref={ref}
        className="pointer-events-none fixed z-[35] flex flex-col items-start gap-1"
        style={{ left: x0, top, width }}
        aria-label="Emotes"
        aria-live="polite"
        data-testid="emote-feed"
      >
        <AnimatePresence initial={false}>
          {feed.map((e) => (
            <motion.li
              key={e.key}
              layout="position"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="panel flex max-w-full items-center gap-2 px-2.5 py-1 text-13 text-bone"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: e.color }} aria-hidden />
              <span className="font-bold">{e.name}</span>
              {e.emote ? (
                <span
                  className="text-16 leading-none"
                  role="img"
                  aria-label={EMOTES.find((x) => x.id === e.emote)?.label}
                >
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
