import {
  type MaskedRoll,
  type RollRecord,
  type RollTerm,
  type RollVisibility,
  termContribution,
} from "@gloam/shared/dice";
import { ChevronDown, ChevronUp, EyeOff, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type FeedRoll, isMasked, useRolls } from "../dice/state.ts";
import { HandDieIcon, SparkIcon } from "../icons/dice.tsx";
import { useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { BottomSheet } from "../ui/BottomSheet.tsx";
import { IconButton } from "../ui/Button.tsx";
import { WaxSeal } from "../ui/ornaments.tsx";
import { Portrait } from "../ui/Portrait.tsx";
import { D20Spinner } from "../ui/Spinner.tsx";
import { useCardsAtBottom } from "./FloatingCards.tsx";
import { useBoardCovers, useCover, useHudInsets, useIsPhone, useObstacle } from "./insets.ts";
import { useAssetImage } from "./useAssetImage.ts";

/** A phone shows the newest card this long after its dice settle, then tucks it into the tab. */
const PHONE_FRESH_MS = 6000;
/** …of which the whole card shows this long after its dice settle; then it folds to its one-line row (critic P8 r2 I12). */
const PHONE_CARD_MS = 2500;

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
  // A phone's open panel is a page over the board: the feed waits under it (a roll from the panel closes it first).
  const panel = useUi((s) => s.dock !== null);
  // On a phone, cards holding the bottom band stand where its pill would peek out (critic P7 r2 #7).
  const cards = useCardsAtBottom((s) => s.on);
  if (feed.length === 0 || (phone && (panel || cards))) return null;
  return phone ? <PhoneFeed feed={feed} /> : <DesktopFeed feed={feed} />;
}

