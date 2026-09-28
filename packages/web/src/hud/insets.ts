import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { create } from "zustand";

/**
 * Where the HUD sits over the board, in CSS pixels from each screen edge (SPEC §29: the board fills the screen and
 * the HUD floats over it). Panels place themselves by these instead of each assuming it is alone on screen — the
 * prep banner centres within the free board area, the dock and tool panels stack below it on phones — and the
 * camera frames scenes into the area the HUD leaves visible.
 */
export interface HudInsets {
  /** Top bar's bottom edge. */
  top: number;
  /** Left toolbar's right edge (+ gap). */
  left: number;
  /** Distance from the dock's left edge to the screen's right edge (+ gap). */
  right: number;
  /** The prep banner's height (+ gap), when it shows. */
  banner: number;
  /** The roll feed's width (+ gap) along the bottom-left, when it shows: tool option bars start past it. */
  feed: number;
  /**
   * Phones: how far down the top corners are taken — the tools button at the top-left, the dock's rail at the
   * top-right (their bottom edges + gap). A portrait phone keeps the full width for the board below them instead of
   * giving up a column down each side.
   */
  cornerLeft: number;
  cornerRight: number;
  /** The action bar's band along the bottom (its top edge's distance from the bottom + gap), when it shows. */
  bottom: number;
  /** The table's HUD is on screen (the insets above apply; elsewhere — the Admin console — they don't). */
  active: boolean;
}

export const useHudInsets = create<HudInsets & { set(p: Partial<HudInsets>): void }>((set) => ({
  top: 56,
  left: 76,
  right: 76,
  banner: 0,
  feed: 0,
  cornerLeft: 0,
  cornerRight: 0,
  bottom: 0,
  active: false,
  set: (p) => set(p),
}));

const GAP = 8;

/** Bands that only exist while an element claims them (the others keep their last value). */
const TRANSIENT = new Set<keyof HudInsets>(["banner", "cornerLeft", "cornerRight", "bottom"]);
/** Each element's claim on each inset: the inset is the largest (a sheet over the action bar, both along the bottom). */
const claims = new Map<keyof HudInsets, Map<object, number>>();
function settle(key: keyof HudInsets): void {
  const mine = claims.get(key);
  const v = mine?.size ? Math.max(...mine.values()) : TRANSIENT.has(key) ? 0 : null;
  if (v !== null && useHudInsets.getState()[key] !== v) useHudInsets.getState().set({ [key]: v });
}

/**
 * Keeps one inset in step with an element's box (ResizeObserver + window resizes). Several elements may claim the same
 * inset — the action bar and an open bottom sheet both hold the bottom band — and it is the largest of their claims;
 * an element's claim goes with it.
 */
export function useMeasuredInset(
  key: keyof HudInsets,
  ref: RefObject<HTMLElement | null>,
  measure: (r: DOMRect) => number,
  enabled = true,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const id = {};
    let mine = claims.get(key);
    if (!mine) {
      mine = new Map();
      claims.set(key, mine);
    }
    const update = () => {
      mine.set(id, Math.max(0, Math.round(measure(el.getBoundingClientRect()))));
      settle(key);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      mine.delete(id);
      settle(key);
    };
  }, [key, ref, measure, enabled]);
}

export const insetMeasures = {
  top: (r: DOMRect) => r.bottom,
  left: (r: DOMRect) => r.right + GAP,
  right: (r: DOMRect) => window.innerWidth - r.left + GAP,
  banner: (r: DOMRect) => r.height + GAP,
  corner: (r: DOMRect) => r.bottom + GAP,
  bottom: (r: DOMRect) => window.innerHeight - r.top + GAP,
};

/** An area of the screen (CSS px from its top-left). */
export interface ScreenArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The part of a W × H board the HUD leaves clear, where the camera frames things: on a desktop, between the toolbar
 * and the dock, below the top bar (and banner); on a phone, the full width below the top bar and the corner clusters.
 * Both above the bottom bar.
 */
export function clearArea(hud: HudInsets, W: number, H: number, phone: boolean): ScreenArea {
  const bottom = H - Math.max(12, hud.bottom);
  if (phone)
    return {
      left: 12,
      right: W - 12,
      top: Math.max(hud.top + hud.banner, hud.cornerLeft, hud.cornerRight),
      bottom,
    };
  return { left: hud.left, top: hud.top + hud.banner, right: W - hud.right, bottom };
}

