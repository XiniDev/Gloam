import type { DmPromptView, RequestCard } from "@gloam/shared/protocol";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import { create } from "zustand";
import { audio } from "../audio/engine.ts";
import { boardApi } from "../board/boardApi.ts";
import { cameraRig } from "../board/CameraRig.tsx";
import { bodyRects } from "../board/tokens/declutter.ts";
import { promptArrived } from "../net/health.ts";
import { requestArrived } from "../net/sheets.ts";
import { useSpells } from "../net/spells.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { useTargeting } from "../state/targeting.ts";
import { useUi } from "../state/ui.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { PromptCard, usePromptList } from "./health/PromptCards.tsx";
import {
  PHONE_BOTTOM_BAND,
  useCover,
  useHudInsets,
  useHudObstacles,
  useIsPhone,
  useObstacle,
} from "./insets.ts";
import { RequestGroupCard, useRequestGroups } from "./RequestCards.tsx";
import { castHidden } from "./spells/castHide.ts";
import { ResolutionCard } from "./spells/ResolutionCard.tsx";

/** Below this width a screen shows two cards at once, then "Show n more" (critic P7 r2 #7). */
const WIDE = 1200;
const COLUMN_W = 380;
/** Narrower than this, a card's lines wrap and its buttons stack: no place for the stack. */
const COLUMN_MIN = 340;

/** Where the stack stands on the free board (desktop). */
interface Place {
  anchor: "top" | "foot";
  align: "center" | "start" | "end";
}
const TOP: Place = { anchor: "top", align: "center" };
/** In order of preference when they cover alike. */
const PLACES: readonly Place[] = [
  TOP,
  { anchor: "top", align: "start" },
  { anchor: "top", align: "end" },
  { anchor: "foot", align: "center" },
  { anchor: "foot", align: "start" },
  { anchor: "foot", align: "end" },
];

/** When each card was first seen here (ms): the stack's order, the same for requests and the DM's prompts. */
const firstSeen = new Map<string, number>();
function seenAt(key: string): number {
  let at = firstSeen.get(key);
  if (at === undefined) {
    at = Date.now();
    firstSeen.set(key, at);
  }
  return at;
}

/** Whether cards hold a phone's bottom band now: the roll feed's pill steps back from behind them. */
export const useCardsAtBottom = create<{ on: boolean }>(() => ({ on: false }));

interface Item {
  key: string;
  at: number;
  /** The creatures it's about: the stack keeps off them where it can. */
  subjects: string[];
  node: ReactNode;
}

/**
 * The cards floating over the board (SPEC §8.9 roll requests, §8.11 the DM's prompts): the players' roll requests
 * and the DM's decisions in one stack, oldest first. On a larger screen three at once (two under 1200 px), then "Show
 * n more"; on a phone one at a time, paged, above the dice button — its roll feed out from behind it (critic P7 r2
 * #7). Across the free board between the toolbar and the dock: at its top, or at its foot when that buries fewer of
 * the creatures on it — the ones the cards are about above all — decided as cards come and go, never while they're
 * read. A phone with a panel open takes them into the panel instead (RequestCards, PromptCards).
 */
/** A scrolling stack's edges: the content (and the cards' shadows) fading out over its 12-px margin on every side. */
const EDGE_FADE =
  "linear-gradient(to bottom, transparent 0, black 12px, black calc(100% - 12px), transparent 100%), linear-gradient(to right, transparent 0, black 12px, black calc(100% - 12px), transparent 100%)";

