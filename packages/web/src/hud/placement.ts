import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { boardApi, elementRect } from "../board/boardApi.ts";
import { shownOverlayRects } from "../board/tokens/declutter.ts";
import { useBoardCovers, useHudInsets, useHudObstacles } from "./insets.ts";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const GAP = 10;
const EDGE = 8;
/** The phone tools button's corner: its gutter, its panel and a gap (LeftToolbar). */
const PHONE_TOOLS_W = 12 + 56 + 8;

const area = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * What a floating board label must not cover, in window pixels: the name plates and HP bars on screen (the declutter
 * pass's rectangles) and the HUD's bars and dock.
 */
export function boardObstacles(): Rect[] {
  const out: Rect[] = [];
  const el = boardApi.element;
  const o = el ? elementRect(el) : { left: 0, top: 0 };
  for (const r of shownOverlayRects())
    out.push({ x0: r.x0 + o.left, y0: r.y0 + o.top, x1: r.x1 + o.left, y1: r.y1 + o.top });
  const hud = useHudInsets.getState();
  if (hud.active && typeof window !== "undefined") {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    out.push({ x0: 0, y0: 0, x1: vw, y1: hud.top + hud.banner });
    if (hud.left > 0) out.push({ x0: 0, y0: 0, x1: hud.left, y1: vh });
    // Phones: the tools button and the dock's rail hold the top corners, not columns.
    if (hud.cornerLeft > 0) out.push({ x0: 0, y0: 0, x1: PHONE_TOOLS_W, y1: hud.cornerLeft });
    if (hud.cornerRight > 0) out.push({ x0: vw - hud.right, y0: 0, x1: vw, y1: hud.cornerRight });
    else out.push({ x0: vw - hud.right, y0: 0, x1: vw, y1: vh });
    if (hud.bottom > 0) out.push({ x0: 0, y0: vh - hud.bottom, x1: vw, y1: vh });
  }
  // What floats over the board (the cards, the roll feed, the action bar…): a label beside something keeps off it —
  // an effect's chip over a save card on a phone hid the card's header.
  for (const r of [
    ...Object.values(useHudObstacles.getState().rects),
    ...Object.values(useBoardCovers.getState().rects),
  ])
    if (r) out.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
  return out;
}

/**
 * Where a label of size w × h goes beside a thing on screen (a disc at (cx, cy) of radius r, px): to its right, left,
 * above or below, or at a corner — the first that stays on screen and covers neither the thing, anything in `avoid`,
 * nor any of `points` (a path's line, sampled); failing that, the one that covers least (a point of the path costs as
 * much as a sizeable area: the line is what the label is about).
 */
export function placeBeside(
  cx: number,
  cy: number,
  r: number,
  w: number,
  h: number,
  avoid: readonly Rect[],
  points: readonly { x: number; y: number }[] = [],
): { x: number; y: number } {
  const vw = typeof window === "undefined" ? 1e4 : window.innerWidth;
  const vh = typeof window === "undefined" ? 1e4 : window.innerHeight;
  const thing: Rect = { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
  const d = (r + GAP) * Math.SQRT1_2;
  const spots = [
    { x: cx + r + GAP, y: cy - h / 2 },
    { x: cx - r - GAP - w, y: cy - h / 2 },
    { x: cx - w / 2, y: cy - r - GAP - h },
    { x: cx - w / 2, y: cy + r + GAP },
    { x: cx + d, y: cy - d - h },
    { x: cx - d - w, y: cy - d - h },
    { x: cx + d, y: cy + d },
    { x: cx - d - w, y: cy + d },
  ];
  let best = spots[0] as { x: number; y: number };
  let bestCost = Number.POSITIVE_INFINITY;
  for (const s of spots) {
    // Kept on screen (a spot pushed back over its thing is scored by what it then covers).
    const x = Math.max(EDGE, Math.min(s.x, vw - w - EDGE));
    const y = Math.max(EDGE, Math.min(s.y, vh - h - EDGE));
    const box: Rect = { x0: x, y0: y, x1: x + w, y1: y + h };
    let cost = area(box, thing) * 4;
    for (const a of avoid) cost += area(box, a);
    for (const p of points)
      if (p.x > box.x0 - 4 && p.x < box.x1 + 4 && p.y > box.y0 - 4 && p.y < box.y1 + 4) cost += 400;
    if (cost === 0) return { x, y };
    if (cost < bestCost) {
      bestCost = cost;
      best = { x, y };
    }
  }
  return best;
}

/**
 * Keeps a fixed-position label beside a moving anchor (the label measured, placed with `placeBeside`): after every
 * render and every animation frame while it's mounted, so a camera move (a wheel zoom mid-drag) carries it along.
 */
export function useBesideLabel(
  ref: RefObject<HTMLElement | null>,
  anchor: () => { cx: number; cy: number; r: number; points?: { x: number; y: number }[] } | null,
): void {
  const get = useRef(anchor);
  get.current = anchor;
  const place = () => {
    const el = ref.current;
    const a = get.current();
    if (!el || !a) return;
    const at = placeBeside(a.cx, a.cy, a.r, el.offsetWidth, el.offsetHeight, boardObstacles(), a.points);
    const left = `${Math.round(at.x)}px`;
    const top = `${Math.round(at.y)}px`;
    if (el.style.left !== left) el.style.left = left;
    if (el.style.top !== top) el.style.top = top;
  };
  useLayoutEffect(place);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one loop for the label's life; it reads the latest anchor
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      place();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}
