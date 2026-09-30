import { PIP, type PipName, standUpCost, stuckName } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import { ringColorOf } from "../../board/colors.ts";
import { HeldIcon } from "../../icons/combat.tsx";
import { StatusIcon } from "../../icons/status.tsx";
import { dash, disengage, dodge, endTurn, resetMove, setPip, standUp, useCombat } from "../../net/combat.ts";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Menu } from "../../ui/Menu.tsx";
import { Portrait } from "../../ui/Portrait.tsx";
import { toast } from "../../ui/Toast.tsx";
import { keepHyphenated } from "../../ui/text.tsx";
import { useAssetImage } from "../useAssetImage.ts";

const PIPS: { id: PipName; label: string; shape: string }[] = [
  { id: "action", label: "Action", shape: "rounded-full" },
  { id: "bonus", label: "Bonus action", shape: "[clip-path:polygon(50%_0,100%_100%,0_100%)]" },
  { id: "reaction", label: "Reaction", shape: "rotate-45 scale-[0.8] rounded-chip" },
  { id: "object", label: "Object interaction", shape: "rounded-chip" },
];

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

/**
 * How much the turn controls show (the action bar fits them to the board's clear width, critic P8 r2 B1): 0 every
 * button; 1 Dash and Reset move in a menu (Stand up stays out while prone); 2 the creature as its portrait alone; 3
 * two rows (a phone's layout).
 */
export type Density = 0 | 1 | 2 | 3;

/** The actions the bar takes for a turn (each its Action): Dash, Disengage, Dodge (SRD 5.2.1 pp. 9–10). */
export type TurnAction = "dash" | "disengage" | "dodge";
const TURN_ACTION: Record<
  TurnAction,
  { label: string; run: (id: string) => Promise<unknown>; failed: string }
> = {
  dash: { label: "Dash", run: dash, failed: "Couldn't dash" },
  disengage: { label: "Disengage", run: disengage, failed: "Couldn't disengage" },
  dodge: { label: "Dodge", run: dodge, failed: "Couldn't dodge" },
};

/**
 * The turn on the action bar (SPEC §8.12, §8.6, §29.3; AC-CMB-08, AC-MOV-05/09/18): whose it is first — the creature's
 * portrait in its ring, its name, its HP — then its action pips (Action ●, Bonus Action ▲, Reaction ◆, Object
 * interaction ■; a tracker, not a jail: using one already spent asks first, in the bar itself), what movement is left
 * ("20 of 30 ft left", with the DM's bonus as "30 + 10"; "Can't move — Grappled" when it can't), Dash, Stand up, Reset
 * move and End turn — for the player's own creature, or any for the DM. Out of its turn, a selected creature of yours
 * shows its Reaction (reactions happen on others' turns).
 */
