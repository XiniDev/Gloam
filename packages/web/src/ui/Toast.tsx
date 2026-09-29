import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { create } from "zustand";
import { type ScreenArea, useBoardCovers, useCover, useHudInsets } from "../hud/insets.ts";
import { provideTestHook } from "../test/hooks.ts";
import { useModalOpen } from "./Dialog.tsx";
import { keepHyphenated } from "./text.tsx";

export type ToastKind = "info" | "success" | "warning" | "danger" | "knock";

export interface ToastAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
}

export interface ToastItem {
  id: string;
  kind: ToastKind;
  title: ReactNode;
  body?: ReactNode;
  actions?: ToastAction[];
  /** ms; 0 = sticky until dismissed or acted on. Default 5 s (knocks stay until handled). */
  duration?: number;
  key?: string;
}

interface ToastStore {
  items: ToastItem[];
  push(t: Omit<ToastItem, "id"> & { id?: string }): string;
  dismiss(id: string): void;
  dismissKey(key: string): void;
}

let seq = 0;
const timers = new Map<string, number>();

/** SPEC §28 Toast: top-right stack (max 4), typed, action buttons, auto-dismiss 5 s. */
export const useToasts = create<ToastStore>((set, get) => ({
  items: [],
  push(t) {
    const id = t.id ?? `t${++seq}`;
    const item: ToastItem = { duration: t.kind === "knock" ? 0 : 5000, ...t, id };
    set((s) => {
      const withoutKey = item.key ? s.items.filter((x) => x.key !== item.key) : s.items;
      return { items: [...withoutKey, item].slice(-4) };
    });
    if (item.duration && item.duration > 0) {
      timers.set(
        id,
        window.setTimeout(() => get().dismiss(id), item.duration),
      );
    }
    return id;
  },
  dismiss(id) {
    const t = timers.get(id);
    if (t) window.clearTimeout(t);
    timers.delete(id);
    set((s) => ({ items: s.items.filter((x) => x.id !== id) }));
  },
  dismissKey(key) {
    for (const i of get().items.filter((x) => x.key === key)) get().dismiss(i.id);
  },
}));

export const toast = {
  info: (title: ReactNode, body?: ReactNode) => useToasts.getState().push({ kind: "info", title, body }),
  success: (title: ReactNode, body?: ReactNode) =>
    useToasts.getState().push({ kind: "success", title, body }),
  warning: (title: ReactNode, body?: ReactNode) =>
    useToasts.getState().push({ kind: "warning", title, body }),
  danger: (title: ReactNode, body?: ReactNode) => useToasts.getState().push({ kind: "danger", title, body }),
};

/** HUD that isn't in the toasts' way wherever it is (the stack itself; the bottom band's pieces). */
const NOT_IN_THE_WAY = new Set(["toasts", "feed", "actions", "targeting"]);

/**
 * Where the toast stack starts: below each piece of HUD in its column (x0…x1) that stands within the stack's reach —
 * a stack of `height` (at least a toast's, 96 px) from where it would start — taken top to bottom.
 */
export function stackTop(
  base: number,
  x0: number,
  x1: number,
  covers: Record<string, ScreenArea>,
  height: number,
): number {
  const reach = Math.max(96, height);
  let top = base;
  const inColumn = Object.entries(covers)
    .filter(([name, r]) => !NOT_IN_THE_WAY.has(name) && r.right > x0 && r.left < x1)
    .map(([, r]) => r)
    .sort((a, b) => a.top - b.top);
  for (const r of inColumn) if (r.top < top + reach && r.bottom > top) top = r.bottom + 4;
  return Math.round(top);
}

const ACCENT: Record<ToastKind, string> = {
  info: "var(--arcane-400)",
  success: "var(--verdigris-400)",
  warning: "var(--ember-400)",
  danger: "var(--blood-500)",
  knock: "var(--brass-400)",
};

