import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { create } from "zustand";
import { PHONE_BOTTOM_BAND, type ScreenArea, useBoardCovers, useCover, useHudInsets } from "../hud/insets.ts";
import { useUi } from "../state/ui.ts";
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
  /** The stack waits (a dialog leaves it nowhere to stand): only errors show; the others' clocks stop. */
  held: boolean;
  push(t: Omit<ToastItem, "id"> & { id?: string }): string;
  dismiss(id: string): void;
  dismissKey(key: string): void;
  hold(on: boolean): void;
}

let seq = 0;
const timers = new Map<string, number>();
const deadlines = new Map<string, number>();
/** Held: each waiting toast's time left (it starts again from there when the stack shows). */
const paused = new Map<string, number>();
/** What still shows while the stack waits: an error from the dialog's own work must be seen. */
const showsWhileHeld = (t: Pick<ToastItem, "kind">) => t.kind === "danger";

/** SPEC §28 Toast: top-right stack (max 4), typed, action buttons, auto-dismiss 5 s. */
export const useToasts = create<ToastStore>((set, get) => ({
  items: [],
  held: false,
  push(t) {
    const id = t.id ?? `t${++seq}`;
    // The same message again (a second "Spotlight", a second "Saved") replaces the one showing and starts its time
    // over, rather than stacking copies over the board — three of them ate a DM's next click on it.
    const same =
      !t.key &&
      !t.actions?.length &&
      typeof t.title === "string" &&
      (t.body === undefined || typeof t.body === "string")
        ? `same:${t.kind}|${t.title}|${t.body ?? ""}`
        : undefined;
    const item: ToastItem = {
      duration: t.kind === "knock" ? 0 : 5000,
      ...t,
      id,
      ...(same ? { key: same } : {}),
    };
    set((s) => {
      const replaced = item.key ? s.items.filter((x) => x.key === item.key) : [];
      for (const r of replaced) {
        const old = timers.get(r.id);
        if (old) window.clearTimeout(old);
        timers.delete(r.id);
        deadlines.delete(r.id);
        paused.delete(r.id);
      }
      const withoutKey = item.key ? s.items.filter((x) => x.key !== item.key) : s.items;
      return { items: [...withoutKey, item].slice(-4) };
    });
    if (item.duration && item.duration > 0) {
      if (get().held && !showsWhileHeld(item)) paused.set(id, item.duration);
      else startClock(id, item.duration, get().dismiss);
    }
    return id;
  },
  dismiss(id) {
    const t = timers.get(id);
    if (t) window.clearTimeout(t);
    timers.delete(id);
    deadlines.delete(id);
    paused.delete(id);
    set((s) => ({ items: s.items.filter((x) => x.id !== id) }));
  },
  dismissKey(key) {
    for (const i of get().items.filter((x) => x.key === key)) get().dismiss(i.id);
  },
  hold(on) {
    if (get().held === on) return;
    set({ held: on });
    if (on) {
      const now = Date.now();
      for (const t of get().items) {
        const timer = timers.get(t.id);
        if (timer === undefined || showsWhileHeld(t)) continue;
        window.clearTimeout(timer);
        timers.delete(t.id);
        // (Never less than a moment to be read once it shows.)
        paused.set(t.id, Math.max(1500, (deadlines.get(t.id) ?? now) - now));
        deadlines.delete(t.id);
      }
    } else {
      for (const [id, ms] of paused) startClock(id, ms, get().dismiss);
      paused.clear();
    }
  },
}));

function startClock(id: string, ms: number, dismiss: (id: string) => void): void {
  deadlines.set(id, Date.now() + ms);
  timers.set(
    id,
    window.setTimeout(() => dismiss(id), ms),
  );
}

export const toast = {
  info: (title: ReactNode, body?: ReactNode) => useToasts.getState().push({ kind: "info", title, body }),
  success: (title: ReactNode, body?: ReactNode) =>
    useToasts.getState().push({ kind: "success", title, body }),
  warning: (title: ReactNode, body?: ReactNode) =>
    useToasts.getState().push({ kind: "warning", title, body }),
  danger: (title: ReactNode, body?: ReactNode) => useToasts.getState().push({ kind: "danger", title, body }),
};

/** Room one toast takes in the stack, at most (a knock card with its buttons, and the gap) — for judging a slot. */
const TOAST_ROOM = 128;
/** The narrowest column a toast stands in beside a dialog (its buttons wrap to two rows). */
const BESIDE_MIN = 232;

/** HUD that isn't in the toasts' way wherever it is (the stack itself; the bottom band's pieces; the emote feed, which
 * keeps out of theirs). */
