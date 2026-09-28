import type { RequestCard } from "@gloam/shared/protocol";
import { SkipForward, X } from "lucide-react";
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

function Card({ c, onDismiss }: { c: RequestCard; onDismiss: () => void }) {
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

/** Cards stepped aside (answered, or dismissed), shared by the floating stack and a phone's in-panel one. */
const useDismissed = create<{ keys: Set<string>; add(k: string): void }>((set) => ({
  keys: new Set(),
  add: (k) => set((s) => ({ keys: new Set(s.keys).add(k) })),
}));

/**
 * Roll-request cards (SPEC §8.9 Roll requests, AC-DICE-06): each creature the DM asks that this person controls gets a
 * card — the label, its formula from the sheet, the DC when shown — with Roll, Enter physical roll and Skip. Centred
 * over the free board under the top bar, between the toolbar and the dock (never over a panel); on a phone with a
 * panel open, at the top of the panel itself (`inline`). One on a phone, three on a larger screen, then "Show n
 * more".
 */
export function RequestCards({ inline = false }: { inline?: boolean }) {
  const cards = useSheets((s) => s.cards);
  const dismissed = useDismissed((s) => s.keys);
  const [all, setAll] = useState(false);
  const shown = useMemo(
    () => [...cards.values()].filter((c) => c.open && !dismissed.has(`${c.requestId}|${c.targetId}`)),
    [cards, dismissed],
  );
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
      {shown.slice(0, max).map((c) => {
        const key = `${c.requestId}|${c.targetId}`;
        return <Card key={key} c={c} onDismiss={() => useDismissed.getState().add(key)} />;
      })}
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
