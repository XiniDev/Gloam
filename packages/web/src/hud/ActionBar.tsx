import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefetchDice } from "../dice/throws.ts";
import { D20Icon } from "../icons/dice.tsx";
import { useCombat } from "../net/combat.ts";
import { useTable } from "../net/table.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { useUi } from "../state/ui.ts";
import { Tooltip } from "../ui/Tooltip.tsx";
import { type Density, type TurnAction, TurnControls } from "./combat/TurnControls.tsx";
import { ElevationControl } from "./ElevationControl.tsx";
import { insetMeasures, useCover, useHudInsets, useIsPhone, useMeasuredInset } from "./insets.ts";
import { TAB_BAR_H } from "./PhoneTabBar.tsx";
import { RangeToggle } from "./RangeToggle.tsx";

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
};

/**
 * The bottom action bar (SPEC §29.3): centred along the bottom of the board's clear area — the turn's controls in combat (pips, movement,
 * Dash, Stand up, Reset, End turn), the selected creature's height, and the dice. A tool with its own options bar
 * owns the bottom edge while it's picked; the tray still opens with D.
 */
export function ActionBar() {
  const tool = useUi((s) => s.tool);
  const tray = useUi((s) => s.diceTray);
  const me = useTable((s) => s.me);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyD" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || typing(e.target)) return;
      e.preventDefault();
      useUi.getState().set({ diceTray: !useUi.getState().diceTray });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The dice physics loads while the table is idle, so the first roll doesn't wait for it (§18.4).
  const seated = me !== null;
  useEffect(() => {
    if (seated) prefetchDice();
  }, [seated]);
  if (!me || (tool !== "select" && tool !== "pan" && tool !== "ping")) return null;
  return <Bar tray={tray} />;
}

/** The least room (px) beside the roll feed the bar takes before it spans the feed's column instead. */
const BESIDE_FEED = 200;

function Bar({ tray }: { tray: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  // Its band along the bottom is the HUD's: the camera frames above it.
  useMeasuredInset("bottom", ref, insetMeasures.bottom);
  useCover("actions", ref);
  // Centred in the board's clear width — between the toolbar and the dock or its open panel (§29.3), never over them
  // (critic P8 r2 B1) — and fitted to it: the turn controls step down (a menu for the rest, the portrait alone, two
  // rows) until the bar fits.
  const toolbarLeft = useHudInsets((s) => s.left);
  const hudRight = useHudInsets((s) => s.right);
  // …and right of the roll feed's column when there's room beside it (at 1024 with the dock open the dice button
  // hung under the feed — critic P11 r2 N9); only a bar too wide for that room spans the feed's column too.
  const feed = useHudInsets((s) => s.feed);
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setVw(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // (Centred as usual unless that would stand in the feed's column.)
  const barW = ref.current?.getBoundingClientRect().width ?? 0;
  const centred = (toolbarLeft + vw - hudRight) / 2;
  const inFeed = feed > toolbarLeft && centred - barW / 2 < feed + 8;
  const hudLeft =
    !phone && inFeed && vw - hudRight - feed >= Math.max(BESIDE_FEED, barW) ? feed : toolbarLeft;
  const [asking, setAsking] = useState<TurnAction | null>(null);
  const [density, setDensity] = useState<Density>(phone ? 3 : 0);
  // What sets the bar's natural width: the room, whose turn and what it shows, the selection (the height stepper).
  const view = useCombat((s) => s.view);
  const activeId = view.entries[view.activeIndex]?.tokenId ?? "";
  const t = useEntities((s) => (activeId ? boardData(s).tokens.get(activeId) : undefined));
  const selection = useUi((s) => s.selection.join());
  const sig = [
    phone,
    vw - hudLeft - hudRight,
    view.begun,
    activeId,
    t?.prone,
    t?.own?.stuck,
    t?.hp?.hp,
    t?.name,
    selection,
    asking,
  ].join("|");
  const fitted = useRef("");
  useLayoutEffect(() => {
    if (phone) {
      if (density !== 3) setDensity(3);
      return;
    }
    // Something changed: start from the fullest again.
    if (fitted.current !== sig) {
      fitted.current = sig;
      if (density !== 0) {
        setDensity(0);
        return;
      }
    }
    const el = ref.current;
    if (!el || density >= 3) return;
    const over = [el, ...el.querySelectorAll<HTMLElement>("[data-testid=turn-controls]")].some(
      (x) => x.scrollWidth > x.clientWidth + 1,
    );
    if (over) setDensity((density + 1) as Density);
  });
  // Narrow: the height stepper above, the dice and the range toggle in a column beside the turn controls.
  const stacked = phone || density >= 2;
  const controls = <TurnControls density={density} asking={asking} setAsking={setAsking} />;
  return (
    <div
      className="pointer-events-none absolute bottom-4 z-40 flex justify-center"
      // A phone's bar floats above its tab bar (§29.4), which holds the dice.
      style={
        phone
          ? { left: 12, right: 12, bottom: `calc(${TAB_BAR_H + 12}px + env(safe-area-inset-bottom))` }
          : { left: hudLeft, right: hudRight }
      }
    >
      <div
        ref={ref}
        data-testid="action-bar"
        data-density={density}
        className={
          stacked
            ? "flex min-w-0 max-w-full flex-col items-center gap-2"
            : "flex min-w-0 max-w-full items-center gap-2"
        }
      >
        {stacked ? (
          <>
            {/* The height stepper, when a creature that can take one is selected, on a row of its own above. */}
            <ElevationControl />
            <div className="flex min-w-0 max-w-full items-end gap-2">
              {controls}
              <div className="flex shrink-0 flex-col-reverse items-center gap-2">
                {phone ? null : <DiceButton open={tray} />}
                <RangeToggle />
              </div>
            </div>
          </>
        ) : (
          <>
            {controls}
            <div className="flex shrink-0 items-center gap-2">
              <RangeToggle />
              <ElevationControl />
              <DiceButton open={tray} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The dice button (SPEC §27.4: the one round button — circles are for portraits, pips and the dice), a d20 on it. */
function DiceButton({ open }: { open: boolean }) {
  return (
    <Tooltip label="Dice tray" shortcut="D">
      <button
        type="button"
        aria-label="Dice tray"
        aria-pressed={open || undefined}
        data-testid="dice-button"
        onClick={() => useUi.getState().set({ diceTray: !open })}
        className={`hit pointer-events-auto grid h-12 w-12 place-items-center rounded-full border shadow-[var(--shadow-float)] transition-[background-color,color,border-color,box-shadow] duration-[var(--dur-fast)] ${
          open
            ? "border-brass bg-ink-850 text-brass-bright shadow-[0_0_0_2px_var(--glow-brass),var(--shadow-float)]"
            : "border-brass-deep/70 bg-ink-850 text-brass hover:border-brass hover:text-brass-bright"
        }`}
      >
        <D20Icon size={24} />
      </button>
    </Tooltip>
  );
}
