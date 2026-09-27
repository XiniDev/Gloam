import { AnimatePresence, motion } from "motion/react";
import type { Connection } from "../net/table.ts";

/**
 * Non-blocking "Connection lost — reconnecting…" banner with a small candle (SPEC §8.15, AC-PER-06). The SDK
 * reconnects within the server's 60-s window; state resynchronises without a reload.
 */
export function ConnectionBanner({ connection }: { connection: Connection }) {
  const show = connection === "dropped" || connection === "closed";
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="panel pointer-events-none absolute left-1/2 top-[68px] z-50 flex -translate-x-1/2 items-center gap-3 px-4 py-2.5"
        >
          <svg width="14" height="22" viewBox="0 0 14 22" aria-hidden>
            <path
              d="M7 1c2 2.8 3.2 4.6 3.2 6.3a3.2 3.2 0 0 1-6.4 0C3.8 5.6 5 3.8 7 1z"
              fill="var(--ember-400)"
            >
              <animate attributeName="opacity" values="1;.55;.9;.6;1" dur="1.4s" repeatCount="indefinite" />
            </path>
            <rect x="4" y="11" width="6" height="10" rx="1" fill="var(--parchment-200)" />
          </svg>
          <span className="text-14 text-bone">
            {connection === "closed"
              ? "Connection lost — the table may be asleep. Retrying…"
              : "Connection lost — reconnecting…"}
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
