import type { CombatViewEntry } from "@gloam/shared/protocol";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type DragEvent, useLayoutEffect, useRef, useState } from "react";
import { ringColorOf } from "../../board/colors.ts";
import { BeginIcon, FreeMoveIcon, StopCombatIcon } from "../../icons/combat.tsx";
import { D20Icon } from "../../icons/dice.tsx";
import {
  beginTurns,
  nextTurn,
  previousTurn,
  reorderCombat,
  rollRemaining,
  setFreeMovement,
  stopCombat,
  useCombat,
} from "../../net/combat.ts";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { Portrait } from "../../ui/Portrait.tsx";
import { toast } from "../../ui/Toast.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";
import { HandBadge } from "../HandBadge.tsx";
import { insetMeasures, useCover, useHudInsets, useIsPhone, useMeasuredInset } from "../insets.ts";
import { useAssetImage } from "../useAssetImage.ts";

/** Widths the strip is laid out with (px): a portrait's column, the active one's, their gap, the round divider, "+n". */
const W = { entry: 40, active: 52, gap: 6, wrap: 34, more: 40 } as const;
/** A phone's compact strip (§29.4: 48 px tall): the same, smaller. */
const PHONE = { entry: 34, active: 36, gap: 6, wrap: 28, more: 34 } as const;
type Widths = typeof W | typeof PHONE;

/**
 * The turn tracker (SPEC §8.12, §29.4; AC-CMB-04): a strip of portraits at the top centre, from the creature whose turn
 * it is — larger, in a brass frame — round the order to the next round (a divider marks the wrap, with its number);
 * each ringed in its player's or its disposition's colour, with its initiative (a "…" while it's being found) and a
 * small HP bar as its display mode allows; an "Unknown" silhouette in the places of those a player doesn't perceive,
 * when the DM reveals the count. As many as fit whole, then "+n" (never a portrait cut through); a phone's is the
 * compact 48-px strip. The DM has the controls beside it — Roll NPCs and Begin while initiative is found, then
 * Previous / Next, free movement and, set apart, Stop — and the portraits drag to reorder.
 */
