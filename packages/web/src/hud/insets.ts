import { type RefObject, useEffect, useState } from "react";
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

/** Keeps one inset in step with an element's box (ResizeObserver + window resizes); 0 again on unmount. */
export function useMeasuredInset(
  key: keyof HudInsets,
  ref: RefObject<HTMLElement | null>,
  measure: (r: DOMRect) => number,
  enabled = true,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const update = () => {
      const v = Math.max(0, Math.round(measure(el.getBoundingClientRect())));
      if (useHudInsets.getState()[key] !== v) useHudInsets.getState().set({ [key]: v });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      // Bands that only exist while their element does go back to nothing.
      if (key === "banner" || key === "cornerLeft" || key === "cornerRight" || key === "bottom")
        useHudInsets.getState().set({ [key]: 0 });
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
