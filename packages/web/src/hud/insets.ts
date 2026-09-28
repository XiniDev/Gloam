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
  /** The table's HUD is on screen (the insets above apply; elsewhere — the Admin console — they don't). */
  active: boolean;
}

export const useHudInsets = create<HudInsets & { set(p: Partial<HudInsets>): void }>((set) => ({
  top: 56,
  left: 76,
  right: 76,
  banner: 0,
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
      if (key === "banner") useHudInsets.getState().set({ banner: 0 });
    };
  }, [key, ref, measure, enabled]);
}

export const insetMeasures = {
  top: (r: DOMRect) => r.bottom,
  left: (r: DOMRect) => r.right + GAP,
  right: (r: DOMRect) => window.innerWidth - r.left + GAP,
  banner: (r: DOMRect) => r.height + GAP,
};

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
