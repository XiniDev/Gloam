import { motion } from "motion/react";
import { prefersReducedMotion } from "../state/settings.ts";

/**
 * A raised hand on a portrait (SPEC §8.18): a brass disc with a solid open hand filling most of it, parted from the
 * portrait by an ink ring, in its top-right corner — with one brass pulse as it goes up (a fade with reduced motion).
 */
export function HandBadge({ size = 20, className = "" }: { size?: number; className?: string }) {
  const still = prefersReducedMotion();
  return (
    <motion.span
      className={`relative grid place-items-center rounded-full bg-accent shadow-[0_0_0_2px_var(--ink-950)] ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label="Hand raised"
      data-testid="hand-badge"
      initial={still ? { opacity: 0 } : { scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={still ? { duration: 0.2 } : { type: "spring", stiffness: 520, damping: 16 }}
    >
      {still ? null : (
        <motion.span
          className="pointer-events-none absolute inset-0 rounded-full border-2 border-brass-bright"
          initial={{ scale: 1, opacity: 0.8 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          aria-hidden
        />
      )}
      <svg
        width={Math.round(size * 0.78)}
        height={Math.round(size * 0.78)}
        viewBox="2 2.5 17 19"
        fill="var(--ink-950)"
        aria-hidden
      >
        <rect x="6.1" y="5.2" width="2.7" height="9" rx="1.35" />
        <rect x="9.1" y="3" width="2.8" height="10" rx="1.4" />
        <rect x="12.2" y="3.6" width="2.7" height="9.6" rx="1.35" />
        <rect x="15.2" y="5.8" width="2.6" height="8" rx="1.3" />
        <rect x="2.6" y="10.4" width="2.7" height="7.4" rx="1.35" transform="rotate(-38 4 14)" />
        <path d="M6.1 11h11.7v4.6c0 3.3-2.6 5.9-5.9 5.9h-.4c-2.4 0-4.5-1.4-5.4-3.6l-1.4-3.4z" />
      </svg>
    </motion.span>
  );
}