/**
 * HUD pieces floating over the board away from its edges — the roll feed, the open dice tray — by name, in screen
 * pixels (+ a gap): things drawn over the board (the 3D dice) come to rest clear of them.
 */
export const useHudObstacles = create<{
  rects: Record<string, ScreenArea>;
  put(name: string, r: ScreenArea | null): void;
}>((set, get) => ({
  rects: {},
  put(name, r) {
    const cur = get().rects[name];
    if (!r) {
      if (!cur) return;
      const { [name]: _, ...rest } = get().rects;
      set({ rects: rest });
      return;
    }
    if (cur && cur.left === r.left && cur.top === r.top && cur.right === r.right && cur.bottom === r.bottom)
      return;
    set({ rects: { ...get().rects, [name]: r } });
  },
}));

/** An element's box with a gap round it, or null while it isn't laid out. */
function obstacleBox(el: HTMLElement): ScreenArea | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return {
    left: Math.round(r.left - GAP),
    top: Math.round(r.top - GAP),
    right: Math.round(r.right + GAP),
    bottom: Math.round(r.bottom + GAP),
  };
}

/**
 * Keeps an element's box registered as a HUD obstacle while it's on screen: measured after every render (it may have
 * moved without resizing — the feed follows the toolbar's edge) and on every resize.
 */
export function useObstacle(name: string, ref: RefObject<HTMLElement | null>, enabled = true): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && enabled) useHudObstacles.getState().put(name, obstacleBox(el));
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const update = () => useHudObstacles.getState().put(name, obstacleBox(el));
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      useHudObstacles.getState().put(name, null);
    };
  }, [name, ref, enabled]);
}

/**
 * The part of `area` clear of every obstacle that holds content of the given aspect (width ÷ height) largest: of the
 * rectangles bounded by the area's and the obstacles' edges that no obstacle overlaps, the one in which such content
 * scales up furthest (ties: the larger rectangle). The whole area when nothing is in the way.
 */
export function largestClear(area: ScreenArea, obstacles: readonly ScreenArea[], aspect: number): ScreenArea {
  const inside = obstacles
    .map((o) => ({
      left: Math.max(area.left, o.left),
      top: Math.max(area.top, o.top),
      right: Math.min(area.right, o.right),
      bottom: Math.min(area.bottom, o.bottom),
    }))
    .filter((o) => o.right > o.left && o.bottom > o.top);
  if (!inside.length) return area;
  const xs = [...new Set([area.left, area.right, ...inside.flatMap((o) => [o.left, o.right])])].sort(
    (a, b) => a - b,
  );
  const ys = [...new Set([area.top, area.bottom, ...inside.flatMap((o) => [o.top, o.bottom])])].sort(
    (a, b) => a - b,
  );
  const a = Math.max(1e-3, aspect);
  let best: ScreenArea | null = null;
  let bestFit = -1;
  let bestSize = -1;
  for (let i = 0; i < xs.length; i++)
    for (let j = xs.length - 1; j > i; j--) {
      const left = xs[i] as number;
      const right = xs[j] as number;
      for (let k = 0; k < ys.length; k++)
        for (let l = ys.length - 1; l > k; l--) {
          const top = ys[k] as number;
          const bottom = ys[l] as number;
          const w = right - left;
          const h = bottom - top;
          const fit = Math.min(w / a, h);
          if (fit < bestFit || (fit === bestFit && w * h <= bestSize)) continue;
          if (inside.some((o) => o.left < right && o.right > left && o.top < bottom && o.bottom > top))
            continue;
          best = { left, top, right, bottom };
          bestFit = fit;
          bestSize = w * h;
        }
    }
  return best ?? area;
}

/** Whether the screen is a phone's now (outside React). */
export const isPhoneNow = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE).matches;

/** Phone layout (SPEC §8.21 breakpoints: phone < 640 px wide). */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}
const PHONE = "(max-width: 639px)";

/** Narrower than a wide desktop: tool bars use compact controls (a kind dropdown instead of six labelled chips). */
export function useCompactBar(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 1280);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 1280);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}