export function TurnTracker() {
  const view = useCombat((s) => s.view);
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const phone = useIsPhone();
  const top = useHudInsets((s) => s.top);
  const banner = useHudInsets((s) => s.banner);
  const left = useHudInsets((s) => s.left);
  const right = useHudInsets((s) => s.right);
  const ref = useRef<HTMLDivElement>(null);
  const fixedRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  // A phone's open panel takes the screen: the tracker steps back (the DM's Combat panel shows the same, and a
  // player's panel is what they opened) instead of lying over the panel's header.
  const dockOpen = useUi((s) => s.dock !== null);
  const shown = view.active && !(phone && dockOpen);
  useMeasuredInset("tracker", ref, insetMeasures.tracker, shown);
  // The strip's panel, not the full-width row it's centred in: HUD beside it (the toasts, the emote feed) stands
  // beside it, not under the row's empty ends (critic P11 r1: the toasts dropped below a tracker 10 px clear of them).
  const panelRef = useRef<HTMLDivElement>(null);
  useCover("tracker", panelRef, shown);
  const [dragging, setDragging] = useState<string | null>(null);
  // Room for the portraits: the strip's width less the round label and the controls (critic P8 r2: without the
  // label, "+n" ran under the Previous button).
  const [room, setRoom] = useState(10_000);
  useLayoutEffect(() => {
    const outer = ref.current;
    const fixed = fixedRef.current;
    const label = labelRef.current;
    if (!outer || !fixed || !label || !shown) return;
    const measure = () => {
      const avail = outer.getBoundingClientRect().width;
      // The panel's padding (10 px a side; a phone's 8), the list's (4 px a side), the gaps between the three parts
      // (8 px; a phone's 6).
      const chrome = phone ? 16 + 8 + 12 : 20 + 8 + 16;
      const r = Math.floor(
        avail - fixed.getBoundingClientRect().width - label.getBoundingClientRect().width - chrome,
      );
      setRoom((x) => (x === r ? x : r));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(fixed);
    ro.observe(label);
    return () => ro.disconnect();
  }, [shown, phone]);
  if (!shown) return null;
  const n = view.entries.length;
  const start = view.activeIndex >= 0 ? view.activeIndex : 0;
  // From the active one round the order: those after the wrap belong to the next round.
  const order = Array.from({ length: n }, (_, i) => {
    const j = (start + i) % n;
    return { e: view.entries[j] as CombatViewEntry, index: j, next: view.begun && j < start };
  });
  // As many whole portraits as the strip has room for beside the round and the controls — a phone's too (critic P11
  // r1 B4: a fixed three ran under the DM's Begin button on a narrow phone).
  const visible = fit(order, room, view.begun, phone ? PHONE : W);
  const hidden = order.length - visible.length;
  const wrapAt = visible.findIndex((x) => x.next);
  const drop = (target: string) => {
    if (!dragging || dragging === target) return;
    const ids = view.entries.map((e) => e.tokenId).filter((x): x is string => Boolean(x));
    const from = ids.indexOf(dragging);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void reorderCombat(ids).catch((e: Error) => toast.danger("Couldn't reorder", e.message));
  };
  const act = (p: Promise<unknown>, what: string) =>
    void p.catch((e: Error) => toast.danger(what, e.message));
  const roundLabel = (
    <span
      ref={labelRef}
      className="caps flex shrink-0 flex-col items-center leading-tight text-12 text-fog pointer-coarse:text-13"
    >
      {view.begun ? (
        <>
          Round
          <span
            className={`display tabular leading-none text-bone ${phone ? "text-16" : "text-18"}`}
            data-testid="combat-round"
          >
            {view.round}
          </span>
        </>
      ) : (
        <span className="text-bone">Initiative</span>
      )}
    </span>
  );
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-30 flex justify-center"
      style={phone ? { top: top + banner + 8, left: 12, right: 12 } : { top: top + banner + 8, left, right }}
      data-testid="turn-tracker"
    >
      <div
        ref={panelRef}
        className={`panel pointer-events-auto flex max-w-full items-center ${phone ? "h-12 gap-1.5 px-2" : "gap-2 px-2.5 py-1.5"}`}
      >
        {roundLabel}
        <ol className="flex min-w-0 items-end gap-1.5 px-1 pb-0.5" aria-label="Turn order">
          {visible.map(({ e, index }, i) => (
            <li key={e.key} className="flex items-end gap-1.5">
              {i === wrapAt && i > 0 ? (
                <span
                  className={`flex flex-col items-center justify-center self-center border-l border-brass/50 pl-1.5 text-12 text-fog pointer-coarse:text-13 ${phone ? "h-9" : "h-12"}`}
                >
                  <span className="caps" aria-hidden>
                    R{view.round + 1}
                  </span>
                  <span className="sr-only">Round {view.round + 1} begins</span>
                </span>
              ) : null}
              <Entry
                e={e}
                active={view.begun && index === view.activeIndex}
                compact={phone}
                turnKey={`${view.round}:${view.activeIndex}`}
                draggable={dm && Boolean(e.tokenId)}
                onDragStart={() => setDragging(e.tokenId ?? null)}
                onDrop={() => {
                  if (e.tokenId) drop(e.tokenId);
                }}
              />
            </li>
          ))}
          {hidden > 0 ? (
            // The rest of the order as a portrait-sized ink disc (critic P8 r2 N6), named on hover.
            <li
              className={`flex flex-col items-center ${phone ? "gap-px" : "gap-0.5"}`}
              data-testid="tracker-more"
              title={order
                .slice(visible.length)
                .map((x) => x.e.name)
                .join(", ")}
            >
              <span
                className="tabular grid place-items-center rounded-full bg-ink-950 font-ui text-13 font-bold text-bone shadow-[inset_0_0_0_1px_var(--border-strong)]"
                style={{ width: phone ? PHONE.entry : W.entry, height: phone ? PHONE.entry : W.entry }}
              >
                +{hidden}
              </span>
              {/* Rows as tall as a portrait's initiative and bar below it: the discs line up with the portraits. */}
              {phone ? (
                <>
                  <span className="h-1" aria-hidden />
                  <span className="block h-0.5" aria-hidden />
                </>
              ) : (
                <>
                  <span className="invisible font-ui text-14 font-bold leading-none" aria-hidden>
                    0
                  </span>
                  <span className="block h-1" aria-hidden />
                </>
              )}
              <span className="sr-only">
                {hidden} more:{" "}
                {order
                  .slice(visible.length)
                  .map((x) => x.e.name)
                  .join(", ")}
              </span>
            </li>
          ) : null}
        </ol>
        <div ref={fixedRef} className="flex shrink-0 items-center">
          {dm && phone ? (
            // A phone keeps the row for the portraits: the next step itself, the rest in a menu.
            <div className="flex items-center gap-0.5 border-l border-line pl-1">
              {view.begun ? (
                <IconButton label="Next turn (N)" onClick={() => act(nextTurn(), "Couldn't go on")}>
                  <ChevronRight size={18} />
                </IconButton>
              ) : (
                // The main step while initiative is found: a labelled brass button, even here (touch has no
                // tooltips; critic P8 r2 I6).
                <Button
                  size="S"
                  variant="primary"
                  className="px-2.5"
                  icon={<BeginIcon size={15} />}
                  onClick={() => act(beginTurns(), "Couldn't begin")}
                >
                  Begin
                </Button>
              )}
              <Menu
                label="Combat controls"
                up={false}
                items={[
                  ...(view.begun
                    ? [
                        { label: "Previous turn", onSelect: () => act(previousTurn(), "Couldn't go back") },
                        {
                          label: view.freeMovement ? "Back to turn order" : "Free movement for everyone",
                          onSelect: () => act(setFreeMovement(!view.freeMovement), "Couldn't change that"),
                        },
                      ]
                    : view.entries.some((e) => e.pending)
                      ? [{ label: "Roll NPCs", onSelect: () => act(rollRemaining(false), "Couldn't roll") }]
                      : []),
                  { label: "Stop combat", danger: true, onSelect: () => act(stopCombat(), "Couldn't stop") },
                ]}
              />
            </div>
          ) : null}
          {dm && !phone ? (
            <div className="flex items-center gap-0.5 border-l border-line pl-1.5">
              {view.begun ? (
                <>
                  <IconButton
                    label="Previous turn (P)"
                    onClick={() => act(previousTurn(), "Couldn't go back")}
                  >
                    <ChevronLeft size={18} />
                  </IconButton>
                  <IconButton label="Next turn (N)" onClick={() => act(nextTurn(), "Couldn't go on")}>
                    <ChevronRight size={18} />
                  </IconButton>
                  <IconButton
                    label={view.freeMovement ? "Back to turn order" : "Free movement for everyone"}
                    aria-pressed={view.freeMovement}
                    onClick={() => act(setFreeMovement(!view.freeMovement), "Couldn't change that")}
                  >
                    <FreeMoveIcon size={18} className={view.freeMovement ? "text-brass" : ""} />
                  </IconButton>
                </>
              ) : (
                <>
                  {view.entries.some((e) => e.pending) ? (
                    <Button
                      size="S"
                      variant="ghost"
                      icon={<D20Icon size={15} />}
                      onClick={() => act(rollRemaining(false), "Couldn't roll")}
                    >
                      Roll NPCs
                    </Button>
                  ) : null}
                  <Button
                    size="S"
                    variant="primary"
                    icon={<BeginIcon size={15} />}
                    onClick={() => act(beginTurns(), "Couldn't begin")}
                  >
                    Begin
                  </Button>
                </>
              )}
              {/* Set apart, in the danger colour and named: one click ends the fight (AC-CMB-11), so it never reads
                  as a close button (critic P8 r2 I5). */}
              <span className="ml-1 flex items-center border-l border-line pl-1">
                <Tooltip label="Stop combat" shortcut="Ctrl+Shift+C">
                  <Button
                    size="S"
                    variant="ghost"
                    aria-label="Stop combat"
                    className="px-2 text-danger-text hover:text-danger-text"
                    icon={<StopCombatIcon size={17} />}
                    onClick={() => act(stopCombat(), "Couldn't stop")}
                  >
                    Stop
                  </Button>
                </Tooltip>
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The entries that fit whole in `room` px, from the active one round the order (the rest become "+n"). */
function fit<T extends { next: boolean }>(order: T[], room: number, begun: boolean, size: Widths): T[] {
  let used = 0;
  const out: T[] = [];
  for (const [i, x] of order.entries()) {
    const w =
      (i === 0 && begun ? size.active : size.entry) +
      (i ? size.gap : 0) +
      (x.next && !order[i - 1]?.next && i > 0 ? size.wrap + size.gap : 0);
    const reserve = i < order.length - 1 ? size.more + size.gap : 0;
    if (used + w + reserve > room && out.length > 0) break;
    used += w;
    out.push(x);
  }
  return out;
}

function Entry({
  e,
  active,
  compact,
  turnKey,
  draggable,
  onDragStart,
  onDrop,
}: {
  e: CombatViewEntry;
  active: boolean;
  /** A phone's strip: smaller portraits, the initiative on a badge at the foot of each. */
  compact: boolean;
  /** Which turn it is (round and place): the turn-start moment plays again when it changes. */
  turnKey: string;
  draggable: boolean;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const src = useAssetImage(e.portraitAssetId, 96);
  const colorBlind = useSettings((s) => s.colorBlind);
  // Its player's colour or its disposition's (§28 Portrait), as on its base on the board.
  const token = useEntities((s) => (e.tokenId ? boardData(s).tokens.get(e.tokenId) : undefined));
  const ring = token ? ringColorOf(token, colorBlind) : "var(--line)";
  // Its player's hand up (SPEC §8.18: on the portrait and in the tracker).
  const handUp = useTable((t) =>
    token ? t.presence.some((p) => p.handRaised && token.ownerIds.includes(p.userId)) : false,
  );
  const size = compact ? (active ? PHONE.active : PHONE.entry) : active ? W.active : W.entry;
  // A click selects the creature (the camera and its menu are a click away on the board).
  const select = () => {
    if (e.tokenId) useUi.getState().set({ selection: [e.tokenId] });
  };
  const hp = e.hpFrac;
  const init = e.unknown ? "" : e.initiative !== undefined ? String(e.initiative) : "…";
  const bar =
    hp !== undefined ? (
      <span
        className={`block overflow-hidden rounded-chip bg-ink-950 ${compact ? "h-0.5 w-7" : "h-1 w-8"}`}
        aria-hidden
      >
        <span
          className="block h-full"
          style={{
            width: `${Math.max(0, Math.min(1, hp)) * 100}%`,
            background: hp > 0.5 ? "var(--hp-high)" : hp > 0.25 ? "var(--hp-mid)" : "var(--hp-low)",
          }}
        />
      </span>
    ) : (
      <span className={compact ? "block h-0.5" : "block h-1"} aria-hidden />
    );
  return (
    <div
      className={`flex flex-col items-center ${compact ? "gap-px" : "gap-0.5"}`}
      data-testid="tracker-entry"
      data-token={e.tokenId ?? ""}
      data-active={active ? "1" : "0"}
      data-unknown={e.unknown ? "1" : "0"}
      draggable={draggable}
      onDragStart={(ev: DragEvent) => {
        ev.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(ev) => draggable && ev.preventDefault()}
      onDrop={(ev) => {
        ev.preventDefault();
        onDrop();
      }}
    >
      <button
        type="button"
        onClick={select}
        aria-label={`${e.name}${active ? " — their turn" : ""}${e.initiative !== undefined ? `, initiative ${e.initiative}` : ""}`}
        aria-current={active ? "true" : undefined}
        className={`hit relative grid place-items-center rounded-full ${active ? "shadow-[0_0_0_2px_var(--brass-400),0_0_14px_var(--glow-brass)]" : ""}`}
        style={{ width: size, height: size }}
      >
        {/* The turn starting (§27.7): the portrait swells, a brass ring sweeps once round it (keyed to the turn). */}
        <span
          key={active ? turnKey : "idle"}
          className={`grid h-full w-full place-items-center ${active ? "animate-[turn-swell_var(--dur-scene)_var(--ease-out)]" : ""}`}
        >
          {e.unknown ? (
            <span
              className="grid h-full w-full place-items-center rounded-full bg-ink-950 text-18 text-faint shadow-[inset_0_0_0_1px_var(--line)]"
              aria-hidden
            >
              ?
            </span>
          ) : (
            <Portrait name={e.name} color={active ? "var(--brass-400)" : ring} size={size} src={src} />
          )}
        </span>
        {handUp ? <HandBadge size={18} className="absolute -right-1.5 -top-1.5" /> : null}
        {active ? (
          <svg
            // (Its own key: sharing the swell's with a sibling, React left stale portraits behind as turns passed.)
            key={`ring:${turnKey}`}
            viewBox="0 0 60 60"
            className={`pointer-events-none absolute ${compact ? "-inset-1" : "-inset-1.5"}`}
            aria-hidden
            data-testid="turn-ring"
          >
            <circle
              cx="30"
              cy="30"
              r="28"
              fill="none"
              stroke="var(--brass-300)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="176"
              strokeDashoffset="176"
              transform="rotate(-90 30 30)"
              className="animate-[ring-sweep_var(--dur-cinematic)_var(--ease-out)_forwards]"
            />
          </svg>
        ) : null}
        {compact && init ? (
          // The initiative on a badge at the portrait's foot (the compact strip has no row for it).
          <span className="tabular absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded-chip bg-ink-950 px-1 text-13 leading-tight text-bone shadow-[0_0_0_1px_var(--line)]">
            {init}
          </span>
        ) : null}
      </button>
      {compact ? null : (
        // Its initiative, the tracker's main number: as legible as the monogram (critic P8 r2 N7).
        <span className="tabular font-ui text-14 font-bold leading-none text-bone">{init}</span>
      )}
      {compact ? <span className="h-1" aria-hidden /> : null}
      {bar}
    </div>
  );
}
