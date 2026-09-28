import type { RequestCard } from "@gloam/shared/protocol";
import { Dices, Hand, SkipForward, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { audio } from "../audio/engine.ts";
import { requestArrived, respondRequest, useSheets } from "../net/sheets.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { toast } from "../ui/Toast.tsx";
import { useHudInsets, useIsPhone, useObstacle } from "./insets.ts";

/** An answered card stays this long to show its result, then steps aside (the request itself stays open). */
const ANSWERED_MS = 6000;

function Card({ c, onDismiss }: { c: RequestCard; onDismiss: () => void }) {
  const [manual, setManual] = useState(false);
  const [total, setTotal] = useState("");
  const [busy, setBusy] = useState<"roll" | "manual" | "skip" | null>(null);
  const answer = async (action: "roll" | "manual" | "skip") => {
    const n = Number(total);
    if (action === "manual" && (!total.trim() || !Number.isInteger(n))) return;
    setBusy(action);
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
  useEffect(() => {
    if (pending) return;
    const t = window.setTimeout(onDismiss, ANSWERED_MS);
    return () => window.clearTimeout(t);
  }, [pending, onDismiss]);
  const outcome = c.success === undefined ? "text-bone" : c.success ? "text-success" : "text-danger-text";
  return (
    <li
      className="panel pointer-events-auto flex flex-col gap-2 border-brass/60 p-3 shadow-[var(--shadow-float)] motion-safe:animate-[rise-in_var(--dur-base)_var(--ease-out)_both]"
      data-testid="request-card"
      data-request={c.requestId}
      data-target={c.targetId}
      data-state={c.state}
      aria-label={`${c.label} for ${c.targetName}`}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="caps block text-12 text-brass">The DM asks · {c.targetName}</span>
          <span className="block truncate text-18 font-bold text-bone">{c.label}</span>
        </span>
        {pending ? null : (
          <IconButton label="Dismiss" onClick={onDismiss}>
            <X size={16} />
          </IconButton>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-13">
        <span className="mono rounded-chip bg-ink-950/70 px-2 py-0.5 text-bone">{c.formula}</span>
        {c.dc !== undefined ? (
          <span className="caps rounded-chip border border-line px-2 py-0.5 text-12 text-fog">DC {c.dc}</span>
        ) : null}
        {c.visibility === "blind" ? (
          <span className="text-12 text-muted">Blind — the DM sees the number, you won't.</span>
        ) : c.visibility === "dm" ? (
          <span className="text-12 text-muted">Only you and the DM see it.</span>
        ) : null}
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
              className="tabular h-9 min-h-[var(--touch-min)] w-24 rounded-[var(--radius-control)] border border-line bg-ink-950/60 px-2 text-16 text-bone focus:border-accent focus:outline-none"
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
              icon={<Dices size={15} />}
              loading={busy === "roll"}
              onClick={() => void answer("roll")}
            >
              Roll
            </Button>
            <Button size="S" variant="secondary" icon={<Hand size={15} />} onClick={() => setManual(true)}>
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
 * Roll-request cards (SPEC §8.9 Roll requests, AC-DICE-06): each creature the DM asks that this person controls gets a
 * card — the label, its formula from the sheet, the DC when shown — with Roll, Enter physical roll and Skip. Top
 * centre under the top bar (the turn tracker's strip sits above them once combat has one), clear of the dice.
 */
export function RequestCards() {
  const cards = useSheets((s) => s.cards);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const shown = useMemo(
    () => [...cards.values()].filter((c) => c.open && !dismissed.has(`${c.requestId}|${c.targetId}`)),
    [cards, dismissed],
  );
  const top = useHudInsets((s) => s.top);
  const banner = useHudInsets((s) => s.banner);
  const corners = useHudInsets((s) => Math.max(s.cornerLeft, s.cornerRight));
  const phone = useIsPhone();
  const ref = useRef<HTMLOListElement>(null);
  useObstacle("requests", ref, shown.length > 0);
  // A new card arrives with a soft chime (the DM is waiting on it).
  useEffect(() => requestArrived.on(() => void audio.play("chime")), []);
  if (!shown.length) return null;
  return (
    <ol
      ref={ref}
      aria-label="Rolls the DM asked for"
      className="pointer-events-none absolute left-1/2 z-30 flex w-[340px] max-w-[calc(100vw-24px)] -translate-x-1/2 flex-col gap-2"
      style={{ top: (phone ? Math.max(top, corners) : top) + banner + 8 }}
    >
      {shown.slice(0, phone ? 1 : 3).map((c) => {
        const key = `${c.requestId}|${c.targetId}`;
        return <Card key={key} c={c} onDismiss={() => setDismissed((d) => new Set(d).add(key))} />;
      })}
      {shown.length > (phone ? 1 : 3) ? (
        <li className="panel pointer-events-auto self-center px-3 py-1 text-13 text-muted">
          {shown.length - (phone ? 1 : 3)} more waiting
        </li>
      ) : null}
    </ol>
  );
}
