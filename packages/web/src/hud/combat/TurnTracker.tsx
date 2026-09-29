import type { CombatViewEntry } from "@gloam/shared/protocol";
import { ChevronLeft, ChevronRight, Dices, Footprints, Play, Square } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
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
import { useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { Portrait } from "../../ui/Portrait.tsx";
import { toast } from "../../ui/Toast.tsx";
import { insetMeasures, useCover, useHudInsets, useIsPhone, useMeasuredInset } from "../insets.ts";
import { useAssetImage } from "../useAssetImage.ts";

/**
 * The turn tracker (SPEC §8.12; AC-CMB-04): a strip of portraits at the top centre, from the creature whose turn it
 * is — larger, in a gold frame — round the order to the next round (a divider marks the wrap, with its number); each
 * with its initiative (a "…" while it's being found) and a small HP bar as its display mode allows; an "Unknown"
 * silhouette in the places of those a player doesn't perceive, when the DM reveals the count. A phone shows the
 * current creature and the next two. The DM has the controls beside it — Roll NPCs and Begin while initiative is
 * found, then Previous / Next, free movement and Stop — a menu on each portrait (initiative, delay, remove), and the
 * portraits drag to reorder.
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
  // A phone's open panel takes the screen: the tracker steps back (the DM's Combat panel shows the same, and a
  // player's panel is what they opened) instead of lying over the panel's header.
  const dockOpen = useUi((s) => s.dock !== null);
  const shown = view.active && !(phone && dockOpen);
  useMeasuredInset("tracker", ref, insetMeasures.tracker, shown);
  useCover("tracker", ref, shown);
  const [dragging, setDragging] = useState<string | null>(null);
  if (!shown) return null;
  const n = view.entries.length;
  const start = view.activeIndex >= 0 ? view.activeIndex : 0;
  // From the active one round the order: those after the wrap belong to the next round.
  const order = Array.from({ length: n }, (_, i) => {
    const j = (start + i) % n;
    return { e: view.entries[j] as CombatViewEntry, index: j, next: view.begun && j < start };
  });
  const visible = phone ? order.slice(0, 3) : order;
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
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-30 flex justify-center"
      style={phone ? { top: top + banner + 8, left: 12, right: 12 } : { top: top + banner + 8, left, right }}
      data-testid="turn-tracker"
    >
      <div className="panel pointer-events-auto flex max-w-full items-center gap-2 px-2.5 py-1.5">
        <span className="caps flex shrink-0 flex-col items-center leading-tight text-12 text-fog">
          {view.begun ? (
            <>
              Round
              <span className="display tabular text-18 leading-none text-bone" data-testid="combat-round">
                {view.round}
              </span>
            </>
          ) : (
            <span className="text-bone">Initiative</span>
          )}
        </span>
        <ol
          className="flex min-w-0 items-end gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]"
          aria-label="Turn order"
        >
          {visible.map(({ e, index }, i) => (
            <li key={e.key} className="flex items-end gap-1.5">
              {i === wrapAt && i > 0 ? (
                <span className="flex h-12 flex-col items-center justify-center self-center border-l border-brass/50 pl-1.5 text-12 text-fog">
                  <span className="caps" aria-hidden>
                    R{view.round + 1}
                  </span>
                  <span className="sr-only">Round {view.round + 1} begins</span>
                </span>
              ) : null}
              <Entry
                e={e}
                active={view.begun && index === view.activeIndex}
                turnKey={`${view.round}:${view.activeIndex}`}
                draggable={dm && Boolean(e.tokenId)}
                onDragStart={() => setDragging(e.tokenId ?? null)}
                onDrop={() => {
                  if (e.tokenId) drop(e.tokenId);
                }}
              />
            </li>
          ))}
          {phone && order.length > 3 ? (
            <li className="self-center text-12 text-fog">+{order.length - 3}</li>
          ) : null}
        </ol>
        {dm && phone ? (
          // A phone keeps the row for the portraits: the next step itself, the rest in a menu.
          <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1">
            {view.begun ? (
              <IconButton label="Next turn (N)" onClick={() => act(nextTurn(), "Couldn't go on")}>
                <ChevronRight size={18} />
              </IconButton>
            ) : (
              <IconButton label="Begin" onClick={() => act(beginTurns(), "Couldn't begin")}>
                <Play size={16} />
              </IconButton>
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
                { label: "Stop combat", onSelect: () => act(stopCombat(), "Couldn't stop") },
              ]}
            />
          </div>
        ) : null}
        {dm && !phone ? (
          <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1.5">
            {view.begun ? (
              <>
                <IconButton label="Previous turn (P)" onClick={() => act(previousTurn(), "Couldn't go back")}>
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
                  <Footprints size={17} className={view.freeMovement ? "text-brass" : ""} />
                </IconButton>
              </>
            ) : (
              <>
                {view.entries.some((e) => e.pending) ? (
                  <Button
                    size="S"
                    variant="ghost"
                    icon={<Dices size={14} />}
                    onClick={() => act(rollRemaining(false), "Couldn't roll")}
                  >
                    Roll NPCs
                  </Button>
                ) : null}
                <Button
                  size="S"
                  variant="primary"
                  icon={<Play size={14} />}
                  onClick={() => act(beginTurns(), "Couldn't begin")}
                >
                  Begin
                </Button>
              </>
            )}
            <IconButton label="Stop combat" onClick={() => act(stopCombat(), "Couldn't stop")}>
              <Square size={15} />
            </IconButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Entry({
  e,
  active,
  turnKey,
  draggable,
  onDragStart,
  onDrop,
}: {
  e: CombatViewEntry;
  active: boolean;
  /** Which turn it is (round and place): the turn-start moment plays again when it changes. */
  turnKey: string;
  draggable: boolean;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const src = useAssetImage(e.portraitAssetId, 96);
  const size = active ? 52 : 40;
  // A click selects the creature (the camera and its menu are a click away on the board).
  const select = () => {
    if (e.tokenId) useUi.getState().set({ selection: [e.tokenId] });
  };
  const hp = e.hpFrac;
  return (
    <div
      className="flex flex-col items-center gap-0.5"
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
        className={`relative grid place-items-center rounded-full ${active ? "shadow-[0_0_0_2px_var(--brass-400),0_0_14px_var(--glow-brass)]" : ""}`}
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
            <Portrait
              name={e.name}
              color={active ? "var(--brass-400)" : "var(--line)"}
              size={size}
              src={src}
            />
          )}
        </span>
        {active ? (
          <svg
            // (Its own key: sharing the swell's with a sibling, React left stale portraits behind as turns passed.)
            key={`ring:${turnKey}`}
            viewBox="0 0 60 60"
            className="pointer-events-none absolute -inset-1.5"
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
      </button>
      <span className="tabular text-12 leading-none text-bone">
        {e.unknown ? "" : e.initiative !== undefined ? e.initiative : "…"}
      </span>
      {hp !== undefined ? (
        <span className="block h-1 w-8 overflow-hidden rounded-chip bg-ink-950" aria-hidden>
          <span
            className={`block h-full ${hp > 0.5 ? "bg-[var(--verdigris-400)]" : hp > 0.25 ? "bg-[var(--brass-400)]" : "bg-[var(--ember-400)]"}`}
            style={{ width: `${Math.max(0, Math.min(1, hp)) * 100}%` }}
          />
        </span>
      ) : (
        <span className="block h-1" aria-hidden />
      )}
    </div>
  );
}