export function FloatingCards() {
  const groups = useRequestGroups();
  const prompts = usePromptList();
  const casts = useSpells((st) => st.casts);
  const hiddenCasts = useSpells((st) => st.hiddenCasts);
  const phone = useIsPhone();
  const dockOpen = useUi((s) => s.dock !== null);
  const away = phone && dockOpen;
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [
      ...prompts.map((p: DmPromptView) => ({
        key: `p:${p.id}`,
        at: seenAt(`p:${p.id}`),
        subjects: p.tokenId ? [p.tokenId] : [],
        node: <PromptCard key={`p:${p.id}`} p={p} compact={false} />,
      })),
      // Resolution cards (§8.13): the DM's whole card, the caster's rolls — about the creatures they're aimed at.
      ...[...casts.values()]
        .filter((c) => !castHidden(c, hiddenCasts))
        .map((c) => ({
          key: `c:${c.id}`,
          at: seenAt(`c:${c.id}`),
          subjects: c.targets.map((t) => t.id),
          node: <ResolutionCard key={`c:${c.id}`} c={c} />,
        })),
      ...groups.map((rows: RequestCard[]) => {
        const first = rows[0] as RequestCard;
        return {
          key: `r:${first.requestId}`,
          at: seenAt(`r:${first.requestId}`),
          subjects: rows.map((r) => r.targetId),
          node: <RequestGroupCard key={`r:${first.requestId}`} rows={rows} compact={false} />,
        };
      }),
    ];
    return out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  }, [groups, prompts, casts, hiddenCasts]);
  const shown = items.length > 0 && !away;

  const top = useHudInsets((s) => s.top);
  const banner = useHudInsets((s) => s.banner);
  // Under the turn tracker once there is one (§8.12).
  const tracker = useHudInsets((s) => s.tracker);
  const left = useHudInsets((s) => s.left);
  const right = useHudInsets((s) => s.right);
  const bottom = useHudInsets((s) => s.bottom);
  const feed = useHudObstacles((s) => s.rects.feed);
  const ref = useRef<HTMLOListElement>(null);
  useObstacle("cards", ref, shown);
  useCover("cards", ref, shown);
  // A new card arrives with a soft chime (someone is waiting on it).
  useEffect(() => {
    const a = requestArrived.on(() => void audio.play("chime"));
    const b = promptArrived.on(() => void audio.play("chime"));
    return () => {
      a();
      b();
    };
  }, []);

  const [all, setAll] = useState(false);
  const [page, setPage] = useState(0);
  const keys = items.map((i) => i.key).join(",");
  // A phone pages through them: kept on the same card as others come and go, else the nearest.
  const pageKey = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the cards shown, not their contents
  useEffect(() => {
    const at = pageKey.current ? items.findIndex((i) => i.key === pageKey.current) : -1;
    setPage((p) => (at >= 0 ? at : Math.min(p, Math.max(0, items.length - 1))));
    if (items.length <= 1) setAll(false);
  }, [keys]);
  pageKey.current = items[page]?.key ?? null;

  // The stack clips only while it scrolls. A float shadow reaches ~48 px round a card and 66 below it: cut at the
  // list's 12-px margin, it read as a hard-edged dark box round every card (found in the C4 held-roll capture). A stack
  // that fits leaves its shadows whole; one that scrolls fades its edges instead (EDGE_FADE), so neither a shadow nor
  // a card passing under an edge is ever sliced through.
  const [scrolls, setScrolls] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again as the cards shown change
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !shown || phone) {
      setScrolls(false);
      return;
    }
    const measure = () => setScrolls(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  }, [keys, shown, phone, all]);

  // Where on the free board: its top or its foot, centred or against either side — the place that covers least of the
  // creatures on the board (the ones the cards are about ten times over), the top centred when it's a tie. The foot
  // only where a whole card fits beside the roll feed. Worked out when the cards change or the free board does (a
  // panel opening), from how tall the stack is (desktop); never as the camera moves; and it moves only for a clearly
  // better place (under half the cover).
  const [place, setPlace] = useState<Place>(TOP);
  const feedRight = feed?.right ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: decided as cards and the HUD change, not as the view moves
  useLayoutEffect(() => {
    if (!shown || phone) return;
    const el = ref.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    const subjects = new Set(items.flatMap((i) => i.subjects));
    const x1 = window.innerWidth - right - 8;
    const bodies = bodyRects();
    const cost = (p: Place): number | null => {
      const x0 = p.anchor === "foot" ? Math.max(left, feedRight - 8) + 8 : left + 8;
      const w = Math.min(COLUMN_W, x1 - x0);
      if (w < COLUMN_MIN) return null;
      const bx0 = p.align === "start" ? x0 : p.align === "end" ? x1 - w : (x0 + x1) / 2 - w / 2;
      const y0 =
        p.anchor === "top"
          ? top + banner + tracker + 8
          : window.innerHeight - Math.max(bottom, PHONE_BOTTOM_BAND) - 8 - h;
      const box = { x0: bx0, x1: bx0 + w, y0, y1: y0 + h };
      return bodies.reduce((c, { id, r }) => {
        const a =
          Math.max(0, Math.min(box.x1, r.x1) - Math.max(box.x0, r.x0)) *
          Math.max(0, Math.min(box.y1, r.y1) - Math.max(box.y0, r.y0));
        return c + a * (subjects.has(id) ? 10 : 1);
      }, 0);
    };
    setPlace((was) => {
      let best: Place | null = null;
      let bestCost = Number.POSITIVE_INFINITY;
      for (const p of PLACES) {
        const c = cost(p);
        if (c !== null && c < bestCost) {
          best = p;
          bestCost = c;
        }
      }
      if (!best) return TOP;
      const now = cost(was);
      // Where it was is no longer possible (too narrow): the best place; else only a clearly better one.
      return now === null || bestCost < now * 0.5 ? best : was;
    });
  }, [keys, all, shown, phone, left, right, top, bottom, banner, tracker, feedRight]);

  // A new card over the creatures it's about (no place on the free board clears them all — critic P9 r1 #5): the view
  // slides the least that brings them out from under it, on the free board. Once per new card, never as it's read.
  // Measured once its place has held still for a moment (the placement is itself an effect: measured at once, the card
  // was still at its default spot, and the view slid the creature under where the stack then went — found by the P6
  // journey), and never while someone is working the board (a pointer held, a spell being aimed): the view is theirs.
  const nudged = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: per new card (keys), after its place is settled
  useEffect(() => {
    if (!shown) return;
    const fresh = items.filter((i) => !nudged.current.has(i.key));
    if (!fresh.length) return;
    const timer = window.setTimeout(() => {
      for (const i of items) nudged.current.add(i.key);
      if (pointerHeld() || useTargeting.getState().t) return;
      const el = ref.current;
      if (!el) return;
      const card = el.getBoundingClientRect();
      const board = boardApi.element?.getBoundingClientRect();
      const ox = board?.left ?? 0;
      const oy = board?.top ?? 0;
      const subjects = new Set(fresh.flatMap((i) => i.subjects));
      const under = bodyRects()
        .filter(({ id }) => subjects.has(id))
        .map(({ r }) => ({ x0: r.x0 + ox, y0: r.y0 + oy, x1: r.x1 + ox, y1: r.y1 + oy }))
        .filter((r) => r.x0 < card.right && r.x1 > card.left && r.y0 < card.bottom && r.y1 > card.top);
      if (!under.length) return;
      const u = {
        x0: Math.min(...under.map((r) => r.x0)),
        y0: Math.min(...under.map((r) => r.y0)),
        x1: Math.max(...under.map((r) => r.x1)),
        y1: Math.max(...under.map((r) => r.y1)),
      };
      // The free board: inside the HUD's columns and bands.
      const free = {
        x0: left + 12,
        y0: top + banner + tracker + 12,
        x1: window.innerWidth - right - 12,
        y1: window.innerHeight - Math.max(bottom, PHONE_BOTTOM_BAND) - 12,
      };
      const GAP = 14;
      const moves = [
        { dx: card.left - GAP - u.x1, dy: 0 },
        { dx: card.right + GAP - u.x0, dy: 0 },
        { dx: 0, dy: card.top - GAP - u.y1 },
        { dx: 0, dy: card.bottom + GAP - u.y0 },
      ].filter(
        (m) =>
          u.x0 + m.dx >= free.x0 &&
          u.x1 + m.dx <= free.x1 &&
          u.y0 + m.dy >= free.y0 &&
          u.y1 + m.dy <= free.y1,
      );
      if (!moves.length) return;
      const m = moves.reduce((a, b) => (Math.hypot(a.dx, a.dy) <= Math.hypot(b.dx, b.dy) ? a : b));
      // The table point that must come under the centre of the screen for everything to slide by (dx, dy).
      const cx = (board?.left ?? 0) + (board?.width ?? window.innerWidth) / 2;
      const cy = (board?.top ?? 0) + (board?.height ?? window.innerHeight) / 2;
      const here = boardApi.groundAt(cx, cy);
      const there = boardApi.groundAt(cx - m.dx, cy - m.dy);
      const t = cameraRig.controls?.getTarget(new Vector3());
      if (!here || !there || !t) return;
      cameraRig.moveTargetTo(
        t.x + (there.x - here.x),
        t.z + (there.y - here.y),
        prefersReducedMotion() ? 0 : 420,
      );
    }, 450);
    return () => window.clearTimeout(timer);
  }, [keys, place, shown]);

  const atBottom = shown && phone;
  useEffect(() => {
    useCardsAtBottom.setState({ on: atBottom });
    return () => useCardsAtBottom.setState({ on: false });
  }, [atBottom]);

  if (!shown) return null;
  const fold = window.innerWidth >= WIDE ? 3 : 2;
  const max = phone ? 1 : all ? items.length : fold;
  const visible = phone ? items.slice(page, page + 1) : items.slice(0, max);
  // At its foot on a larger screen, the stack keeps right of the roll feed along the bottom.
  const footLeft = Math.max(left, feedRight - 8) + 8;
  const foot = place.anchor === "foot";
  const justify =
    place.align === "start" ? "justify-start" : place.align === "end" ? "justify-end" : "justify-center";
  return (
    <div
      className={`pointer-events-none absolute z-30 flex ${phone ? "justify-center" : justify}`}
      style={
        phone
          ? // A phone's cards stand above the dice button and the roll feed (under the top corners they hid the
            // creature they're about — critic P7 r1), in thumb's reach.
            { bottom: Math.max(bottom, PHONE_BOTTOM_BAND) + 8, left: 12, right: 12 }
          : foot
            ? { bottom: Math.max(bottom, PHONE_BOTTOM_BAND) + 8, left: footLeft, right: right + 8 }
            : { top: top + banner + tracker + 8, left: left + 8, right: right + 8 }
      }
      data-testid="floating-cards"
      data-anchor={phone ? "phone" : place.anchor}
      data-align={phone ? "center" : place.align}
    >
      <ol
        ref={ref}
        aria-label="Waiting for you"
        // (A margin round the cards, the scrolling stack's fade: the cards stay 380 wide.)
        className={`pointer-events-none -m-3 flex w-[calc(100%+1.5rem)] max-w-[404px] flex-col gap-2 p-3 ${scrolls ? "overflow-y-auto overscroll-contain" : "overflow-visible"}`}
        data-scrolls={scrolls}
        // Never past the screen's free height (critic P9 r2 #17: three cards ran under the dice button and off the
        // foot): the stack scrolls instead, between the top HUD and the bottom band.
        style={
          phone
            ? undefined
            : {
                maxHeight: Math.max(
                  160,
                  window.innerHeight -
                    (foot ? 0 : top + banner + tracker + 8) -
                    Math.max(bottom, PHONE_BOTTOM_BAND) -
                    (foot ? top + banner + tracker + 16 : 16) +
                    24,
                ),
                ...(scrolls
                  ? {
                      maskImage: EDGE_FADE,
                      WebkitMaskImage: EDGE_FADE,
                      maskComposite: "intersect",
                      WebkitMaskComposite: "source-in",
                    }
                  : {}),
              }
        }
        data-testid="card-stack"
      >
        {phone ? (
          // A phone's card as a sheet at §28's first snap (30 % of the screen), the board above it in view (critic P9
          // r1 #18: a card covered it whole); its handle raises it to the next (60 %) and back.
          <li className="pointer-events-auto flex flex-col">
            <PhoneCardSheet key={visible[0]?.key}>{visible.map((i) => i.node)}</PhoneCardSheet>
          </li>
        ) : (
          visible.map((i) => i.node)
        )}
        {phone && items.length > 1 ? (
          <li className="self-center">
            <nav
              aria-label="Cards"
              className="panel pointer-events-auto flex items-center gap-1 rounded-chip px-1 py-0.5"
            >
              <IconButton
                label="Previous card"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <span className="tabular px-1 text-13 text-fog" data-testid="card-page">
                {page + 1} of {items.length}
              </span>
              <IconButton
                label="Next card"
                disabled={page >= items.length - 1}
                onClick={() => setPage((p) => Math.min(items.length - 1, p + 1))}
              >
                <ChevronRight size={18} />
              </IconButton>
            </nav>
          </li>
        ) : null}
        {!phone && items.length > max ? (
          <li className="self-center">
            <Button size="S" variant="secondary" className="pointer-events-auto" onClick={() => setAll(true)}>
              Show {items.length - max} more
            </Button>
          </li>
        ) : null}
        {!phone && all && items.length > fold ? (
          <li className="self-center">
            <Button
              size="S"
              variant="secondary"
              className="pointer-events-auto"
              onClick={() => setAll(false)}
            >
              Show fewer
            </Button>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/** A phone's card, as high as a sheet's snap: 30 % of the screen, its handle raising it to 60 % while it has more. */
function PhoneCardSheet({ children }: { children: ReactNode }) {
  const [tall, setTall] = useState(false);
  const [more, setMore] = useState(false);
  const box = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setMore(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  });
  return (
    // Its handle sits in the sheet's top edge, over the card's own top margin — never on the board above it (critic P9
    // r2 #11: floating there it read as a wall).
    <div className="relative">
      <ol
        ref={box}
        className="flex flex-col gap-2 overflow-y-auto overscroll-contain"
        style={{ maxHeight: tall ? "60dvh" : "30dvh" }}
        data-testid="card-sheet"
        data-snap={tall ? "60" : "30"}
      >
        {children}
      </ol>
      {more || tall ? (
        <button
          type="button"
          aria-label={tall ? "Lower the card" : "Raise the card"}
          aria-expanded={tall}
          onClick={() => setTall((x) => !x)}
          className="absolute left-1/2 top-0 grid h-4 w-16 -translate-x-1/2 place-items-center rounded-b-chip"
          data-testid="card-sheet-handle"
        >
          <span aria-hidden className="block h-1 w-10 rounded-full bg-[var(--border-strong)]" />
        </button>
      ) : null}
    </div>
  );
}

/** Whether a pointer is held down anywhere on the page now (a drag, a press being made). */
let held = 0;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    () => {
      held++;
    },
    { capture: true },
  );
  const up = () => {
    held = Math.max(0, held - 1);
  };
  window.addEventListener("pointerup", up, { capture: true });
  window.addEventListener("pointercancel", up, { capture: true });
  window.addEventListener("blur", () => {
    held = 0;
  });
}
const pointerHeld = (): boolean => held > 0;
