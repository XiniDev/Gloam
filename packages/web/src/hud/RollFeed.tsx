import type { MaskedRoll, RollRecord, RollTerm, RollVisibility } from "@gloam/shared/dice";
import { ChevronDown, ChevronUp, EyeOff, Hand, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type FeedRoll, isMasked, useRolls } from "../dice/state.ts";
import { SparkIcon } from "../icons/dice.tsx";
import { useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { BottomSheet } from "../ui/BottomSheet.tsx";
import { IconButton } from "../ui/Button.tsx";
import { WaxSeal } from "../ui/ornaments.tsx";
import { Portrait } from "../ui/Portrait.tsx";
import { D20Spinner } from "../ui/Spinner.tsx";
import { useHudInsets, useIsPhone, useObstacle } from "./insets.ts";
import { useAssetImage } from "./useAssetImage.ts";

/** A phone shows the newest card this long after its dice settle, then tucks it into the tab. */
const PHONE_FRESH_MS = 6000;

/**
 * The roll feed (SPEC §8.9): bottom-left beside the left toolbar, newest first — the last three when collapsed, the
 * last thirty open. Each card: the roller's portrait and colour, label, formula, a chip per die (kept, dropped struck
 * through, exploded with a spark, natural 20 golden, natural 1 ember) — empty until the dice settle, so the chips
 * never give a result away before the dice do — the total in display numerals once they have (a turning d20 until
 * then), a hand for a physical roll, and for the roller and DMs which rolls were private; masked cards with "?" chips
 * and no label (§18.3), "The DM" under the seal for the DM's own. Click a card for the breakdown. On a phone it's a tab
 * above the action bar: the newest card shows over it while its dice roll and for a moment after, and the tab opens
 * the whole feed as a bottom sheet.
 */
export function RollFeed() {
  const feed = useRolls((s) => s.feed);
  const phone = useIsPhone();
  if (feed.length === 0) return null;
  return phone ? <PhoneFeed feed={feed} /> : <DesktopFeed feed={feed} />;
}

function DesktopFeed({ feed }: { feed: FeedRoll[] }) {
  const rolling = useRolls((s) => s.rolling);
  const left = useHudInsets((s) => s.left);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLOListElement>(null);
  const [cut, setCut] = useState(false);
  // Tool option bars start to the right of the feed (they share the bottom edge).
  useLayoutEffect(() => {
    const el = ref.current;
    const set = (w: number) => {
      if (useHudInsets.getState().feed !== w) useHudInsets.getState().set({ feed: w });
    };
    if (!el) return;
    const update = () => set(Math.round(el.getBoundingClientRect().width) + 8);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      set(0);
    };
  }, []);
  // The dice come to rest clear of it.
  useObstacle("feed", ref);
  // Open with more above: its top edge fades, so a card cut by it reads as "more above", not as a broken card.
  // Measured after every render (a new card grows the list without resizing the scroller) and on scrolling.
  const measureCut = () => {
    const el = scroller.current;
    setCut(Boolean(el && open && el.scrollHeight - el.clientHeight - Math.abs(el.scrollTop) > 2));
  };
  useLayoutEffect(measureCut);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !open) return;
    const on = () => {
      setCut(el.scrollHeight - el.clientHeight - Math.abs(el.scrollTop) > 2);
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [open]);
  const shown = feed.slice(0, open ? 30 : 3);
  return (
    <section
      ref={ref}
      aria-label="Roll feed"
      data-testid="roll-feed"
      className="pointer-events-none absolute bottom-3 z-30 flex w-[272px] max-w-[calc(100vw-24px)] flex-col-reverse gap-1.5"
      style={{ left }}
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
      <ol
        ref={scroller}
        className={`flex flex-col-reverse gap-1.5 ${open ? "max-h-[55vh] overflow-y-auto" : ""}`}
        style={
          cut
            ? {
                maskImage: "linear-gradient(to bottom, transparent 0, black 28px)",
                WebkitMaskImage: "linear-gradient(to bottom, transparent 0, black 28px)",
              }
            : undefined
        }
      >
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

function PhoneFeed({ feed }: { feed: FeedRoll[] }) {
  const rolling = useRolls((s) => s.rolling);
  const bottom = useHudInsets((s) => Math.max(12, s.bottom));
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const newest = feed[0] as FeedRoll;
  const newestSettled = !rolling.has(newest.id);
  // The newest card shows while its dice roll and a moment after they settle.
  const [fresh, setFresh] = useState<string | null>(newest.id);
  useEffect(() => {
    setFresh(newest.id);
  }, [newest.id]);
  useEffect(() => {
    if (!newestSettled || fresh !== newest.id) return;
    const t = setTimeout(() => setFresh(null), PHONE_FRESH_MS);
    return () => clearTimeout(t);
  }, [newestSettled, fresh, newest.id]);
  const ref = useRef<HTMLElement>(null);
  useObstacle("feed", ref, !open);
  if (open)
    return (
      <BottomSheet
        label="Rolls"
        testId="roll-feed"
        initialSnap={1}
        header={
          <header className="flex w-full items-center justify-between pb-1 pl-1">
            <h2 className="caps text-12 text-fog">Rolls</h2>
            <IconButton label="Close the rolls" onClick={() => setOpen(false)}>
              <X size={18} />
            </IconButton>
          </header>
        }
      >
        <ol className="flex flex-col gap-1.5">
          {feed.slice(0, 30).map((r) => (
            <li key={r.id}>
              <RollCard
                roll={r}
                settled={!rolling.has(r.id)}
                expanded={expanded === r.id}
                onToggle={() => setExpanded((e) => (e === r.id ? null : r.id))}
              />
            </li>
          ))}
        </ol>
      </BottomSheet>
    );
  const latest = !isMasked(newest) && newestSettled ? newest.total : null;
  return (
    <section
      ref={ref}
      aria-label="Roll feed"
      data-testid="roll-feed"
      className="pointer-events-none absolute left-3 z-30 flex w-[272px] max-w-[calc(100vw-24px)] flex-col-reverse gap-1.5"
      style={{ bottom }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="panel pointer-events-auto flex h-11 min-h-[var(--touch-min)] w-fit items-center gap-3 px-3 text-12 text-muted hover:text-bone"
        aria-expanded={false}
        aria-label={`Rolls${latest !== null ? ` (latest ${latest})` : ""}`}
      >
        <span className="caps">Rolls</span>
        {latest !== null ? (
          <span className="display tabular text-18 leading-none text-bone">{latest}</span>
        ) : null}
        <ChevronUp size={14} />
      </button>
      {fresh === newest.id ? (
        <div className="pointer-events-auto">
          <RollCard
            roll={newest}
            settled={newestSettled}
            expanded={expanded === newest.id}
            onToggle={() => setExpanded((e) => (e === newest.id ? null : newest.id))}
          />
        </div>
      ) : null}
    </section>
  );
}

const PRIVATE: Record<Exclude<RollVisibility, "public">, string> = {
  dm: "Private",
  blind: "Blind",
  self: "Self",
};

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
  const role = useTable((s) => s.presence.find((p) => p.userId === roll.userId)?.role);
  const mine = roll.userId === me;
  const masked = isMasked(roll);
  const dmMasked = isMasked(roll) && roll.byDm;
  const name = dmMasked ? "The DM" : mine ? "You" : roll.name;
  const hidden = !masked && roll.visibility !== "public" ? PRIVATE[roll.visibility] : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid="roll-card"
      data-roll={roll.id}
      data-settled={settled ? "1" : "0"}
      className="panel flex w-full flex-col gap-1 border-l-4 px-3 py-2 text-left"
      style={{ borderLeftColor: dmMasked ? "var(--wax-500)" : roll.color || "var(--border)" }}
    >
      <div className="flex w-full items-center gap-2">
        {dmMasked ? (
          <WaxSeal size={24} label="DM" />
        ) : (
          <RollerPortrait
            roll={roll}
            dm={role === "dm" || role === "admin" ? (role === "admin" ? "Host" : "DM") : undefined}
          />
        )}
        <span className="truncate text-13 font-bold text-bone">{name}</span>
        {roll.label ? <span className="truncate text-12 text-muted">{roll.label}</span> : null}
        {roll.manual ? <Hand size={13} className="shrink-0 text-muted" aria-label="Rolled by hand" /> : null}
        {hidden ? (
          <span
            data-testid="roll-private"
            className="caps flex shrink-0 items-center gap-1 text-12 text-fog"
            title={hidden === "Self" ? "Only the roller (and DMs) see it" : "Players don't see this roll"}
          >
            <EyeOff size={12} aria-hidden />
            {hidden}
          </span>
        ) : null}
        <span className="ml-auto shrink-0">
          {masked ? (
            <span className="display text-22 leading-none text-faint">?</span>
          ) : (
            <Total roll={roll} settled={settled} />
          )}
        </span>
      </div>
      {masked ? <MaskedBody roll={roll} /> : <Body roll={roll} settled={settled} expanded={expanded} />}
    </button>
  );
}

