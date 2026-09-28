import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button.tsx";
import { Filigree } from "./ornaments.tsx";

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
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const t = window.setTimeout(() => {
      const first =
        ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        ref.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) {
        e.stopPropagation();
        onClose();
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
  }, [open, onClose, dismissible]);

  const parchment = variant === "parchment";
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[900] grid place-items-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div
            className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]"
            onClick={dismissible ? onClose : undefined}
            aria-hidden
          />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
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
                  {title}
                </h2>
                {description ? (
                  <p
                    id={descId}
                    className={`mt-1.5 text-14 ${parchment ? "text-paper-muted" : "text-muted"}`}
                  >
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
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * A dialog's scrolling body: a soft shadow at an edge while there's more to scroll that way (a slider or field under
 * the fold is never a secret).
 */
function DialogBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ up: false, down: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const up = el.scrollTop > 1;
      const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setMore((m) => (m.up === up && m.down === down ? m : { up, down }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-6 pb-2 pt-4">
        {children}
      </div>
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-[var(--edge-shade)] to-transparent transition-opacity duration-[var(--dur-fast)] ${more.up ? "opacity-100" : "opacity-0"}`}
      />
      <span
        aria-hidden
        data-testid="dialog-more-below"
        data-more={more.down}
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-[var(--edge-shade)] to-transparent transition-opacity duration-[var(--dur-fast)] ${more.down ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}
