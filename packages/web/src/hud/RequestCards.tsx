import type { RequestCard } from "@gloam/shared/protocol";
import { ChevronUp, SkipForward, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { audio } from "../audio/engine.ts";
import { D20Icon, HandDieIcon } from "../icons/dice.tsx";
import { requestArrived, respondRequest, useSheets } from "../net/sheets.ts";
import { useUi } from "../state/ui.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { toast } from "../ui/Toast.tsx";
import { makeRoomForDice, useCover, useHudInsets, useIsPhone, useObstacle } from "./insets.ts";

/** An answered card stays this long to show its result, then steps aside (the request itself stays open). */
const ANSWERED_MS = 6000;

/** One creature's line on a request card: its name and formula, then Roll / Enter physical roll / Skip, or how it went. */
function Row({ c, onAnswered }: { c: RequestCard; onAnswered: () => void }) {
  const [manual, setManual] = useState(false);
  const [total, setTotal] = useState("");
  const [busy, setBusy] = useState<"roll" | "manual" | "skip" | null>(null);
  const answer = async (action: "roll" | "manual" | "skip") => {
    const n = Number(total);
    if (action === "manual" && (!total.trim() || !Number.isInteger(n))) return;
    setBusy(action);
    if (action === "roll") makeRoomForDice();
    try {
      await respondRequest(c.requestId, c.targetId, action, action === "manual" ? n : undefined);
      setManual(false);
    } catch (e) {
      toast.danger("Couldn't answer that", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const pending = c.state === "pending";
  // Answered: it steps aside ANSWERED_MS after the answer was first seen — counted once, not again each time the card
  // re-renders or moves (between the board and a phone's panel).
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  const key = `${c.requestId}|${c.targetId}`;
  useEffect(() => {
    if (pending) return;
    const at = answeredAt(key);
    const t = window.setTimeout(() => answered.current(), Math.max(0, at + ANSWERED_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [pending, key]);
  const outcome = c.success === undefined ? "text-bone" : c.success ? "text-success" : "text-danger-text";
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
        <span className="mono shrink-0 rounded-chip bg-ink-950/70 px-2 py-0.5 text-bone">{c.formula}</span>
      </div>
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
        The DM asks{rows.length === 1 ? ` · ${first.targetName}` : ""}
      </span>
      <span className="block truncate text-18 font-bold text-bone">{first.label}</span>
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

/**
 * Roll-request cards (SPEC §8.9 Roll requests, AC-DICE-06): each request that asks creatures this person controls gets a
 * card — the label, the DC when shown — with a line per creature: its formula from the sheet, Roll, Enter physical
 * roll and Skip. Centred over the free board under the top bar, between the toolbar and the dock (never over a panel);
 * on a phone with a panel open, at the top of the panel itself as one-line strips (`inline`). One card on a phone,
 * three on a larger screen, then "Show n more".
 */
export function RequestCards({ inline = false }: { inline?: boolean }) {
  const cards = useSheets((s) => s.cards);
  const dismissed = useDismissed((s) => s.keys);
  const [all, setAll] = useState(false);
  // Grouped by request, in the order they came.
  const shown = useMemo(() => {
    const groups = new Map<string, RequestCard[]>();
    for (const c of cards.values()) {
      if (!c.open || dismissed.has(`${c.requestId}|${c.targetId}`)) continue;
      const g = groups.get(c.requestId);
      if (g) g.push(c);
      else groups.set(c.requestId, [c]);
    }
    return [...groups.values()];
  }, [cards, dismissed]);
  const top = useHudInsets((s) => s.top);
  const banner = useHudInsets((s) => s.banner);
  const left = useHudInsets((s) => s.left);
  const right = useHudInsets((s) => s.right);
  const corners = useHudInsets((s) => Math.max(s.cornerLeft, s.cornerRight));
  const phone = useIsPhone();
  const dockOpen = useUi((s) => s.dock !== null);
  // A phone's open panel takes these in; the floating stack steps back.
  const away = !inline && phone && dockOpen;
  const ref = useRef<HTMLOListElement>(null);
  useObstacle("requests", ref, shown.length > 0 && !inline && !away);
  useCover("requests", ref, shown.length > 0 && !inline && !away);
  // A new card arrives with a soft chime (the DM is waiting on it) — once, from the floating stack.
  useEffect(() => (inline ? undefined : requestArrived.on(() => void audio.play("chime"))), [inline]);
  if (!shown.length || away) return null;
  const max = all ? shown.length : phone ? 1 : 3;
  const list = (
    <ol
      ref={ref}
      aria-label="Rolls the DM asked for"
      className={`pointer-events-none flex w-full max-w-[340px] flex-col gap-2 ${inline ? "mx-auto px-2 pt-2" : ""}`}
    >
      {shown.slice(0, max).map((rows) => (
        <Card key={(rows[0] as RequestCard).requestId} rows={rows} compact={inline} />
      ))}
      {shown.length > max ? (
        <li className="self-center">
          <Button size="S" variant="secondary" className="pointer-events-auto" onClick={() => setAll(true)}>
            Show {shown.length - max} more
          </Button>
        </li>
      ) : null}
    </ol>
  );
  if (inline) return list;
  return (
    <div
      className="pointer-events-none absolute z-30 flex justify-center"
      style={
        phone
          ? { top: Math.max(top, corners) + banner + 8, left: 12, right: 12 }
          : { top: top + banner + 8, left: left + 8, right: right + 8 }
      }
    >
      {list}
    </div>
  );
}