function DesktopFeed({ feed }: { feed: FeedRoll[] }) {
  const rolling = useRolls((s) => s.rolling);
  const left = useHudInsets((s) => s.left);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLOListElement>(null);
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
  // The dice come to rest clear of it; the name plates keep out from under it.
  useObstacle("feed", ref);
  useCover("feed", ref);
  // Where the action bar would run under it (a narrow screen), it stands above the bar's band instead.
  const bar = useBoardCovers((st) => st.rects.actions);
  const lift = bar && left + FEED_W + 8 > bar.left ? Math.max(12, window.innerHeight - bar.top + 4) : 12;
  // Open, the list is as tall as the newest whole cards that fit in 55 % of the screen, and scrolls a card at a time
  // (snapping card tops to its edge): a card is never cut through. An edge with more beyond it fades over 12 px.
  const [limit, setLimit] = useState<number | null>(null);
  const [more, setMore] = useState<{ above: boolean; below: boolean }>({ above: false, below: false });
  const measure = () => {
    const el = scroller.current;
    if (!el || !open) {
      setLimit(null);
      setMore((m) => (m.above || m.below ? { above: false, below: false } : m));
      return;
    }
    const cap = window.innerHeight * 0.55;
    let h = 0;
    for (const [i, li] of (Array.from(el.children) as HTMLElement[]).entries()) {
      const add = li.offsetHeight + (i ? 6 : 0);
      if (h + add > cap) break;
      h += add;
    }
    setLimit(h > 0 ? h : null);
    const up = Math.abs(el.scrollTop);
    const above = el.scrollHeight - el.clientHeight - up > 2;
    const below = up > 2;
    setMore((m) => (m.above === above && m.below === below ? m : { above, below }));
  };
  // After every render (a new card grows the list without resizing it) and on scrolling.
  useLayoutEffect(measure);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !open) return;
    el.addEventListener("scroll", measure, { passive: true });
    return () => el.removeEventListener("scroll", measure);
  });
  const fade =
    more.above || more.below
      ? `linear-gradient(to bottom, ${more.above ? "transparent 0, black 12px" : "black 0"}, ${more.below ? "black calc(100% - 12px), transparent 100%" : "black 100%"})`
      : undefined;
  const shown = feed.slice(0, open ? 30 : 1);
  // Closed: the newest in full, the two before it a line each (a run of the DM's hidden rolls as one line).
  const older = open ? [] : lines(feed.slice(1), 2);
  return (
    <section
      ref={ref}
      aria-label="Roll feed"
      data-testid="roll-feed"
      className="pointer-events-none absolute z-30 flex w-[272px] max-w-[calc(100vw-24px)] flex-col-reverse gap-1.5"
      style={{ left, bottom: lift }}
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
        className={`flex flex-col-reverse gap-1.5 ${open ? "snap-y snap-mandatory overflow-y-auto" : ""}`}
        style={{
          ...(open && limit ? { maxHeight: limit } : {}),
          ...(fade ? { maskImage: fade, WebkitMaskImage: fade } : {}),
        }}
      >
        {shown.map((r) => (
          <li key={r.id} className="pointer-events-auto snap-start">
            <RollCard
              roll={r}
              settled={!rolling.has(r.id)}
              expanded={expanded === r.id}
              onToggle={() => setExpanded((e) => (e === r.id ? null : r.id))}
            />
          </li>
        ))}
        {older.map((l) => (
          <li key={l.key} className="pointer-events-auto">
            <RollLine
              line={l}
              settled={l.rolls.every((r) => !rolling.has(r.id))}
              onOpen={() => setOpen(true)}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The feed's width (px). */
const FEED_W = 272;

/** An older roll as a line — or a run of the DM's hidden rolls, one line for them all. */
interface Line {
  key: string;
  rolls: FeedRoll[];
}
function lines(feed: FeedRoll[], max: number): Line[] {
  const out: Line[] = [];
  for (const r of feed) {
    const last = out[out.length - 1];
    const hiddenDm = (x: FeedRoll) => isMasked(x) && x.byDm;
    if (last && hiddenDm(r) && last.rolls.every(hiddenDm)) {
      last.rolls.push(r);
      continue;
    }
    if (out.length >= max) break;
    out.push({ key: r.id, rolls: [r] });
  }
  return out;
}

/** One older roll in a line: who (or what for), the total; a click opens the whole feed. */
function RollLine({ line, settled, onOpen }: { line: Line; settled: boolean; onOpen: () => void }) {
  const me = useTable((s) => s.me?.userId);
  const r = line.rolls[0] as FeedRoll;
  const masked = isMasked(r);
  const many = line.rolls.length;
  const byDm = masked ? r.byDm : false;
  const who = masked ? (many > 1 ? `The DM rolled ${many} times` : r.text) : r.userId === me ? "You" : r.name;
  const what = masked ? null : r.label || r.formula;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="roll-line"
      className="panel flex h-8 w-full items-center gap-2 border-l-4 px-2.5 text-left"
      style={{ borderLeftColor: byDm ? "var(--wax-500)" : (!masked && r.color) || "var(--border)" }}
      title={what ? `${who}: ${what}` : who}
    >
      <span className="min-w-0 flex-1 truncate text-12 text-bone/85">
        {what ? (
          <>
            {what} <span className="text-muted">· {who}</span>
          </>
        ) : (
          who
        )}
      </span>
      <span className="tabular shrink-0 text-14 font-bold text-bone">
        {masked ? <span className="text-faint">?</span> : settled ? r.total : "…"}
      </span>
    </button>
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
  // A phone's board is small: the card folds to its one-line row soon after the dice settle, then goes (the pill keeps
  // the total).
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    setFolded(false);
    if (!newestSettled || fresh !== newest.id) return;
    const f = setTimeout(() => setFolded(true), PHONE_CARD_MS);
    const t = setTimeout(() => setFresh(null), PHONE_FRESH_MS);
    return () => {
      clearTimeout(f);
      clearTimeout(t);
    };
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
          {folded && expanded !== newest.id ? (
            <RollLine line={{ key: newest.id, rolls: [newest] }} settled onOpen={() => setOpen(true)} />
          ) : (
            <RollCard
              roll={newest}
              settled={newestSettled}
              expanded={expanded === newest.id}
              onToggle={() => setExpanded((e) => (e === newest.id ? null : newest.id))}
            />
          )}
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
  // The DM's rolls, public or masked, carry the seal and the wax bar: one look for the DM wherever they roll.
  const byDm = isMasked(roll) ? roll.byDm : role === "dm" || role === "admin";
  // A masked card says its sentence once ("The DM rolls…", "Dave rolled privately"), as its heading.
  const name = isMasked(roll) ? roll.text : mine ? "You" : roll.name;
  const hidden = !masked && roll.visibility !== "public" ? PRIVATE[roll.visibility] : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid="roll-card"
      data-roll={roll.id}
      data-settled={settled ? "1" : "0"}
      className="panel flex w-full flex-col gap-1 border-l-4 px-3 py-2 text-left"
      style={{ borderLeftColor: byDm ? "var(--wax-500)" : roll.color || "var(--border)" }}
    >
      <div className="flex w-full items-start gap-2">
        {byDm ? <WaxSeal size={24} label="DM" /> : <RollerPortrait roll={roll} />}
        {/* What it was for leads (two lines at most: the creature's name is never the part cut off); who rolled it,
            by hand or in private, underneath. */}
        <span className="flex min-w-0 flex-1 flex-col">
          {/* Unlabelled: its formula is what it was (critic P8 r2 N3), the roller underneath as for any other. */}
          <span className="line-clamp-2 text-13 font-bold leading-snug text-bone [overflow-wrap:anywhere]">
            {masked ? name : roll.label || roll.formula}
          </span>
          {!masked || roll.manual || hidden ? (
            <span className="flex items-center gap-1.5 text-12 text-muted">
              {!masked ? <span className="truncate">{name}</span> : null}
              {roll.manual ? (
                <HandDieIcon
                  size={14}
                  className="shrink-0"
                  role="img"
                  aria-hidden={false}
                  aria-label="Rolled by hand"
                />
              ) : null}
              {hidden ? (
                <span
                  data-testid="roll-private"
                  className="flex shrink-0 items-center text-fog"
                  title={
                    hidden === "Self"
                      ? "Self: only the roller (and DMs) see it"
                      : hidden === "Blind"
                        ? "Blind: only the DM sees the result"
                        : "Private: players don't see this roll"
                  }
                >
                  <EyeOff size={13} aria-hidden />
                  <span className="sr-only">{hidden}</span>
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="shrink-0">
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
function RollerPortrait({ roll }: { roll: FeedRoll }) {
  const tokenId = isMasked(roll) ? undefined : roll.tokenId;
  const art = useBoard((d) => {
    const t = tokenId ? d.tokens.get(tokenId) : undefined;
    return t ? t.portraitAssetId || t.assetId || null : null;
  });
  const src = useAssetImage(art, 64);
  return <Portrait name={roll.name} color={roll.color} size={24} src={src} />;
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
  const open = settled && expanded;
  return (
    <div className="flex flex-col gap-1">
      <span className={`mono text-12 text-faint ${open ? "break-words" : "truncate"}`}>
        {roll.normalized || roll.formula}
      </span>
      {open ? (
        <Breakdown roll={roll} />
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {roll.terms.map((t, i) => (
            <TermChips key={`${roll.id}-${i}`} term={t} settled={settled} />
          ))}
        </div>
      )}
    </div>
  );
}

const signed = (v: number) => (v >= 0 ? `+${v}` : `−${Math.abs(v)}`);

/**
 * The full breakdown (§8.9 "click to expand"): a row per term — its dice as rolled, what each came to after rerolls,
 * which were dropped and which exploded, and the term's subtotal; modifiers and sheet references by name; the totals
 * per damage type.
 */
function Breakdown({ roll }: { roll: RollRecord }) {
  const tags = Object.entries(roll.byTag);
  return (
    <div data-testid="roll-breakdown" className="flex flex-col gap-1.5 pt-0.5">
      {/* Three columns — the term, its dice, its value — the term column as wide as its longest name. */}
      <ul className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
        {roll.terms.map((t, i) => (
          <li key={`${roll.id}-b${i}`} className="contents">
            <span className="mono truncate text-12 text-muted">
              {t.sign === -1 ? "− " : ""}
              {t.kind === "dice"
                ? `${t.count}d${t.sides}${t.tag ? ` ${t.tag}` : ""}`
                : t.kind === "ref"
                  ? t.ref
                  : "modifier"}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {t.kind === "dice" ? <TermChips term={t} settled showRerolls /> : null}
            </span>
            <span className="tabular text-right text-13 font-bold text-bone">
              {t.kind === "dice" && t.sign !== -1 ? t.subtotal : signed(termContribution(t))}
            </span>
          </li>
        ))}
      </ul>
      {tags.length > 1 || (tags.length === 1 && tags[0]?.[0] !== "untyped") ? (
        <ul className="flex flex-wrap gap-x-3 border-t border-line pt-1 text-12 text-muted">
          {tags.map(([tag, v]) => (
            <li key={tag}>
              <span className="tabular font-bold text-bone">{v}</span> {tag}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TermChips({
  term,
  settled,
  showRerolls = false,
}: {
  term: RollTerm;
  settled: boolean;
  /** The faces a die rolled before its reroll, struck through before it (the breakdown). */
  showRerolls?: boolean;
}) {
  // A modifier with the formula's own sign ("1d20 − 4" shows −4).
  if (term.kind === "const")
    return <span className="tabular text-12 text-muted">{signed(termContribution(term))}</span>;
  if (term.kind === "ref")
    return (
      <span className="tabular text-12 text-muted" title={term.ref}>
        {signed(termContribution(term))}
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
          before={showRerolls ? d.rerolledFrom : undefined}
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
  before,
}: {
  text: string;
  kind: string;
  dropped?: boolean;
  exploded?: boolean;
  natural?: "crit" | "fumble";
  /** Faces rolled before a reroll, oldest first. */
  before?: number[] | undefined;
}) {
  const tone =
    natural === "crit"
      ? "border-brass-bright text-brass-bright"
      : natural === "fumble"
        ? "border-ember text-ember"
        : "border-line text-bone";
  const chip = (
    <span
      data-testid="die-chip"
      data-kind={kind}
      data-empty={text === "" ? "1" : undefined}
      className={`tabular relative inline-flex h-6 min-w-6 items-center justify-center rounded-[var(--radius-chip)] border px-1 text-12 font-bold pointer-coarse:h-7 pointer-coarse:min-w-7 max-sm:h-7 max-sm:min-w-7 ${text === "" ? "border-dashed border-line bg-transparent" : `bg-ink-900 ${tone}`} ${dropped ? "text-faint line-through opacity-60" : ""}`}
      title={`${kind}${dropped ? " (dropped)" : ""}${exploded ? " (exploded)" : ""}`}
    >
      {text}
      {exploded ? <SparkIcon size={10} className="absolute -top-1 -right-1 text-brass-bright" /> : null}
    </span>
  );
  if (!before?.length) return chip;
  return (
    <span className="inline-flex items-center gap-0.5" title={`Rerolled from ${before.join(", ")}`}>
      {before.map((v, i) => (
        <span key={i} className="tabular text-12 text-faint line-through">
          {v}
        </span>
      ))}
      {chip}
    </span>
  );
}
