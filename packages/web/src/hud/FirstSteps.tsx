import { X } from "lucide-react";
import { useRef } from "react";
import { useDiceStage } from "../dice/state.ts";
import { useSheets } from "../net/sheets.ts";
import { useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { useCover, useIsPhone, useObstacle } from "./insets.ts";

/**
 * A player at the table with nothing to play yet — no character (known once the first sheets snapshot has come) and no
 * token of their own on the board (a DM may hand them one without a sheet) — who hasn't put the hint away.
 */
export function useNeedsCharacter(): boolean {
  const role = useTable((s) => s.me?.role);
  const me = useTable((s) => s.me?.userId);
  const hasScene = useBoard((d) => d.scene !== null);
  const ownsToken = useBoard((d) =>
    me ? [...d.tokens.values()].some((t) => t.ownerIds.includes(me)) : false,
  );
  const none = useSheets(
    (s) => s.loaded && ![...s.actors.values()].some((a) => a.ownerUserId === me && a.kind === "character"),
  );
  const dismissed = useUi((s) => s.firstStepsDismissed);
  return role === "player" && hasScene && none && !ownsToken && !dismissed;
}

/**
 * The first thing a new player does, said plainly (AC-DEMO-03): a callout at the rail's Sheet button — it points at
 * what to press — until they have a character: beside it on a desktop, below it on a phone (whose rail is a row in
 * the corner). Never over the board's middle or the roll feed; HUD the dice and plates keep clear of — and while dice
 * are on the board it steps aside (they need a phone's room; it comes back when they've gone), as it does for the
 * emote wheel.
 */
export function FirstSteps() {
  const ref = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  // (Aside, too, while the emote wheel is open: it opens where the player is, and the callout isn't what they're doing.)
  const dice = useDiceStage((s) => s.on);
  const wheel = useUi((s) => s.emoteWheel !== null);
  // A board tool picked (measuring, pinging…): they're doing something else on the board — the hint steps aside.
  const busy = useUi((s) => s.tool !== "select");
  const away = dice || wheel || busy;
  useCover("first-steps", ref, !away);
  useObstacle("first-steps", ref, !away);
  if (away) return null;
  return (
    <div
      ref={ref}
      // A phone: above the tab bar's Sheet tab, from the screen's left gutter (the tab is the second of five).
      className={`panel pointer-events-auto flex select-none flex-col gap-2 px-3.5 py-3 ${
        phone
          ? "fixed left-3 bottom-[calc(78px+env(safe-area-inset-bottom))] w-[min(300px,calc(100vw-24px))]"
          : "absolute right-[calc(100%+12px)] top-1/2 w-[280px] -translate-y-1/2"
      }`}
      data-testid="first-steps"
      role="note"
    >
      {/* The arrow, towards the Sheet button. */}
      <span
        className={`absolute h-3 w-3 rotate-45 bg-[var(--panel)] ${
          phone
            ? "-bottom-[7px] border-b border-r border-[var(--border)]"
            : "-right-[7px] top-1/2 -translate-y-1/2 border-r border-t border-[var(--border)]"
        }`}
        // (Over the Sheet tab's middle: 30 % of the screen's width, less the callout's gutter and half the arrow.)
        style={phone ? { left: Math.round(window.innerWidth * 0.3) - 12 - 6 } : undefined}
        aria-hidden
      />
      <span className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-14 font-bold text-bone">Make your character</p>
        {/* Put away (for this visit): it never stands between a player and the board. */}
        <IconButton
          label="Not now"
          className="-mr-2 -mt-2"
          onClick={() => useUi.getState().set({ firstStepsDismissed: true })}
        >
          <X size={15} />
        </IconButton>
      </span>
      <p className="text-13 text-muted">A name, a class, HP, AC and speed — the sheet you'll play from.</p>
      <Button
        variant="primary"
        size="S"
        className="self-start"
        onClick={() => useUi.getState().set({ dock: "sheet" })}
      >
        Make my character
      </Button>
    </div>
  );
}
