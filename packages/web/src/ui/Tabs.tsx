import type { ReactNode } from "react";

/** A tab's box (§28 Tabs): bold 14, a 40-px row (a finger's on touch). */
export const TAB_CLASS =
  "relative flex h-10 min-h-[var(--touch-min)] shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-14 font-bold transition-colors duration-[var(--dur-fast)]";

/** One tab: brass with a brass underline when it's the one open, muted (bone on hover) when not. */
export function Tab({ on, onSelect, children }: { on: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onSelect}
      className={`${TAB_CLASS} ${on ? "text-brass-bright" : "text-muted hover:text-bone"}`}
    >
      {children}
      {on ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" aria-hidden /> : null}
    </button>
  );
}

/**
 * SPEC §28 Tabs, on ink: a row of tabs under a panel's header, the open one underlined in brass. (The DM panel's row
 * is these tabs with an overflow menu; a sheet's are the same on parchment.)
 */
export function Tabs<T extends string>({
  label,
  value,
  onChange,
  tabs,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  tabs: readonly { id: T; label: ReactNode }[];
}) {
  return (
    <div role="tablist" aria-label={label} className="flex shrink-0 gap-1 border-b border-line px-3">
      {tabs.map((t) => (
        <Tab key={t.id} on={t.id === value} onSelect={() => onChange(t.id)}>
          {t.label}
        </Tab>
      ))}
    </div>
  );
}
