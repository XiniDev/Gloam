import { normalizeFormula, withHint } from "@gloam/shared/dice";
import type { RequestCard } from "@gloam/shared/protocol";
import { ArrowDown, ArrowUp, ChevronUp, SkipForward, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { D20Icon, HandDieIcon } from "../icons/dice.tsx";
import { StatusIcon } from "../icons/status.tsx";
import { keepRequest, respondRequest, useSheets } from "../net/sheets.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { DeathPip } from "../ui/DeathPip.tsx";
import { toast } from "../ui/Toast.tsx";
import { keepHyphenated } from "../ui/text.tsx";
import { makeRoomForDice } from "./insets.ts";

/** An answered card stays this long to show its result, then steps aside (the request itself stays open). */
const ANSWERED_MS = 6000;

/** One creature's line on a request card: its name and formula, then Roll / Enter physical roll / Skip, or how it went. */
function Row({ c, onAnswered }: { c: RequestCard; onAnswered: () => void }) {
  const [manual, setManual] = useState(false);
  const [total, setTotal] = useState("");
  const [busy, setBusy] = useState<"roll" | "manual" | "skip" | null>(null);
  // Its conditions' advantage or disadvantage: on unless the roller sets it aside (AC-DICE-11).
  const [useHint, setUseHint] = useState(true);
  // SRD 5.1's Inspiration: Advantage on this roll, the roller's to spend (rules audit C4).
  const [inspire, setInspire] = useState(false);
  const answer = async (action: "roll" | "manual" | "skip") => {
    const n = Number(total);
    if (action === "manual" && (!total.trim() || !Number.isInteger(n))) return;
    setBusy(action);
    if (action === "roll") makeRoomForDice();
    try {
      await respondRequest(
        c.requestId,
        c.targetId,
        action,
        action === "manual" ? n : undefined,
        Boolean(c.hint) && !useHint,
        inspire && action !== "skip",
      );
      setManual(false);
    } catch (e) {
      toast.danger("Couldn't answer that", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const pending = c.state === "pending";
  // Rolled, and its creature holds Heroic Inspiration: keep it, or spend it on a die (nothing follows until then).
  const held = c.held;
  const keep = async (reroll?: number) => {
    setBusy(reroll === undefined ? "roll" : "manual");
    try {
      await keepRequest(c.requestId, c.targetId, reroll);
    } catch (e) {
      toast.danger(
        reroll === undefined ? "Couldn't keep it" : "Couldn't roll it again",
        (e as Error).message,
      );
    } finally {
      setBusy(null);
    }
  };
  // Answered: it steps aside ANSWERED_MS after the answer was first seen — counted once, not again each time the card
  // re-renders or moves (between the board and a phone's panel).
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  const key = `${c.requestId}|${c.targetId}`;
  useEffect(() => {
    if (pending || held) return;
    const at = answeredAt(key);
    const t = window.setTimeout(() => answered.current(), Math.max(0, at + ANSWERED_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [pending, held, key]);
  const outcome = c.success === undefined ? "text-bone" : c.success ? "text-success" : "text-danger-text";
  // The formula as it will roll: with its conditions' advantage or disadvantage unless set aside ("2d20kl1 - 4").
  const formula = useMemo(() => {
    if (!pending) return c.formula;
    try {
      const hinted = c.hint && useHint ? withHint(c.formula, c.hint.mode) : c.formula;
      if (!inspire && hinted === c.formula) return c.formula;
      return normalizeFormula(inspire ? withHint(hinted, "adv") : hinted);
    } catch {
      return c.formula;
    }
  }, [pending, c.formula, c.hint, useHint, inspire]);
  return (
    <li
      className="flex flex-col gap-1.5 border-line/60 pt-2 first:pt-0 [&+&]:border-t"
      data-testid="request-card"
      data-request={c.requestId}
      data-target={c.targetId}
      data-state={c.state}
      aria-label={`${c.label} for ${c.targetName}`}
    >
      <div className="flex min-w-0 items-center gap-2 text-13">
        <span className="min-w-0 truncate text-14 font-bold text-bone">{c.targetName}</span>
        <span
          className="mono shrink-0 rounded-chip bg-ink-950/70 px-2 py-0.5 text-bone"
          data-testid="request-formula"
        >
          {formula}
        </span>
      </div>
      {c.deathSaves ? <DeathSavePips {...c.deathSaves} /> : null}
      {pending && c.hint ? (
        <div className="flex flex-wrap items-center gap-1.5 text-13" data-testid="roll-hint">
          <span
            className={`inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 ${
              useHint ? "border-brass/60 text-bone" : "border-line text-muted line-through"
            }`}
          >
            {c.hint.mode === "adv" ? <ArrowUp size={13} aria-hidden /> : <ArrowDown size={13} aria-hidden />}
            {c.hint.mode === "adv" ? "Advantage" : "Disadvantage"}
            <span className="text-muted">· {c.hint.from.join(", ")}</span>
          </span>
          <button
            type="button"
            aria-pressed={!useHint}
            onClick={() => setUseHint((u) => !u)}
            className="min-h-[var(--touch-min)] px-1.5 text-12 text-brass underline decoration-dotted underline-offset-2 hover:text-brass-bright"
          >
            {useHint ? "Set aside" : "Use it"}
          </button>
        </div>
      ) : null}
      {pending && c.inspiration === "advantage" ? (
        <label className="flex min-h-[var(--touch-min)] cursor-pointer items-center gap-2 text-13 text-bone">
          <input
            type="checkbox"
            checked={inspire}
            onChange={(e) => setInspire(e.target.checked)}
            className="h-4 w-4 accent-[var(--brass-500)]"
          />
          <StatusIcon id="inspiration" size={15} label="" />
          Spend Inspiration: Advantage on this roll
        </label>
      ) : null}
      {pending && c.autoFail?.length ? (
        <p className="text-12 text-danger-text">
          Fails outright — {c.autoFail.join(", ")} (the DM may still let it roll).
        </p>
      ) : null}
      {pending ? (
        manual ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void answer("manual");
            }}
          >
            <input
              // biome-ignore lint/a11y/noAutofocus: opened by the player's own click to type their roll
              autoFocus
              aria-label="Your total"
              inputMode="numeric"
              placeholder="Total"
              value={total}
              onChange={(e) => setTotal(e.target.value.replace(/[^0-9-]/g, "").slice(0, 5))}
              className="h-9 min-h-[var(--touch-min)] w-24 rounded-[var(--radius-control)] border border-line bg-ink-950/60 px-2 text-16 text-bone focus:border-accent focus:outline-none"
            />
            <Button
              size="S"
              variant="primary"
              type="submit"
              loading={busy === "manual"}
              disabled={!total.trim()}
            >
              Send
            </Button>
            <Button size="S" variant="ghost" onClick={() => setManual(false)}>
              Back
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="S"
              variant="primary"
              icon={<D20Icon size={15} />}
              loading={busy === "roll"}
              onClick={() => void answer("roll")}
            >
              Roll
            </Button>
            <Button
              size="S"
              variant="secondary"
              icon={<HandDieIcon size={15} />}
              onClick={() => setManual(true)}
            >
              Enter physical roll
            </Button>
            <Button
              size="S"
              variant="ghost"
              icon={<SkipForward size={15} />}
              loading={busy === "skip"}
              onClick={() => void answer("skip")}
            >
              Skip
            </Button>
          </div>
        )
      ) : held && c.total !== undefined ? (
        // Heroic Inspiration (SRD 5.2.1 p. 183): roll one die again and use the new roll — or keep this one.
        <div className="flex flex-col gap-1.5" data-testid="request-held">
          <p className="flex items-baseline gap-2 text-14" role="status">
            <span className="text-muted">You rolled</span>
            <span className="tabular text-22 font-bold text-bone">{c.total}</span>
            <span className="text-12 text-muted">— keep it, or spend Heroic Inspiration on a die?</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="S" variant="primary" loading={busy === "roll"} onClick={() => void keep()}>
              Keep
            </Button>
            {held.dice.slice(0, 4).map((d, i) => (
              <Button
                // (A roll's dice, in the order they fell: their places are their keys.)
                key={i}
                size="S"
                variant="secondary"
                icon={<StatusIcon id="inspiration" size={15} label="" />}
                loading={busy === "manual"}
                onClick={() => void keep(i)}
              >
                {`Reroll the d${d.sides} (${d.value})`}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <p className="flex items-baseline gap-2 text-14" role="status">
          {c.state === "skipped" ? (
            <span className="text-muted">Skipped.</span>
          ) : c.total !== undefined ? (
            <>
              <span className="text-muted">{c.state === "dm" ? "The DM set it:" : "You rolled"}</span>
              <span className={`tabular text-22 font-bold ${outcome}`}>{c.total}</span>
              {c.success !== undefined ? (
                <span className={`caps text-12 ${outcome}`}>{c.success ? "success" : "failure"}</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted">Sent to the DM.</span>
          )}
        </p>
      )}
    </li>
  );
}

/**
 * One request as a card (critic P6 r2 #17: one card per request, not per creature): what the DM asks — the label, the
 * DC when shown, who sees it — then a line for each creature this person answers for. In a phone's panel it starts as
 * a one-line strip that opens on a tap (the page underneath keeps its room).
 */
function Card({ rows, compact }: { rows: RequestCard[]; compact: boolean }) {
  const first = rows[0] as RequestCard;
  const [open, setOpen] = useState(!compact);
  const waiting = rows.filter((r) => r.state === "pending").length;
  const dismiss = (c: RequestCard) => useDismissed.getState().add(`${c.requestId}|${c.targetId}`);
  const heading = (
    <span className="min-w-0 flex-1">
      <span className="caps block text-12 text-brass">
        The DM asks{rows.length === 1 ? <> · {keepHyphenated(first.targetName)}</> : null}
      </span>
      {/* The card's heading in the display face, as every dialog's and card's (§27.3; critic P8 r1 #31). */}
      <span className="display block truncate text-22 leading-tight text-bone">{first.label}</span>
    </span>
  );
  if (!open)
    return (
      <li
        className="panel pointer-events-auto flex items-center gap-2 border-brass/60 py-1 pr-1 pl-3 shadow-[var(--shadow-float)]"
        data-testid="request-group"
        data-request={first.requestId}
      >
        <D20Icon size={18} className="shrink-0 text-brass" />
        <span className="min-w-0 flex-1 truncate text-14 font-bold text-bone">
          {first.label}
          <span className="font-normal text-muted">
            {" "}
            · {rows.length === 1 ? first.targetName : `${rows.length} creatures`}
          </span>
        </span>
        <Button size="S" variant="primary" onClick={() => setOpen(true)} aria-expanded={false}>
          {waiting ? "Answer" : "See"}
        </Button>
      </li>
    );
  return (
    <li
      className="panel pointer-events-auto flex flex-col gap-2 border-brass/60 p-3 shadow-[var(--shadow-float)] motion-safe:animate-[rise-in_var(--dur-base)_var(--ease-out)_both]"
      data-testid="request-group"
      data-request={first.requestId}
      aria-label={`The DM asks: ${first.label}`}
    >
      <div className="flex items-start gap-2">
        {heading}
        {compact ? (
          <IconButton label="Fold away" onClick={() => setOpen(false)} aria-expanded>
            <ChevronUp size={16} />
          </IconButton>
        ) : waiting ? null : (
          <IconButton label="Dismiss" onClick={() => rows.forEach(dismiss)}>
            <X size={16} />
          </IconButton>
        )}
      </div>
      {first.dc !== undefined || first.visibility !== "public" ? (
        <div className="flex flex-wrap items-center gap-1.5 text-13">
          {first.dc !== undefined ? (
            <span className="caps rounded-chip border border-line px-2 py-0.5 text-12 text-fog">
              DC {first.dc}
            </span>
          ) : null}
          {first.visibility === "blind" ? (
            <span className="text-12 text-muted">Blind — the DM sees the number, you won't.</span>
          ) : first.visibility === "dm" ? (
            <span className="text-12 text-muted">Only you and the DM see it.</span>
          ) : null}
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((c) => (
          <Row key={c.targetId} c={c} onAnswered={() => dismiss(c)} />
        ))}
      </ul>
    </li>
  );
}

/** A death saving throw's tally so far: three hearts for successes, three skulls for failures (§8.11). */
function DeathSavePips({ successes, failures }: { successes: number; failures: number }) {
  // The card's whole point: 20-px pips, each group captioned; a success a verdigris heart, a failure a blood skull,
  // one still to come a quiet outline (critic P7 r1: 15-px faint outlines were the weakest thing on the card).
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1"
      role="img"
      aria-label={`${successes} of 3 successes, ${failures} of 3 failures`}
      data-testid="death-save-pips"
    >
      <span className="flex items-center gap-1.5">
        <span className="caps text-12 text-fog">Successes</span>
        {[0, 1, 2].map((i) => (
          <DeathPip key={i} kind="success" filled={i < successes} />
        ))}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="caps text-12 text-fog">Failures</span>
        {[0, 1, 2].map((i) => (
          <DeathPip key={i} kind="failure" filled={i < failures} />
        ))}
      </span>
    </div>
  );
}

/** Cards stepped aside (answered, or dismissed), shared by the floating stack and a phone's in-panel one. */
const useDismissed = create<{ keys: Set<string>; add(k: string): void }>((set) => ({
  keys: new Set(),
  add: (k) => set((s) => ({ keys: new Set(s.keys).add(k) })),
}));

/** When each card was first seen answered (ms). */
const firstAnswered = new Map<string, number>();
function answeredAt(key: string): number {
  let at = firstAnswered.get(key);
  if (at === undefined) {
    at = Date.now();
    firstAnswered.set(key, at);
  }
  return at;
}

/** The requests to answer, one group per request, in the order they came (answered and set-aside ones gone). */
export function useRequestGroups(): RequestCard[][] {
  const cards = useSheets((s) => s.cards);
  const dismissed = useDismissed((s) => s.keys);
  return useMemo(() => {
    const groups = new Map<string, RequestCard[]>();
    for (const c of cards.values()) {
      if (!c.open || dismissed.has(`${c.requestId}|${c.targetId}`)) continue;
      const g = groups.get(c.requestId);
      if (g) g.push(c);
      else groups.set(c.requestId, [c]);
    }
    return [...groups.values()];
  }, [cards, dismissed]);
}

export { Card as RequestGroupCard };

/**
 * Roll-request cards (SPEC §8.9 Roll requests, AC-DICE-06) in a phone's open panel: at its top, as one-line strips
 * that open on a tap (the page underneath keeps its room). Over the board they float with the DM's prompts
 * (FloatingCards).
 */
export function RequestCards() {
  const shown = useRequestGroups();
  if (!shown.length) return null;
  return (
    <ol
      aria-label="Rolls the DM asked for"
      className="pointer-events-none mx-auto flex w-full max-w-[340px] flex-col gap-2 px-2 pt-2"
    >
      {shown.map((rows) => (
        <Card key={(rows[0] as RequestCard).requestId} rows={rows} compact />
      ))}
    </ol>
  );
}
