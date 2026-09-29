import { PIP, type PipName, standUpCost } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import { useState } from "react";
import { dash, endTurn, resetMove, setPip, standUp, useCombat } from "../../net/combat.ts";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { toast } from "../../ui/Toast.tsx";
import { useIsPhone } from "../insets.ts";

const PIPS: { id: PipName; label: string; shape: string }[] = [
  { id: "action", label: "Action", shape: "rounded-full" },
  { id: "bonus", label: "Bonus action", shape: "[clip-path:polygon(50%_0,100%_100%,0_100%)]" },
  { id: "reaction", label: "Reaction", shape: "rotate-45 scale-[0.8] rounded-chip" },
  { id: "object", label: "Object interaction", shape: "rounded-chip" },
];

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

/**
 * The turn on the action bar (SPEC §8.12, §8.6; AC-CMB-08, AC-MOV-05/09/18): for the creature whose turn it is — the
 * player's own, or any for the DM — its action pips (Action ●, Bonus Action ▲, Reaction ◆, Object interaction ■; a
 * tracker, not a jail: using one already spent asks first), its movement ("20 / 30 ft", with the DM's bonus as
 * "30 + 10"), Dash, Stand up, Reset move and End turn. Out of its turn, a selected creature of yours shows its Reaction
 * (reactions happen on others' turns).
 */
export function TurnControls() {
  const view = useCombat((s) => s.view);
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const selection = useUi((s) => s.selection);
  const tokens = useEntities((s) => boardData(s).tokens);
  const phone = useIsPhone();
  const [asking, setAsking] = useState<"dash" | null>(null);
  if (!view.active || !view.begun) return null;
  const active = view.entries[view.activeIndex];
  const mine = active?.tokenId && (dm || active.mine) ? tokens.get(active.tokenId) : undefined;
  // Out of turn: the selected creature of yours in the fight — its Reaction.
  if (!mine) {
    const sel = selection.length === 1 ? tokens.get(selection[0] as string) : undefined;
    const inFight = sel && view.entries.some((e) => e.tokenId === sel.id && (dm || e.mine));
    if (!sel?.own || !inFight) return null;
    return (
      <div
        className="panel pointer-events-auto flex items-center gap-1.5 px-2 py-1.5"
        data-testid="turn-controls"
      >
        <Pip t={sel} pip={PIPS[2] as (typeof PIPS)[number]} />
      </div>
    );
  }
  const own = mine.own;
  if (!own) return null;
  const budget = own.budgetFt;
  const left = Math.max(0, budget - own.usedFt);
  const bonus = own.bonusMoveFt;
  const prone = mine.prone;
  const standCost = standUpCost(own.speedWalk);
  const actionUsed = (own.pips & PIP.action) !== 0;
  const doDash = () => {
    setAsking(null);
    act(dash(mine.id), "Couldn't dash");
  };
  const secondary = [
    ...(prone
      ? [
          {
            label: `Stand up (${standCost} ft)`,
            disabled: left < standCost,
            onSelect: () => act(standUp(mine.id), "Couldn't stand up"),
          },
        ]
      : []),
    { label: "Dash", onSelect: () => (actionUsed ? setAsking("dash") : doDash()) },
    {
      label: "Reset move",
      disabled: own.usedFt <= 0 && own.segments === 0,
      onSelect: () => act(resetMove(mine.id), "Couldn't reset the move"),
    },
  ];
  const pips = (
    <span className="flex items-center gap-1" role="group" aria-label="Action pips">
      {PIPS.map((p) => (
        <Pip key={p.id} t={mine} pip={p} />
      ))}
    </span>
  );
  const meter = (
    <span className="flex flex-col items-start leading-tight" data-testid="move-budget">
      <span className="tabular text-14 text-bone">
        {left} <span className="text-muted">/ {bonus > 0 ? `${budget - bonus} + ${bonus}` : budget} ft</span>
      </span>
      <span className="block h-1 w-20 overflow-hidden rounded-chip bg-ink-950" aria-hidden>
        <span
          className="block h-full bg-[var(--verdigris-400)]"
          style={{ width: `${budget > 0 ? (left / budget) * 100 : 0}%` }}
        />
      </span>
    </span>
  );
  const end = (
    <Button size="S" variant="primary" onClick={() => act(endTurn(mine.id), "Couldn't end the turn")}>
      End turn
    </Button>
  );
  return (
    <div
      className={`panel pointer-events-auto relative px-2.5 py-1.5 ${phone ? "flex flex-col gap-1" : "flex items-center gap-2"}`}
      data-testid="turn-controls"
      data-token={mine.id}
    >
      {phone ? (
        // A phone: two rows — what's left and End turn; the pips (touch-sized) and the rest in a menu.
        <>
          <span className="flex items-center justify-between gap-3">
            {meter}
            {end}
          </span>
          <span className="flex items-center justify-between gap-2">
            {pips}
            <Menu label="Turn actions" items={secondary} up />
          </span>
        </>
      ) : (
        <>
          {pips}
          {meter}
          {secondary.map((s) => (
            <Button key={s.label} size="S" variant="ghost" disabled={s.disabled} onClick={s.onSelect}>
              {s.label}
            </Button>
          ))}
          {end}
        </>
      )}
      {asking === "dash" ? (
        <div
          role="alertdialog"
          aria-label="Action already used"
          className="panel absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap px-3 py-2 text-13 text-bone"
        >
          Action already used — Dash anyway?
          <Button size="S" variant="primary" onClick={doDash}>
            Dash
          </Button>
          <Button size="S" variant="ghost" onClick={() => setAsking(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Pip({ t, pip }: { t: TokenView; pip: (typeof PIPS)[number] }) {
  const used = ((t.own?.pips ?? 0) & PIP[pip.id]) !== 0;
  return (
    <button
      type="button"
      aria-pressed={used}
      aria-label={`${pip.label}${used ? " (used)" : ""}`}
      title={`${pip.label}${used ? " — used" : ""}`}
      data-pip={pip.id}
      onClick={() => act(setPip(t.id, pip.id, !used), "Couldn't mark that")}
      className="hit grid h-7 w-7 place-items-center"
    >
      <span
        className={`block h-3.5 w-3.5 ${pip.shape} ${
          used ? "bg-transparent shadow-[inset_0_0_0_1.5px_var(--fog-400)]" : "bg-[var(--brass-400)]"
        }`}
        aria-hidden
      />
    </button>
  );
}