const NOT_IN_THE_WAY = new Set(["toasts", "feed", "actions", "targeting", "emote-feed"]);

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
  const wasHeld = useToasts((s) => s.held);
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
  // A dialog open: the stack keeps out of it — where it stands in the stack's column, the stack goes to the foot.
  const modal = useModalOpen((s) => s.count > 0);
  const dialog = useModalOpen((s) => s.box);
  // A phone's dock page open: its header and tabs are at the top — the stack stands at the foot (critic P11 r1 B6).
  const dockPage = phoneTable && covers["dock-panel"] !== undefined;
  // The stack is HUD over the board while it holds a toast: plates keep out from under it (critic P7 r2 #2).
  const ref = useRef<HTMLDivElement>(null);
  // (Its held toasts don't count: they aren't there.)
  useCover("toasts", ref, table && (wasHeld ? items.some(showsWhileHeld) : items.length > 0));
  // Never over other HUD (critic P7 r2 #2, P8 r2 I3): the stack starts below whatever stands in its column where it
  // would reach — the turn tracker, the "your turn" banner, the cards, a phone's tools button.
  const under = table
    ? stackTop(phoneTable ? cornerLeft : 72, x0, x1, covers, ref.current?.offsetHeight ?? 0)
    : null;
  // With a dialog open, room is judged for the whole stack as it stands shown — never its measured height: held, it
  // measures nothing, and the choice would flip back and forth.
  const need = Math.max(96, items.length * TOAST_ROOM);
  const overDialog =
    modal &&
    (!dialog ||
      (under !== null &&
        dialog.left < x1 &&
        dialog.right > (phoneTable ? 12 : x0) &&
        dialog.top < under + need &&
        dialog.bottom > under));
  // Never in the middle of the board (§27.6): below cards that reach past a third of the screen, the stack stands at
  // the foot of the column instead, above the bottom band; over a dialog or a phone's page, at the screen's foot (the
  // bottom band is under the scrim or the page then — never counted, or the stack stood mid-board: critic P11 r1 B6).
  const cardsLow = !modal && under !== null && under > window.innerHeight * 0.35;
  const band = useHudInsets((s) => s.bottom);
  const bottomBand = cardsLow ? band : dockPage ? 0 : phoneTable ? PHONE_BOTTOM_BAND : 96;
  // Never over a dialog: its top slot taken, the foot; that taken too (a tall dialog), beside it where a column fits
  // (the card's buttons wrap; the scrim covers the board there anyway); nowhere at all — a phone's, or a narrow
  // screen's — the stack waits for it to close, its clocks stopped, errors from the dialog's own work still shown (a
  // knock card over a tall dialog hid its fields).
  const footFree =
    !dialog ||
    dialog.bottom <= window.innerHeight - bottomBand - 12 - need ||
    dialog.left >= x1 ||
    dialog.right <= (phoneTable ? 12 : x0);
  const blocked = table && overDialog && !footFree;
  const beside =
    blocked && !phoneTable && dialog
      ? window.innerWidth - 12 - (dialog.right + 12) >= BESIDE_MIN
        ? { left: dialog.right + 12, right: 12 }
        : dialog.left - 24 >= BESIDE_MIN
          ? { left: 12, right: window.innerWidth - dialog.left + 12 }
          : null
      : null;
  // Off the table: the stack's own corner (the top right; a phone's foot) under a dialog.
  const pageSlot = window.matchMedia("(min-width: 768px)").matches
    ? { left: window.innerWidth - 16 - 380, right: window.innerWidth - 16, top: 16, bottom: 16 + need }
    : {
        left: 12,
        right: window.innerWidth - 12,
        top: window.innerHeight - 16 - need,
        bottom: window.innerHeight - 16,
      };
  const pageBlocked =
    !table &&
    modal &&
    dialog !== null &&
    dialog.left < pageSlot.right &&
    dialog.right > pageSlot.left &&
    dialog.top < pageSlot.bottom &&
    dialog.bottom > pageSlot.top;
  const held = (blocked && !beside) || pageBlocked;
  const atFoot = table && !beside && (overDialog || dockPage || cardsLow);
  const top = atFoot ? null : under;
  useEffect(() => useToasts.getState().hold(held), [held]);
  // A knock while the DM panel's Approvals shows it already: the toast would say it twice (critic P12 r1 M10).
  const inboxOpen = useUi((s) => s.dock === "dm" && s.dmSection === "approvals");
  const shown = (held ? items.filter(showsWhileHeld) : items).filter(
    (t) => !(inboxOpen && t.key?.startsWith("knock:")),
  );
  // Tests: a toast on demand (where it stands beside the HUD).
  useEffect(() => provideTestHook("toast", (title: unknown) => toast.info(String(title))), []);
  return (
    <div
      ref={ref}
      aria-live="polite"
      // Off the table (the admin's pages): the top right on wide screens, clear of the page's nav; on a phone, whose
      // top is its nav, at the foot (critic P11 r1 B6).
      className="pointer-events-none fixed bottom-[calc(16px+env(safe-area-inset-bottom))] right-3 z-[950] flex w-[min(380px,calc(100vw-24px))] flex-col gap-2 md:bottom-auto md:right-4 md:top-4"
      style={
        phoneTable
          ? // (With a page of the dock open across the phone, the stack takes the width, over the page.)
            {
              ...(atFoot
                ? { top: "auto", bottom: bottomBand + 12 }
                : { top: top ?? cornerLeft, bottom: "auto" }),
              left: 12,
              right: right < window.innerWidth / 2 ? right : 12,
              width: "auto",
            }
          : beside
            ? {
                left: beside.left,
                right: beside.right,
                width: "auto",
                maxWidth: 380,
                top: 72,
                bottom: "auto",
                // (Against the screen's edge, as ever.)
                ...(beside.right === 12 ? { marginLeft: "auto" } : {}),
              }
            : table
              ? {
                  right: window.innerWidth - x1,
                  width: x1 - x0,
                  ...(atFoot ? { top: "auto", bottom: bottomBand + 12 } : { top: top ?? 72, bottom: "auto" }),
                }
              : undefined
      }
    >
      <AnimatePresence initial={false}>
        {shown.map((t) => (
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