/** The roller: the token they rolled for when it has art this viewer can see, else themselves. */
function RollerPortrait({ roll, dm }: { roll: FeedRoll; dm?: "DM" | "Host" | undefined }) {
  const tokenId = isMasked(roll) ? undefined : roll.tokenId;
  const art = useBoard((d) => {
    const t = tokenId ? d.tokens.get(tokenId) : undefined;
    return t ? t.portraitAssetId || t.assetId || null : null;
  });
  const src = useAssetImage(art, 64);
  return (
    <Portrait name={roll.name} color={roll.color} size={24} src={src} sealRoom {...(dm ? { dm } : {})} />
  );
}

function Total({ roll, settled }: { roll: RollRecord; settled: boolean }) {
  if (!settled)
    return (
      <span className="grid h-7 w-7 place-items-center text-faint" data-testid="roll-pending">
        <D20Spinner size={18} label="Rolling" />
      </span>
    );
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

function Body({ roll, settled, expanded }: { roll: RollRecord; settled: boolean; expanded: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mono truncate text-12 text-faint">{roll.normalized || roll.formula}</span>
      <div className="flex flex-wrap items-center gap-1">
        {roll.terms.map((t, i) => (
          <TermChips key={`${roll.id}-${i}`} term={t} settled={settled} />
        ))}
      </div>
      {settled && expanded && Object.keys(roll.byTag).length > 1 ? (
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

function TermChips({ term, settled }: { term: RollTerm; settled: boolean }) {
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
  // Still tumbling: an empty chip per die (the dice show the numbers first).
  if (!settled)
    return (
      <>
        {term.dice.map((_, i) => (
          <Chip key={i} text="" kind={`d${term.sides}`} />
        ))}
      </>
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
      data-empty={text === "" ? "1" : undefined}
      className={`tabular relative inline-flex h-6 min-w-6 items-center justify-center rounded-[var(--radius-chip)] border px-1 text-12 font-bold ${text === "" ? "border-dashed border-line bg-transparent" : `bg-ink-900 ${tone}`} ${dropped ? "text-faint line-through opacity-60" : ""}`}
      title={`${kind}${dropped ? " (dropped)" : ""}${exploded ? " (exploded)" : ""}`}
    >
      {text}
      {exploded ? <SparkIcon size={10} className="absolute -top-1 -right-1 text-brass-bright" /> : null}
    </span>
  );
}
