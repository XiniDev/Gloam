import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { IconButton } from "./Button.tsx";
import { Filigree } from "./ornaments.tsx";
import { ScrollFade } from "./ScrollFade.tsx";
import { keepHyphenated } from "./text.tsx";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * SPEC §28 Dialog: ink or parchment variant, corner filigree, focus trap, Esc closes, focus returns to the
 * opener. Used only for things that can't be done inline (§27.6).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = "ink",
  width = 520,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  variant?: "ink" | "parchment";
  width?: number;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useModalFocus(ref, open, onClose, dismissible);

  const parchment = variant === "parchment";
  return createPortal(
    <AnimatePresence>
      {open ? (
        <DialogLayer>
          <div
            className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]"
            onClick={dismissible ? onClose : undefined}
            aria-hidden
          />
          <DialogCard
            cardRef={ref}
            titleId={titleId}
            descId={descId}
            parchment={parchment}
            width={width}
            title={title}
            description={description}
            footer={footer}
            dismissible={dismissible}
            onClose={onClose}
          >
            {children}
          </DialogCard>
        </DialogLayer>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * A modal's keyboard (SPEC §28 Dialog): focus goes in (to `[data-autofocus]`, else the first control), Tab stays in,
 * Esc closes (when it may), and focus returns to whatever opened it.
 */
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  dismissible = true,
): void {
  const opener = useRef<Element | null>(null);
  // The latest close, read when a key asks for it: the effect below runs once per opening, not again on every render
  // an inline `onClose` makes — each rerun sent focus back to the opener mid-typing, so Enter pressed its button
  // (Jump to's Enter pressed the DM panel's rail tab).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const t = window.setTimeout(() => {
      // Never away from where the person already is in it (a busy frame can hold the timer back past their first
      // click: focus pulled back to the first field sent their typing there — "12" then "9" read "129").
      if (ref.current?.contains(document.activeElement)) return;
      const first =
        ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        ref.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        e.stopPropagation();
        close.current();
      }
      if (e.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => el.offsetParent !== null,
        );
        if (items.length === 0) return;
        const first = items[0] as HTMLElement;
        const last = items[items.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, dismissible, ref]);
}

/**
 * How many modal dialogs are open, and where the top one's card stands at rest (screen px): the toasts keep out of it.
 */
export const useModalOpen = create<{
  count: number;
  box: { left: number; top: number; right: number; bottom: number } | null;
}>(() => ({ count: 0, box: null }));

/** Counts a modal as open while the calling component is mounted (the toasts keep out of it). */
export function useModalCount(): void {
  useEffect(() => {
    useModalOpen.setState((s) => ({ count: s.count + 1 }));
    return () => useModalOpen.setState((s) => ({ count: Math.max(0, s.count - 1) }));
  }, []);
}

/** The scrim and the layer the dialog sits in: nothing under it is clickable — until it starts to leave. */
function DialogLayer({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  useModalCount();
  return (
    <motion.div
      className={`fixed inset-0 z-[900] grid place-items-center p-4 ${present ? "" : "pointer-events-none"}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Reports a modal card's box at rest (its layout box, not an entrance transform's) while `present`: the toasts keep out
 * of it. The card's offset parent must be the screen (a fixed, full-screen layer).
 */
export function useModalBox(cardRef: RefObject<HTMLElement | null>, present: boolean): void {
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || !present) return;
    const put = () => {
      const r = { left: el.offsetLeft, top: el.offsetTop, right: 0, bottom: 0 };
      r.right = r.left + el.offsetWidth;
      r.bottom = r.top + el.offsetHeight;
      const cur = useModalOpen.getState().box;
      if (
        !cur ||
        cur.left !== r.left ||
        cur.top !== r.top ||
        cur.right !== r.right ||
        cur.bottom !== r.bottom
      )
        useModalOpen.setState({ box: r });
    };
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    window.addEventListener("resize", put);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", put);
      useModalOpen.setState({ box: null });
    };
  }, [cardRef, present]);
}

/** The dialog itself (inside the presence so it knows when it's leaving). */
function DialogCard({
  cardRef,
  titleId,
  descId,
  parchment,
  width,
  title,
  description,
  footer,
  dismissible,
  onClose,
  children,
}: {
  cardRef: RefObject<HTMLDivElement | null>;
  titleId: string;
  descId: string;
  parchment: boolean;
  width: number;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  dismissible: boolean;
  onClose: () => void;
  children?: ReactNode;
}) {
  const present = useIsPresent();
  useModalBox(cardRef, present);
  return (
    <motion.div
      ref={cardRef}
      // Closing (its exit still playing): no longer a dialog — not announced, not in the way, not clickable.
      role={present ? "dialog" : undefined}
      aria-modal={present ? "true" : undefined}
      aria-hidden={present ? undefined : true}
      inert={!present}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      // Keys pressed in a modal stay in it: the table's shortcuts (undo, tools, the camera, Delete) never act
      // behind it. (A dialog that wants a key of its own listens in the capture phase.)
      onKeyDown={(e) => e.stopPropagation()}
      // Never taller than the screen: the title and the buttons stay put and the body scrolls (short
      // laptop screens, phones in landscape).
      className={`relative flex max-h-[calc(100dvh-32px)] w-full max-w-[calc(100vw-32px)] flex-col overflow-hidden ${parchment ? "parchment" : "panel"}`}
      style={{ width }}
      initial={{ y: 14, scale: 0.98, opacity: 0 }}
      animate={{ y: 0, scale: 1, opacity: 1 }}
      exit={{ y: 8, scale: 0.99, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 34 }}
    >
      <Filigree tone={parchment ? "ink" : "brass"} />
      <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
        <div className="min-w-0">
          <h2 id={titleId} className={`text-22 ${parchment ? "text-paper-ink" : "text-bone"}`}>
            {keepHyphenated(title)}
          </h2>
          {description ? (
            <p id={descId} className={`mt-1.5 text-14 ${parchment ? "text-paper-muted" : "text-muted"}`}>
              {description}
            </p>
          ) : null}
        </div>
        {dismissible ? (
          <IconButton label="Close" shortcut="Esc" onClick={onClose} className="-mr-2 -mt-2">
            <X size={18} />
          </IconButton>
        ) : null}
      </div>
      {children ? <DialogBody>{children}</DialogBody> : null}
      {footer ? (
        // On a phone the actions stack full-width, the main one on top (a ragged right-aligned wrap
        // otherwise).
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-6 pb-6 pt-4 max-sm:[&>div]:w-full max-sm:[&>div]:flex-col-reverse max-sm:[&_button]:w-full">
          {footer}
        </div>
      ) : null}
    </motion.div>
  );
}

/**
 * A dialog's scrolling body: at an edge with more to scroll that way, a hairline and the content fading into the
 * surface (a slider or field under the fold is never a secret, and never sliced).
 */
function DialogBody({ children }: { children: ReactNode }) {
  return (
    <ScrollFade className="px-6 pb-2 pt-4" testId="dialog-more-below">
      {children}
    </ScrollFade>
  );
}
