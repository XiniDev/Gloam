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

/** A pop's size on screen (px): a disc for an emote, a one-line bubble for a phrase (its width by its words). */
function popSize(e: LiveEmote): { w: number; h: number } {
  return e.emote
    ? { w: DISC, h: DISC }
    : { w: Math.min(240, 32 + (e.phrase?.length ?? 0) * 8.5), h: PHRASE_H };
}

type Box = { x0: number; x1: number; y0: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * Where a pop under a portrait stands, clear of the HUD (critic P11 r2 N3): under the portrait if nothing's there;
 * else slid along the band to the nearest clear spot (the pop still ringed in its sender's colour); else under the
 * lowest piece of HUD in its column.
 */
function clearOfHud(x: number, y: number, size: { w: number; h: number }): { x: number; y: number } {
  const covers = Object.entries(useBoardCovers.getState().rects)
    .filter(([name]) => name !== "emote-feed" && name !== "toasts")
    .map(([, r]) => ({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom }));
  const at = (cx: number, top: number): Box => ({
    x0: cx - size.w / 2,
    x1: cx + size.w / 2,
    y0: top,
    y1: top + size.h,
  });
  const free = (b: Box) => b.x0 >= 8 && b.x1 <= window.innerWidth - 8 && !covers.some((c) => overlaps(b, c));
  if (free(at(x, y))) return { x, y };
  for (let d = 8; d <= 320; d += 8) for (const cx of [x - d, x + d]) if (free(at(cx, y))) return { x: cx, y };
  let top = y;
  for (let i = 0; i < 6; i++) {
    const hit = covers.filter((c) => overlaps(at(x, top), c));
    if (!hit.length) break;
    top = Math.max(...hit.map((c) => c.y1)) + 8;
  }
  return { x: Math.min(Math.max(x, size.w / 2 + 8), window.innerWidth - size.w / 2 - 8), y: top };
}

/**
 * Where an emote pops: above its sender's token when this page sees it on screen — above the token and its plate both,
 * never over its name or its own body (critic P11 r2 N4), and up past any other creature it would cover — else under
 * their portrait in the top bar, clear of the HUD there.
 */
function anchorOf(e: LiveEmote): { x: number; y: number; over: "token" | "portrait" } | null {
  const size = popSize(e);
  if (e.tokenId) {
    const t = boardData(useEntities.getState()).tokens.get(e.tokenId);
    const canvas = boardApi.element?.getBoundingClientRect();
    const plate = t && canvas ? plateRectOf(e.tokenId) : null;
    const body = t && canvas ? bodyRectOf(e.tokenId) : null;
    const top = plate && body ? (plate.y0 < body.y0 ? plate : body) : (plate ?? body);
    if (top && canvas) {
      const x = ((plate ?? top).x0 + (plate ?? top).x1) / 2;
      let y = Math.min(plate?.y0 ?? Number.POSITIVE_INFINITY, body?.y0 ?? Number.POSITIVE_INFINITY) - 6;
      // A creature (its own body too) where the pop would stand: the pop rises above it (a crowd stacks it up).
      const bodies = bodyRects();
      for (let i = 0; i < 5; i++) {
        const box = { x0: x - size.w / 2, x1: x + size.w / 2, y0: y - size.h, y1: y };
        const hit = bodies.find(({ r }) => overlaps(box, r));
        if (!hit) break;
        y = hit.r.y0 - 4;
      }
      const sx = canvas.left + x;
      const sy = canvas.top + y;
      if (sx > 0 && sy - size.h > 60 && sx < window.innerWidth && sy < window.innerHeight)
        return { x: sx, y: sy, over: "token" };
    }
  }
  const el = document.querySelector<HTMLElement>(`[data-presence="${CSS.escape(e.userId)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Below the portrait (the top bar is at the screen's top edge), clear of the HUD under it.
  const p = clearOfHud(r.left + r.width / 2, r.bottom + 10, size);
  return { x: p.x, y: p.y, over: "portrait" };
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
        key={e.key}
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
  // Test builds: pops held this long (key screens under software GL can't photograph a 2.5-s pop at rest).
  const [popMs, setPopMs] = useState(EMOTE_MS);
  useEffect(() => provideTestHook("emoteHold", (ms: number | null) => setPopMs(ms ?? EMOTE_MS)), []);
  const [now, setNow] = useState(() => performance.now());
  // Each pop goes when its 2.5 s are up — a timer for the next one due, not a poll that could hold it a beat longer.
  useEffect(() => {
    const t = performance.now();
    const due = emotes.map((e) => e.shownAt + popMs).filter((d) => d > now);
    if (!due.length) return;
    const id = setTimeout(() => setNow(performance.now()), Math.max(0, Math.min(...due) - t) + 5);
    return () => clearTimeout(id);
  }, [emotes, now, popMs]);
  // One pop per person: a new one takes the place of their last (two at one anchor drew over each other).
  const latest = new Map<string, LiveEmote>();
  for (const e of emotes) if (now - e.shownAt < popMs) latest.set(e.userId, e);
  const showing = [...latest.values()];
  const feed = emotes.slice(-4);
  // The feed is HUD over the board while it holds a line: plates keep out from under it.
  const ref = useRef<HTMLOListElement>(null);
  useCover("emote-feed", ref, feed.length > 0);
  const covers = useBoardCovers((s) => s.rects);
  const phone = useHudInsets((s) => s.cornerLeft) > 0;
  const { "emote-feed": _self, ...others } = covers;
  const h = ref.current?.offsetHeight ?? 0;
  // A phone's column starts right of its tools button — or back at the gutter once the feed stands below the button
  // (pushed down by the callout or the tracker; critic P11 r2 N27).
  const beside = phone ? (covers.toolbar?.right ?? 12) + 8 : 16;
  const besideTop = stackTop(
    phone ? 12 : 64,
    beside,
    beside + Math.min(260, window.innerWidth - beside - 12),
    others,
    h,
  );
  const below = phone && covers.toolbar && besideTop >= covers.toolbar.bottom;
  const x0 = below ? 12 : beside;
  const width = Math.min(260, window.innerWidth - x0 - 12);
  const top = below ? stackTop(besideTop, x0, x0 + width, others, h) : besideTop;
  return createPortal(
    <>
      <AnimatePresence>
        {showing.map((e) => (
          // One per person: keyed by who, so a new one takes the old one's place at once (never two, one fading
          // under the other — critic P11 r2 N5); the pop inside is keyed by the emote, so it bounces in afresh.
          <Pop key={e.userId} e={e} />
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
