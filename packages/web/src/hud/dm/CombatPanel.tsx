import type { CombatViewEntry } from "@gloam/shared/protocol";
import { X } from "lucide-react";
import { useState } from "react";
import {
  addToCombat,
  beginTurns,
  delayTurn,
  nextTurn,
  previousTurn,
  quickStartCombat,
  removeFromCombat,
  rollRemaining,
  setFreeMovement,
  setInitiative,
  stopCombat,
  useCombat,
} from "../../net/combat.ts";
import { useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Toggle } from "../../ui/controls.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { toast } from "../../ui/Toast.tsx";
import { keepHyphenated } from "../../ui/text.tsx";
import { StartCombatDialog } from "../combat/StartCombatDialog.tsx";

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

/**
 * DM panel → Combat (SPEC §8.12, §29 "Combat panel"; AC-CMB-01/06/11): no combat — Quick start (Ctrl/Cmd+Shift+C:
 * everyone on the scene not hidden, the campaign's default initiative) or Start combat…; a combat — its round and
 * turn controls, every combatant with its initiative to set, Delay (until after another) and Remove, the selected
 * creatures added, free movement, Stop.
 */
export function CombatPanel() {
  const view = useCombat((s) => s.view);
  const selection = useUi((s) => s.selection);
  const [starting, setStarting] = useState(false);
  if (!view.active)
    return (
      <div className="flex flex-col gap-3 p-4">
        <EmptyState
          art="die"
          title="No combat. Quick start puts everyone on the scene who isn't hidden into initiative with the campaign's method (Ctrl+Shift+C starts and stops it)."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => act(quickStartCombat(), "Couldn't start combat")}>
                Quick start
              </Button>
              <Button variant="secondary" onClick={() => setStarting(true)}>
                Start combat…
              </Button>
            </div>
          }
        />
        <StartCombatDialog open={starting} onClose={() => setStarting(false)} />
      </div>
    );
  const inFight = new Set(view.entries.map((e) => e.tokenId));
  const joining = selection.filter((id) => !inFight.has(id));
  const pending = view.entries.filter((e) => e.pending).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="combat-panel">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="caps text-12 text-fog">
          {view.begun ? `Round ${view.round}` : "Finding initiative"}
        </span>
        <span className="flex-1" />
        {view.begun ? (
          <>
            <Button size="S" variant="ghost" onClick={() => act(previousTurn(), "Couldn't go back")}>
              Previous
            </Button>
            <Button size="S" variant="secondary" onClick={() => act(nextTurn(), "Couldn't go on")}>
              Next turn
            </Button>
          </>
        ) : (
          <>
            {pending ? (
              <Button size="S" variant="ghost" onClick={() => act(rollRemaining(false), "Couldn't roll")}>
                Roll NPCs
              </Button>
            ) : null}
            {pending ? (
              <Button size="S" variant="ghost" onClick={() => act(rollRemaining(true), "Couldn't roll")}>
                Roll the rest
              </Button>
            ) : null}
            <Button size="S" variant="primary" onClick={() => act(beginTurns(), "Couldn't begin")}>
              Begin
            </Button>
          </>
        )}
      </div>
      <ol className="flex flex-col" aria-label="Combatants">
        {view.entries.map((e, i) => (
          <Row
            key={e.key}
            e={e}
            active={view.begun && i === view.activeIndex}
            others={view.entries.filter((o) => o.tokenId && o.tokenId !== e.tokenId)}
          />
        ))}
      </ol>
      {joining.length ? (
        <Button size="S" variant="secondary" onClick={() => act(addToCombat(joining), "Couldn't add them")}>
          {joining.length === 1 ? "Add the selected creature" : `Add the ${joining.length} selected`}
        </Button>
      ) : null}
      <Toggle
        checked={view.freeMovement}
        onChange={(on) => act(setFreeMovement(on), "Couldn't change that")}
        label="Free movement"
        description="Everyone moves whenever they like, with no budget."
      />
      <Button variant="danger" onClick={() => act(stopCombat(), "Couldn't stop")}>
        Stop combat
      </Button>
    </div>
  );
}

function Row({ e, active, others }: { e: CombatViewEntry; active: boolean; others: CombatViewEntry[] }) {
  const [draft, setDraft] = useState<string | null>(null);
  const tokenId = e.tokenId as string;
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() === "" || !Number.isInteger(n) || n === e.initiative) return;
    act(setInitiative(tokenId, n), "Couldn't set that");
  };
  return (
    <li
      className={`flex items-center gap-2 border-t border-line/60 py-1.5 ${active ? "text-brass-bright" : "text-bone"}`}
      data-testid="combat-row"
      data-token={tokenId}
      data-active={active ? "1" : "0"}
    >
      <input
        aria-label={`${e.name}'s initiative`}
        inputMode="numeric"
        value={draft ?? (e.initiative !== undefined ? String(e.initiative) : "")}
        placeholder="…"
        onChange={(ev) => setDraft(ev.target.value.replace(/[^\d-]/g, "").slice(0, 3))}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
        }}
        className="tabular h-8 w-12 shrink-0 rounded-[var(--radius-control)] border border-line bg-ink-900 text-center text-14 text-bone focus:border-brass focus:outline-none"
      />
      <span className="min-w-0 flex-1 truncate text-14">
        {keepHyphenated(e.name)}
        {e.surprised ? <span className="caps ml-1.5 text-12 text-fog">surprised</span> : null}
      </span>
      {others.length ? (
        <Menu
          label={`Delay ${e.name}`}
          text="Delay"
          items={others.map((o) => ({
            label: `Until after ${o.name}`,
            onSelect: () => act(delayTurn(tokenId, o.tokenId as string), "Couldn't delay"),
          }))}
        />
      ) : null}
      <IconButton
        label={`Remove ${e.name} from combat`}
        onClick={() => act(removeFromCombat(tokenId), "Couldn't remove")}
      >
        <X size={15} />
      </IconButton>
    </li>
  );
}