export function TurnControls({
  density,
  asking,
  setAsking,
}: {
  density: Density;
  asking: TurnAction | null;
  setAsking: (a: TurnAction | null) => void;
}) {
  const view = useCombat((s) => s.view);
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const selection = useUi((s) => s.selection);
  const tokens = useEntities((s) => boardData(s).tokens);
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
        className="panel pointer-events-auto flex items-center gap-2 px-2 py-1.5"
        data-testid="turn-controls"
      >
        <Who t={sel} size={24} />
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
  // Why it can't move at all (§8.6) — a DM moves it anyway, so their bar still counts.
  const stuck = dm ? "" : own.stuck;
  const why = stuck ? `Can't move — ${stuckName(stuck)}` : undefined;
  const take = (a: TurnAction) => {
    setAsking(null);
    act(TURN_ACTION[a].run(mine.id), TURN_ACTION[a].failed);
  };
  const stand = prone
    ? {
        label: `Stand up (${standCost} ft)`,
        disabled: left < standCost || stuck !== "",
        hint: why,
        onSelect: () => act(standUp(mine.id), "Couldn't stand up"),
      }
    : null;
  const rest: { label: string; disabled?: boolean; hint?: string | undefined; onSelect: () => void }[] = [
    {
      label: "Dash",
      disabled: stuck !== "",
      hint: why,
      onSelect: () => (actionUsed ? setAsking("dash") : take("dash")),
    },
    // (Disengaged: no opportunity attacks this turn; Dodging: till the start of its next — rules audit C3.)
    ...(["disengage", "dodge"] as const).map((a) => ({
      label: TURN_ACTION[a].label,
      onSelect: () => (actionUsed ? setAsking(a) : take(a)),
    })),
    {
      label: "Reset move",
      disabled: own.usedFt <= 0 && own.segments === 0,
      onSelect: () => act(resetMove(mine.id), "Couldn't reset the move"),
    },
  ];
  const pips = (
    <span className="flex shrink-0 items-center gap-1" role="group" aria-label="Action pips">
      {PIPS.map((p) => (
        <Pip key={p.id} t={mine} pip={p} />
      ))}
    </span>
  );
  // "20 of 30 ft left" (the DM's bonus as its own addend: "40 of 30 + 10 ft left", AC-MOV-18); a creature that can't
  // move says why instead (critic P8 r2 I2).
  const meter = stuck ? (
    <span
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-14 text-[var(--ember-400)]"
      data-testid="move-budget"
      role="status"
    >
      {stuck === "locked" || stuck === "speed0" ? (
        <HeldIcon size={16} />
      ) : (
        <StatusIcon id={stuck} size={16} label="" />
      )}
      {why}
    </span>
  ) : (
    <span className="flex shrink-0 flex-col items-start leading-tight" data-testid="move-budget">
      <span className="tabular whitespace-nowrap text-14 text-muted">
        <span className="text-bone">{left}</span> of {bonus > 0 ? `${budget - bonus} + ${bonus}` : budget} ft
        left
      </span>
      <span className="block h-1 w-20 overflow-hidden rounded-chip bg-ink-950" aria-hidden>
        <span
          className="block h-full bg-[var(--path-ok)]"
          style={{ width: `${budget > 0 ? (left / budget) * 100 : 0}%` }}
        />
      </span>
    </span>
  );
  const end = (
    <Button
      size="S"
      variant="primary"
      className="shrink-0"
      onClick={() => act(endTurn(mine.id), "Couldn't end the turn")}
    >
      End turn
    </Button>
  );
  const standButton = stand ? (
    <Button
      size="S"
      variant="secondary"
      className="shrink-0"
      disabled={stand.disabled}
      title={stand.hint}
      onClick={stand.onSelect}
    >
      {stand.label}
    </Button>
  ) : null;
  // A spent Action: the question in the bar itself, where the buttons were (never over the roll feed); it wraps
  // within the bar rather than widening it (critic P8 r2 I10).
  const question = asking ? (
    <span
      role="alertdialog"
      aria-label="Action already used"
      className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-13 text-bone"
    >
      <span className="min-w-0">Action already used — {TURN_ACTION[asking].label} anyway?</span>
      <span className="flex shrink-0 gap-2">
        <Button size="S" variant="primary" onClick={() => take(asking)}>
          {TURN_ACTION[asking].label}
        </Button>
        <Button size="S" variant="ghost" onClick={() => setAsking(null)}>
          Cancel
        </Button>
      </span>
    </span>
  ) : null;
  const menu = <Menu label="Turn actions" items={rest} up />;
  return (
    <div
      className={`panel pointer-events-auto relative min-w-0 max-w-full px-2.5 py-1.5 ${density === 3 ? "flex flex-col gap-1" : "flex items-center gap-2"}`}
      data-testid="turn-controls"
      data-token={mine.id}
      data-density={density}
    >
      {density === 3 ? (
        // Two rows — whose turn, its HP and what's left, End turn; the pips (touch-sized), Stand up while prone, and
        // the rest in a menu.
        <>
          <span className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <Who t={mine} size={24} bare />
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    className="font-caps min-w-0 truncate text-13 leading-tight text-bone"
                    title={mine.name}
                  >
                    {keepHyphenated(shortName(mine.name))}
                  </span>
                  <HpNumbers t={mine} />
                </span>
                {meter}
              </span>
            </span>
            {end}
          </span>
          {question ?? (
            <span className="flex items-center justify-between gap-2">
              {pips}
              <span className="flex items-center gap-1">
                {standButton}
                {menu}
              </span>
            </span>
          )}
        </>
      ) : (
        <>
          <Who t={mine} size={32} bare={density >= 2} />
          <span className="h-8 shrink-0 border-l border-line" aria-hidden />
          {pips}
          {meter}
          {question ?? (
            <>
              {density === 0 ? (
                [...(stand ? [stand] : []), ...rest].map((s) => (
                  <Button
                    key={s.label}
                    size="S"
                    variant="ghost"
                    className="shrink-0"
                    disabled={s.disabled}
                    title={s.hint}
                    onClick={s.onSelect}
                  >
                    {s.label}
                  </Button>
                ))
              ) : (
                <>
                  {standButton}
                  {menu}
                </>
              )}
              {end}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A name for a phone's two-row bar, beside the HP: whole when short, else its first word — with the number that tells
 * it from its namesakes ("Goblin 2") — rather than cut off mid-word ("Thorin Emberha…"). The tracker and its plate name
 * it in full.
 */
export function shortName(name: string): string {
  if (name.length <= 12) return name;
  const words = name.trim().split(/\s+/);
  const last = words.at(-1) ?? "";
  return words.length > 1 && /^\d+$/.test(last) ? `${words[0]} ${last}` : (words[0] ?? name);
}

/** Its hit points, "44 / 44" (§29.3), when the viewer holds them. */
function HpNumbers({ t }: { t: TokenView }) {
  if (!t.hp) return null;
  return (
    <span
      className="display tabular shrink-0 whitespace-nowrap text-13 leading-tight text-bone"
      data-testid="turn-hp"
    >
      {t.hp.hp}
      <span className="text-muted"> / {t.hp.hpMax}</span>
      {t.hp.hpTemp > 0 ? <span className="text-[var(--arcane-400)]"> +{t.hp.hpTemp}</span> : null}
    </span>
  );
}

/** Whose turn controls these are (§29.3): the creature's portrait in its ring, its name, its HP (numbers and a bar). */
function Who({ t, size, bare = false }: { t: TokenView; size: number; bare?: boolean }) {
  const colorBlind = useSettings((s) => s.colorBlind);
  const src = useAssetImage(t.portraitAssetId || t.assetId || null, 64);
  const hp = t.hpFrac;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-2" data-testid="turn-who">
      <Portrait name={t.name} color={ringColorOf(t, colorBlind)} size={size} src={src} />
      {bare ? null : (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-caps max-w-[10rem] truncate text-14 leading-tight text-bone">
            {keepHyphenated(t.name)}
          </span>
          <span className="flex items-center gap-2">
            {hp >= 0 ? (
              <span className="block h-1 w-16 overflow-hidden rounded-chip bg-ink-950" aria-hidden>
                <span
                  className="block h-full"
                  style={{
                    width: `${Math.max(0, Math.min(1, hp)) * 100}%`,
                    background: hp > 0.5 ? "var(--hp-high)" : hp > 0.25 ? "var(--hp-mid)" : "var(--hp-low)",
                  }}
                />
              </span>
            ) : null}
            <HpNumbers t={t} />
          </span>
        </span>
      )}
      {bare ? <span className="sr-only">{t.name}</span> : null}
    </span>
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
