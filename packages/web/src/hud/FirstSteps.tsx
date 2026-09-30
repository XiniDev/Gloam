import { useRef } from "react";
import { useDiceStage } from "../dice/state.ts";
import { useSheets } from "../net/sheets.ts";
import { useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { useCover, useIsPhone, useObstacle } from "./insets.ts";

/** A player at the table without a character yet (known once the first sheets snapshot has come). */
export function useNeedsCharacter(): boolean {
  const role = useTable((s) => s.me?.role);
  const me = useTable((s) => s.me?.userId);
  const hasScene = useBoard((d) => d.scene !== null);
  const none = useSheets(
    (s) => s.loaded && ![...s.actors.values()].some((a) => a.ownerUserId === me && a.kind === "character"),
  );
  return role === "player" && hasScene && none;
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
  const away = dice || wheel;
  useCover("first-steps", ref, !away);
  useObstacle("first-steps", ref, !away);
  if (away) return null;
  return (
    <div
      ref={ref}
      className={`panel pointer-events-auto absolute flex flex-col gap-2 px-3.5 py-3 ${
        phone
          ? "right-0 top-[calc(100%+14px)] w-[min(300px,calc(100vw-24px))]"
          : "right-[calc(100%+12px)] top-1/2 w-[280px] -translate-y-1/2"
      }`}
      data-testid="first-steps"
      role="note"
    >
      {/* The arrow, towards the Sheet button. */}
      <span
        className={`absolute h-3 w-3 rotate-45 bg-[var(--panel)] ${
          phone
            ? "-top-[7px] right-4 border-l border-t border-[var(--border)]"
            : "-right-[7px] top-1/2 -translate-y-1/2 border-r border-t border-[var(--border)]"
        }`}
        aria-hidden
      />
      <p className="text-14 font-bold text-bone">Make your character</p>
      <p className="text-13 text-muted">A name, a class, HP, AC and speed — and its token joins the board.</p>
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
