import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { insetMeasures, useBoardCovers, useHudInsets, useMeasuredInset } from "../hud/insets.ts";
import { ScrollFade } from "./ScrollFade.tsx";

/** How many bottom sheets are open: a phone's tab bar steps aside for them (they rise over the bottom edge it holds). */
export const useOpenSheets = create<{ n: number }>(() => ({ n: 0 }));

/** Snap heights, as shares of the screen's height (SPEC §28 BottomSheet: 30 / 60 / 95 %). */
export const SHEET_SNAPS = [0.3, 0.6, 0.95] as const;
/** How far a release carries on (s): the flick's velocity × this is where it would come to rest. */
const MOMENTUM_S = 0.18;

/**
 * A phone's bottom sheet (SPEC §28 BottomSheet, §29.4 "panels open as bottom sheets"): along the bottom edge, full
 * width, at one of three heights — 30 % (the default: the board stays in view above it), 60 %, 95 %. Its handle drags
 * it between them with momentum (a flick carries on to the next height) and steps with the arrow keys; the content
 * scrolls within. Its height is the HUD's bottom band while it's open (the camera frames above it, labels and menus
 * keep clear of it).
 */
export function BottomSheet({
  label,
  header,
  testId,
  initialSnap = 0,
  footer,
  bare = false,
  children,
}: {
  label: string;
  header?: ReactNode;
  testId?: string;
  /** Stays in view under the scrolling content: the sheet's main action (Roll) at any height. */
  footer?: ReactNode;
  /** The height it opens at (an index into SHEET_SNAPS): 30 % unless its content needs more to be of use. */
  initialSnap?: number;
  /** Its content lays itself out (a dock panel with its own scrolling): no padding or scroller of the sheet's. */
  bare?: boolean;
  children: ReactNode;
}) {
  const [snap, setSnap] = useState(() => Math.max(0, Math.min(SHEET_SNAPS.length - 1, initialSnap)));
  const [dragPx, setDragPx] = useState<number | null>(null);
  const drag = useRef<{ y0: number; h0: number; last: { y: number; t: number }[] } | null>(null);
  const ref = useRef<HTMLElement>(null);
  useMeasuredInset("bottom", ref, insetMeasures.bottom);
  useEffect(() => {
    useOpenSheets.setState((s) => ({ n: s.n + 1 }));
    return () => useOpenSheets.setState((s) => ({ n: Math.max(0, s.n - 1) }));
  }, []);
  // The snaps are shares of the room under the top bar (at the table): at 95 % of the whole screen the sheet's handle
  // came up over the top bar's buttons. Elsewhere (no table HUD), of the whole screen.
  const topBar = useHudInsets((s) => (s.active ? s.top : 0));
  const vh = () => (typeof window === "undefined" ? 800 : window.innerHeight) - topBar;
  const snapPx = (i: number) => Math.round((SHEET_SNAPS[i] as number) * vh());
  // Re-measure on rotation: the snap is a share of the screen.
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // Toasts standing at the top while a sheet is up (Toast.tsx): the sheet stops short of them.
  const toasts = useBoardCovers((s) => s.rects.toasts);
  const screenH = typeof window === "undefined" ? 800 : window.innerHeight;
  const cap = toasts && toasts.top < screenH / 3 ? screenH - toasts.bottom - 8 : Number.POSITIVE_INFINITY;
  const height = Math.min(cap, dragPx ?? snapPx(snap));

  const end = (clientY: number) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const h = d.h0 + (d.y0 - clientY);
    const pts = d.last;
    const a = pts[0];
    const b = pts[pts.length - 1];
    // Upward flicks are positive (the sheet grows).
    const v = a && b && b.t > a.t ? -(b.y - a.y) / ((b.t - a.t) / 1000) : 0;
    const rest = h + v * MOMENTUM_S;
    let best = 0;
    for (let i = 1; i < SHEET_SNAPS.length; i++)
      if (Math.abs(snapPx(i) - rest) < Math.abs(snapPx(best) - rest)) best = i;
    setSnap(best);
    setDragPx(null);
  };

  // On the page itself, not inside whatever HUD piece opened it: an ancestor with a backdrop filter or a transform
  // would otherwise be the fixed sheet's frame (the Settings sheet laid itself out inside the top bar).
  return createPortal(
    <section
      ref={ref}
      aria-label={label}
      data-testid={testId}
      data-snap={SHEET_SNAPS[snap]}
      className="panel pointer-events-auto fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-b-none pb-[env(safe-area-inset-bottom)]"
      style={{
        height,
        transition: dragPx === null ? "height var(--dur-panel) var(--ease-out)" : "none",
      }}
    >
      <button
        type="button"
        aria-label={`Resize ${label.toLowerCase()} (${Math.round((SHEET_SNAPS[snap] as number) * 100)} %)`}
        className="flex h-[var(--touch-min)] min-h-6 w-full shrink-0 cursor-ns-resize touch-none items-center justify-center"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y0: e.clientY, h0: height, last: [{ y: e.clientY, t: e.timeStamp }] };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          d.last.push({ y: e.clientY, t: e.timeStamp });
          // The last 100 ms of movement set the flick's speed.
          while (d.last.length > 2 && e.timeStamp - (d.last[0] as { t: number }).t > 100) d.last.shift();
          setDragPx(Math.max(snapPx(0) * 0.6, Math.min(vh(), d.h0 + (d.y0 - e.clientY))));
        }}
        onPointerUp={(e) => end(e.clientY)}
        onPointerCancel={(e) => end(e.clientY)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setSnap((s) => Math.min(SHEET_SNAPS.length - 1, s + 1));
          else if (e.key === "ArrowDown") setSnap((s) => Math.max(0, s - 1));
          else return;
          e.preventDefault();
        }}
      >
        <span className="block h-1 w-10 rounded-chip bg-line-strong" aria-hidden />
      </button>
      {header ? <div className="shrink-0 px-3">{header}</div> : null}
      {bare ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        // Its edges fade where there's more (a control half under the footer read as cut — critic RSP-01 r1).
        <ScrollFade className="overscroll-contain px-3 pb-3">{children}</ScrollFade>
      )}
      {footer ? <div className="shrink-0 border-t border-line px-3 py-2">{footer}</div> : null}
    </section>,
    document.body,
  );
}