export function Toaster() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  // At the table the stack stands beside the dock's rail, never over it (a sticky hazard prompt would otherwise
  // take the DM's panels away until dismissed).
  const table = useHudInsets((s) => s.active);
  const right = useHudInsets((s) => s.right);
  // A phone's top corners are taken (the tools button, the dock's rail): the stack stands under the tools button,
  // left of the rail — never over the one tool button (critic P7 r1).
  const cornerLeft = useHudInsets((s) => s.cornerLeft);
  const phoneTable = table && cornerLeft > 0;
  // Never in a band with the cards (critic P7 r2 #2): where the stack of cards reaches into the toasts' column at the
  // top, the toasts stand under it.
  const covers = useBoardCovers((s) => s.rects);
  // The cards' column, when the cards stand in the top right: the toasts share its edges (critic P9 r1 #5).
  const cards = covers.cards;
  const columnW = Math.min(380, window.innerWidth - right - 12);
  const inCards =
    !phoneTable &&
    cards &&
    cards.right > window.innerWidth - right - columnW - 8 &&
    cards.top < window.innerHeight / 3;
  const x1 = inCards && cards ? cards.right - 4 : window.innerWidth - right;
  const x0 = phoneTable ? 12 : inCards && cards ? cards.left + 4 : x1 - columnW;
  // A dialog open: the stack keeps out of it (its header, a phone's whole width) — at the foot.
  const modal = useModalOpen((s) => s.count > 0);
  // The stack is HUD over the board while it holds a toast: plates keep out from under it (critic P7 r2 #2).
  const ref = useRef<HTMLDivElement>(null);
  useCover("toasts", ref, table && items.length > 0);
  // Never over other HUD (critic P7 r2 #2, P8 r2 I3): the stack starts below whatever stands in its column where it
  // would reach — the turn tracker, the "your turn" banner, the cards, a phone's tools button.
  const under = table
    ? stackTop(phoneTable ? cornerLeft : 72, x0, x1, covers, ref.current?.offsetHeight ?? 0)
    : null;
  // Never in the middle of the board (§27.6): below cards that reach past a third of the screen, or over a dialog, the
  // stack stands at the foot of the column instead, above the bottom band.
  const atFoot = table && (modal || (under !== null && under > window.innerHeight * 0.35));
  const top = atFoot ? null : under;
  const bottomBand = useHudInsets((s) => s.bottom);
  // Tests: a toast on demand (where it stands beside the HUD).
  useEffect(() => provideTestHook("toast", (title: unknown) => toast.info(String(title))), []);
  return (
    <div
      ref={ref}
      aria-live="polite"
      className="pointer-events-none fixed right-3 top-[calc(64px+env(safe-area-inset-top))] z-[950] flex w-[min(380px,calc(100vw-24px))] flex-col gap-2 sm:right-4 sm:top-[72px]"
      style={
        phoneTable
          ? // (With a page of the dock open across the phone, the stack takes the width, over the page.)
            {
              ...(atFoot ? { top: "auto", bottom: bottomBand + 12 } : { top: top ?? cornerLeft }),
              left: 12,
              right: right < window.innerWidth / 2 ? right : 12,
              width: "auto",
            }
          : table
            ? {
                right: window.innerWidth - x1,
                width: x1 - x0,
                ...(atFoot ? { top: "auto", bottom: bottomBand + 12 } : top !== null ? { top } : {}),
              }
            : undefined
      }
    >
      <AnimatePresence initial={false}>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            role={t.kind === "danger" || t.kind === "knock" ? "alert" : "status"}
            initial={{ opacity: 0, x: 24, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            className="panel pointer-events-auto relative overflow-hidden pl-4 pr-2 py-3"
            data-kind={t.kind}
            data-toast
          >
            <span
              className="absolute inset-y-0 left-0 w-[3px]"
              style={{ background: ACCENT[t.kind] }}
              aria-hidden
            />
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-14 font-bold text-bone">{keepHyphenated(t.title)}</div>
                {t.body ? <div className="mt-0.5 text-13 text-muted">{keepHyphenated(t.body)}</div> : null}
                {t.actions?.length ? (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {t.actions.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        onClick={() => {
                          a.onClick();
                          dismiss(t.id);
                        }}
                        className={`h-8 rounded-[var(--radius-control)] px-3 text-13 font-bold transition-colors ${
                          a.variant === "primary"
                            ? "bg-accent text-[var(--on-accent)] hover:bg-brass-bright"
                            : a.variant === "danger"
                              ? "border border-danger text-danger-text hover:bg-danger hover:text-bone"
                              : "border border-line bg-raised text-bone hover:border-brass"
                        }`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-chip)] text-faint hover:bg-raised hover:text-bone"
              >
                <X size={15} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
