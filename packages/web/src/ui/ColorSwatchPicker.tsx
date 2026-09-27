import { PLAYER_COLORS } from "@gloam/shared";
import { Check } from "lucide-react";

/** SPEC §28 ColorSwatchPicker: the 12 player colours, each with its name (never colour-only). */
export function ColorSwatchPicker({
  value,
  onChange,
  taken = [],
  label = "Colour",
}: {
  value: string;
  onChange: (id: string) => void;
  taken?: string[];
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
      {PLAYER_COLORS.map((c) => {
        const active = c.id === value;
        const used = taken.includes(c.hex);
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(c.id)}
            className={`flex h-10 items-center gap-2 rounded-[var(--radius-control)] border px-2 text-left text-13 transition-colors duration-[var(--dur-fast)] ${
              active
                ? "border-brass bg-raised text-bone"
                : "border-line bg-ink-900 text-muted hover:border-line-strong hover:text-bone"
            }`}
          >
            <span
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full shadow-[inset_0_0_0_1px_var(--line-soft)]"
              style={{ background: `var(--player-${c.id})` }}
              aria-hidden
            >
              {active ? <Check size={13} strokeWidth={3} color="var(--ink-950)" /> : null}
            </span>
            <span className="truncate">{c.name}</span>
            {used && !active ? <span className="ml-auto text-12 text-faint">taken</span> : null}
          </button>
        );
      })}
    </div>
  );
}
