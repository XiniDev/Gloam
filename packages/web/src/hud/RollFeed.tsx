import type { MaskedRoll, RollRecord, RollTerm } from "@gloam/shared/dice";
import { ChevronDown, ChevronUp, Hand, Sparkle } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { type FeedRoll, isMasked, useRolls } from "../dice/state.ts";
import { useTable } from "../net/table.ts";
import { useHudInsets, useIsPhone } from "./insets.ts";

/**
 * The roll feed (SPEC §8.9): bottom-left beside the left toolbar, newest first — the last three when collapsed, the
 * last thirty open. Each card: the roller's colour, label, formula, a chip per die (kept, dropped struck through,
 * exploded with a spark, natural 20 golden, natural 1 ember), the total in display numerals once the dice have
 * settled, a hand for a physical roll; masked cards with "?" chips (§18.3). Click a card for the breakdown.
 */
export function RollFeed() {
  const feed = useRolls((s) => s.feed);
  const rolling = useRolls((s) => s.rolling);
  const left = useHudInsets((s) => s.left);
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const hasFeed = feed.length > 0;
  // Tool option bars start to the right of the feed (they share the bottom edge).
  useLayoutEffect(() => {
    const el = ref.current;
    const set = (w: number) => {
      if (useHudInsets.getState().feed !== w) useHudInsets.getState().set({ feed: w });
    };
    if (!el || phone || !hasFeed) {
      set(0);
      return;
    }
    const update = () => set(Math.round(el.getBoundingClientRect().width) + 8);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      set(0);
    };
  }, [phone, hasFeed]);
  if (feed.length === 0) return null;
  const shown = feed.slice(0, open ? 30 : phone ? 1 : 3);
  return (
    <section
      ref={ref}
      aria-label="Roll feed"
      data-testid="roll-feed"
      className="pointer-events-none absolute bottom-3 z-30 flex w-[272px] max-w-[calc(100vw-24px)] flex-col-reverse gap-1.5"
      style={{ left: phone ? 12 : left }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="panel pointer-events-auto flex h-8 items-center justify-between gap-2 px-3 text-12 text-muted hover:text-bone"
        aria-expanded={open}
      >
        <span className="caps">Rolls</span>
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      <ol className={`flex flex-col-reverse gap-1.5 ${open ? "max-h-[55vh] overflow-y-auto" : ""}`}>
        {shown.map((r) => (
          <li key={r.id} className="pointer-events-auto">
            <RollCard
              roll={r}
              settled={!rolling.has(r.id)}
              expanded={expanded === r.id}
              onToggle={() => setExpanded((e) => (e === r.id ? null : r.id))}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function RollCard({
  roll,
  settled,
  expanded,
  onToggle,
}: {
  roll: FeedRoll;
  settled: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const me = useTable((s) => s.me?.userId);
  const mine = roll.userId === me;
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid="roll-card"
      data-roll={roll.id}
      data-settled={settled ? "1" : "0"}
      className="panel flex w-full flex-col gap-1 border-l-4 px-3 py-2 text-left"
      style={{ borderLeftColor: roll.color || "var(--border)" }}
    >
      <div className="flex w-full items-baseline gap-2">
        <span className="truncate text-13 font-bold text-bone">{mine ? "You" : roll.name}</span>
        {roll.label ? <span className="truncate text-12 text-muted">{roll.label}</span> : null}
        {roll.manual ? <Hand size={13} className="shrink-0 text-muted" aria-label="Rolled by hand" /> : null}
        <span className="ml-auto shrink-0">
          {isMasked(roll) ? (
            <span className="display text-22 leading-none text-faint">?</span>
          ) : (
            <Total roll={roll} settled={settled} />
          )}
        </span>
      </div>
      {isMasked(roll) ? <MaskedBody roll={roll} /> : <Body roll={roll} expanded={expanded} />}
    </button>
  );
}

function Total({ roll, settled }: { roll: RollRecord; settled: boolean }) {
  if (!settled) return <span className="display text-22 leading-none text-faint">…</span>;
  const tone = roll.crit ? "text-brass-bright" : roll.fumble ? "text-ember" : "text-bone";
  return (
    <span data-testid="roll-total" className={`display tabular text-28 leading-none ${tone}`}>
      {roll.total}
    </span>
  );
}

function MaskedBody({ roll }: { roll: MaskedRoll }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-12 italic text-muted">{roll.text}</span>
      {roll.tumble.length ? (
        <div className="flex flex-wrap gap-1">
          {roll.tumble.slice(0, 12).map((d, i) => (
            <Chip key={`${roll.id}-${i}`} text="?" kind={d.kind} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Body({ roll, expanded }: { roll: RollRecord; expanded: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mono truncate text-12 text-faint">{roll.normalized || roll.formula}</span>
      <div className="flex flex-wrap items-center gap-1">
        {roll.terms.map((t, i) => (
          <TermChips key={`${roll.id}-${i}`} term={t} />
        ))}
      </div>
      {expanded && Object.keys(roll.byTag).length > 1 ? (
        <ul className="flex flex-wrap gap-x-3 text-12 text-muted">
          {Object.entries(roll.byTag).map(([tag, v]) => (
            <li key={tag}>
              <span className="tabular font-bold text-bone">{v}</span> {tag}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TermChips({ term }: { term: RollTerm }) {
  if (term.kind === "const")
    return (
      <span className="tabular text-12 text-muted">{term.value >= 0 ? `+${term.value}` : term.value}</span>
    );
  if (term.kind === "ref")
    return (
      <span className="tabular text-12 text-muted" title={term.ref}>
        {term.value >= 0 ? `+${term.value}` : term.value}
      </span>
    );
  return (
    <>
      {term.dice.map((d, i) => (
        <Chip
          key={i}
          text={String(d.value)}
          kind={`d${term.sides}`}
          dropped={!d.kept}
          exploded={d.exploded}
          natural={
            term.sides === 20 && d.kept
              ? d.value === 20
                ? "crit"
                : d.value === 1
                  ? "fumble"
                  : undefined
              : undefined
          }
        />
      ))}
    </>
  );
}

function Chip({
  text,
  kind,
  dropped = false,
  exploded = false,
  natural,
}: {
  text: string;
  kind: string;
  dropped?: boolean;
  exploded?: boolean;
  natural?: "crit" | "fumble";
}) {
  const tone =
    natural === "crit"
      ? "border-brass-bright text-brass-bright"
      : natural === "fumble"
        ? "border-ember text-ember"
        : "border-line text-bone";
  return (
    <span
      data-testid="die-chip"
      data-kind={kind}
      className={`tabular relative inline-flex h-6 min-w-6 items-center justify-center rounded-[var(--radius-chip)] border bg-ink-900 px-1 text-12 font-bold ${tone} ${dropped ? "text-faint line-through opacity-60" : ""}`}
      title={`${kind}${dropped ? " (dropped)" : ""}${exploded ? " (exploded)" : ""}`}
    >
      {text}
      {exploded ? (
        <Sparkle size={9} className="absolute -top-1 -right-1 text-brass-bright" aria-label="exploded" />
      ) : null}
    </span>
  );
}
