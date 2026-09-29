import { EMOTES, type EmoteId, MAX_PHRASES, PHRASE_MAX, QUICK_PHRASES } from "@gloam/shared/protocol";
import { Plus, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { savePhrases, sendEmote, sendPhrase, toggleHand } from "../net/fun.ts";
import { useTable } from "../net/table.ts";
import { prefersReducedMotion } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { KeyHint } from "../ui/KeyHint.tsx";
import { toast } from "../ui/Toast.tsx";
import { HandBadge } from "./HandBadge.tsx";
import { useHudInsets } from "./insets.ts";

const RADIUS = 92;
const SIZE = 2 * RADIUS + 64;

const refused = (e: Error) => toast.info("Not so fast", e.message);

/** Where the pointer last was (the wheel opens there from the keyboard). */
let pointer: { x: number; y: number } | null = null;
if (typeof window !== "undefined")
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true },
  );

const closeWheel = () => useUi.getState().set({ emoteWheel: null });

/** Opens the wheel where asked, else under the pointer, else mid-screen. */
export function openEmoteWheel(at?: { x: number; y: number }): void {
  useUi.getState().set({
    emoteWheel: at ?? pointer ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    radial: null,
  });
}

/**
 * The emote wheel (SPEC §8.18; AC-FUN-01): `E` (or the Emote slice of your token's menu, or a long press on your own
 * portrait) opens it where you are — the twelve emotes round a ring, the eight quick phrases and your own (up to six,
 * 40 characters, kept on your profile) beneath, and your raised hand. One pick sends it and closes; Esc or a click
 * outside closes. Keys: Tab through, Enter to send.
 */
export function EmoteWheel() {
  const at = useUi((s) => s.emoteWheel);
  const me = useTable((s) => s.me);
  const handUp = useTable((s) => s.presence.find((p) => p.userId === s.me?.userId)?.handRaised ?? false);
  const [hover, setHover] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const corners = useHudInsets((s) => Math.max(s.cornerLeft, s.cornerRight));
  const close = closeWheel;
  // Closed: its half-written phrase goes with it.
  useEffect(() => {
    if (at) return;
    setAdding(false);
    setDraft("");
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeWheel();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) closeWheel();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    // The first emote takes the focus (a keyboard can send at once).
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [at]);

  if (!at || !me) return null;
  const phrases = me.phrases;
  // Kept on screen: the wheel and its phrases (≈ 340 px tall) where there's room.
  const w = Math.max(SIZE, 320);
  const left = Math.min(Math.max(12, at.x - w / 2), window.innerWidth - w - 12);
  // (On a phone, below the corners — the tools button, the dock's rail: the wheel is wider than the room between.)
  const minTop = window.innerWidth < 640 ? Math.max(64, corners + 8) : 64;
  const top = Math.min(Math.max(minTop, at.y - SIZE / 2), window.innerHeight - SIZE - 150);
  const emote = (id: EmoteId) => {
    close();
    void sendEmote(id).catch(refused);
  };
  const phrase = (p: string) => {
    close();
    void sendPhrase(p).catch(refused);
  };
  const addPhrase = () => {
    const p = draft.trim();
    if (!p || phrases.includes(p)) return;
    void savePhrases([...phrases, p])
      .then(() => {
        setDraft("");
        setAdding(false);
      })
      .catch((e: Error) => toast.danger("Couldn't save it", e.message));
  };
  const removePhrase = (p: string) =>
    void savePhrases(phrases.filter((x) => x !== p)).catch((e: Error) =>
      toast.danger("Couldn't remove it", e.message),
    );

  return createPortal(
    <motion.div
      ref={box}
      role="dialog"
      aria-label="Emotes"
      className="fixed z-[70] flex flex-col items-center gap-2"
      style={{ left, top, width: w }}
      initial={prefersReducedMotion() ? false : { opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 30 }}
      data-testid="emote-wheel"
    >
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <div className="panel absolute inset-3 rounded-full" aria-hidden />
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="caps max-w-[96px] text-center text-12 text-brass">{hover ?? "Emote"}</span>
        </div>
        {EMOTES.map((e, i) => {
          const a = (i / EMOTES.length) * 2 * Math.PI - Math.PI / 2;
          return (
            <button
              key={e.id}
              type="button"
              aria-label={e.label}
              onClick={() => emote(e.id)}
              onPointerEnter={() => setHover(e.label)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(e.label)}
              className="absolute grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-28 leading-none transition-transform duration-[var(--dur-fast)] hover:scale-125 hover:bg-raised focus-visible:scale-125"
              style={{ left: SIZE / 2 + RADIUS * Math.cos(a), top: SIZE / 2 + RADIUS * Math.sin(a) }}
            >
              <span aria-hidden>{e.glyph}</span>
            </button>
          );
        })}
      </div>
      <div className="panel flex w-full flex-col gap-2 p-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick phrases">
          {[...QUICK_PHRASES, ...phrases].map((p) => (
            <span key={p} className="group relative">
              <button
                type="button"
                onClick={() => phrase(p)}
                className="h-8 max-w-[260px] truncate rounded-[var(--radius-chip)] border border-line px-2.5 text-13 text-bone hover:border-brass-deep hover:bg-raised pointer-coarse:h-11 max-sm:h-11"
              >
                {p}
              </button>
              {phrases.includes(p) ? (
                <button
                  type="button"
                  aria-label={`Remove “${p}”`}
                  onClick={() => removePhrase(p)}
                  className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 place-items-center rounded-full bg-ink-950 text-muted shadow-[0_0_0_1px_var(--line)] before:absolute before:-inset-2.5 before:content-[''] hover:text-bone group-focus-within:grid group-hover:grid pointer-coarse:-right-2 pointer-coarse:-top-2 pointer-coarse:grid pointer-coarse:h-6 pointer-coarse:w-6 max-sm:grid"
                >
                  <X size={10} />
                </button>
              ) : null}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {adding ? (
            <form
              className="flex min-w-0 flex-1 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addPhrase();
              }}
            >
              <input
                // biome-ignore lint/a11y/noAutofocus: the field just asked for
                autoFocus
                aria-label="Your phrase"
                maxLength={PHRASE_MAX}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Up to 40 characters"
                className="h-8 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-ink-950 px-2 text-13 text-bone placeholder:text-fog focus:border-brass focus:outline-none pointer-coarse:h-11 max-sm:h-11"
              />
              <button
                type="submit"
                className="h-8 rounded-[var(--radius-control)] px-2 text-13 font-bold text-brass hover:bg-raised pointer-coarse:h-11 max-sm:h-11"
              >
                Save
              </button>
            </form>
          ) : phrases.length < MAX_PHRASES ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex h-8 items-center gap-1 rounded-[var(--radius-control)] px-2 text-13 text-muted hover:bg-raised hover:text-bone pointer-coarse:h-11 max-sm:h-11"
            >
              <Plus size={14} aria-hidden /> Your own phrase
            </button>
          ) : (
            <span className="text-12 text-muted">Six phrases of your own — remove one to add another.</span>
          )}
          {me.role !== "dm" && me.role !== "admin" ? (
            <button
              type="button"
              aria-pressed={handUp}
              onClick={() => {
                close();
                void toggleHand().catch(refused);
              }}
              className="ml-auto flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-13 text-bone hover:bg-raised pointer-coarse:h-11 max-sm:h-11"
            >
              <HandBadge size={18} />
              {handUp ? "Lower hand" : "Raise hand"}
              <span className="pointer-coarse:hidden">
                <KeyHint keys="H" />
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </motion.div>,
    document.body,
  );
}
