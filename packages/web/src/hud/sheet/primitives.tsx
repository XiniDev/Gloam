import type { ActorView } from "@gloam/shared/protocol";
import { Lock, Minus, Pencil, Plus, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { D20Icon } from "../../icons/dice.tsx";
import { useBoard } from "../../state/entities.ts";
import { DeathPip } from "../../ui/DeathPip.tsx";
import { hintFor, modeOf, type RollMode, type RollTest, testOf } from "./rollMode.ts";
import { rollFromSheet, rollPhysically } from "./sheetActions.ts";

/**
 * The sheet's parts on parchment (SPEC §8.10, §27.2 document surface): ink on paper, the wax red for what's active,
 * values that roll when clicked, fields edited in place.
 */

const LONG_PRESS_MS = 480;

/**
 * A value that rolls (§8.9 Rolling from anywhere): click rolls it (Alt = advantage, Ctrl/Cmd = disadvantage); on
 * touch, a long press opens Normal / Advantage / Disadvantage / Physical.
 */
export function Rollable({
  actor,
  formula,
  label,
  children,
  className = "",
  title,
  test,
}: {
  actor: ActorView;
  formula: string;
  label: string;
  children: ReactNode;
  className?: string;
  title?: string;
  /** What kind of D20 Test it is (else read from the formula): its character's conditions give it a hint. */
  test?: RollTest | null;
}) {
  const [menu, setMenu] = useState(false);
  const timer = useRef<number | null>(null);
  const pressed = useRef(false);
  const touch = useRef(false);
  const ref = useRef<HTMLSpanElement>(null);
  // Its conditions' advantage or disadvantage (AC-DICE-11): a click rolls with it; Alt / Ctrl choose, and the menu
  // (right-click, or a long press) sets it aside with "Normal".
  // Dodging, from its token (rules audit A10): "" not dodging, "dodging", or "speed0" — dodging at a Speed of 0.
  const dodge = useBoard((d) => {
    for (const t of d.tokens.values())
      if (t.actorId === actor.id && (!t.dm || t.dm.link === "linked") && t.markers.includes("dodging"))
        return t.own?.stuck === "speed0" ? "speed0" : "dodging";
    return "";
  });
  const hint = hintFor(
    actor.sheet.core.conditions,
    test === undefined ? testOf(formula) : test,
    dodge ? { markers: ["dodging"], ...(dodge === "speed0" ? { speedFt: 0 } : {}) } : undefined,
  );
  // An attack says so: in combat, on its creature's turn, it marks the Action (AC-CMB-08).
  const kind = test === undefined ? testOf(formula)?.kind : test?.kind;
  const roll = (mode: RollMode) =>
    void rollFromSheet(actor, formula, label, mode, kind === "attack" ? "attack" : undefined);
  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [menu]);
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        data-testid="rollable"
        data-formula={formula}
        aria-label={`Roll ${label}`}
        title={
          title ??
          `${label}: ${formula}${hint.mode === "normal" ? "" : ` — ${hint.mode === "adv" ? "advantage" : "disadvantage"} (${hint.from.join(", ")})`} (Alt: advantage, Ctrl: disadvantage, right-click: more)`
        }
        data-hint={hint.mode === "normal" ? undefined : hint.mode}
        className={`group inline-flex min-h-[var(--touch-min)] min-w-[var(--touch-min)] items-center justify-center gap-1 rounded-chip px-1 transition-colors duration-[var(--dur-fast)] hover:bg-parchment-deep hover:text-wax focus-visible:outline-2 focus-visible:outline-wax ${className}`}
        onClick={(e) => {
          if (pressed.current) {
            pressed.current = false;
            return;
          }
          const chosen = modeOf(e);
          roll(chosen === "normal" ? hint.mode : chosen);
        }}
        onPointerDown={(e) => {
          // A new press: a long press before it may have ended without a click (Android sends none).
          pressed.current = false;
          touch.current = e.pointerType === "touch";
          if (!touch.current) return;
          timer.current = window.setTimeout(() => {
            pressed.current = true;
            setMenu(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={() => {
          if (timer.current) window.clearTimeout(timer.current);
        }}
        onPointerLeave={() => {
          if (timer.current) window.clearTimeout(timer.current);
        }}
        onContextMenu={(e) => {
          // A right-click, or Android's long press: this menu, not the browser's.
          e.preventDefault();
          if (timer.current) window.clearTimeout(timer.current);
          pressed.current = true;
          setMenu(true);
        }}
      >
        {children}
        {hint.mode !== "normal" ? (
          <span
            aria-hidden
            className={`-ml-0.5 text-12 leading-none ${hint.mode === "adv" ? "text-success" : "text-wax"}`}
          >
            {hint.mode === "adv" ? "▲" : "▼"}
          </span>
        ) : null}
      </button>
      {menu ? (
        <span
          role="menu"
          aria-label={`Roll ${label}`}
          className="panel absolute left-0 top-full z-20 mt-1 flex w-44 flex-col py-1"
        >
          {(
            [
              [
                hint.mode === "normal" ? "Normal" : `Normal (set aside ${hint.from.join(", ")})`,
                () => roll("normal"),
              ],
              ["Advantage", () => roll("adv")],
              ["Disadvantage", () => roll("dis")],
              ["Physical…", () => rollPhysically(formula, label)],
            ] as const
          ).map(([name, fn]) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              className="flex min-h-[var(--touch-min)] items-center gap-2 px-3 text-left text-14 text-bone hover:bg-raised"
              onClick={() => {
                setMenu(false);
                fn();
              }}
            >
              {name}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** A small roll button (an attack, a damage, a spell): the d20 glyph beside what it rolls. */
export function RollButton({
  actor,
  formula,
  label,
  text,
  test,
}: {
  actor: ActorView;
  formula: string;
  label: string;
  text: ReactNode;
  test?: RollTest | null;
}) {
  return (
    <Rollable
      actor={actor}
      formula={formula}
      label={label}
      {...(test !== undefined ? { test } : {})}
      className="min-h-8 border border-parchment-edge px-2 text-13 font-bold text-paper-ink"
    >
      <D20Icon size={14} />
      {text}
    </Rollable>
  );
}

/** A number edited in place: shown as text, an input while editing; Enter or leaving commits, Escape cancels. */
export function NumberField({
  value,
  onCommit,
  label,
  min = -99_999,
  max = 99_999,
  disabled = false,
  className = "",
  width = "3.5rem",
}: {
  value: number;
  onCommit: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
  width?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft.trim());
    setDraft(null);
    if (Number.isFinite(n) && Math.round(n) !== value) onCommit(Math.min(max, Math.max(min, Math.round(n))));
  };
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      disabled={disabled}
      value={draft ?? String(value)}
      onFocus={(e) => {
        setDraft(String(value));
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d-]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      style={{ width }}
      className={`tabular h-8 rounded-[var(--radius-control)] border border-transparent bg-transparent px-1 text-center text-14 font-bold text-paper-ink hover:border-parchment-edge focus:border-brass-deep focus:shadow-[var(--ring-focus)] focus:bg-parchment focus:outline-none disabled:opacity-60 ${className}`}
    />
  );
}

/** Text edited in place (one line, or several). */
export function TextField({
  value,
  onCommit,
  label,
  placeholder,
  multiline = false,
  disabled = false,
  className = "",
  autoFocus = false,
  onDone,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  disabled?: boolean;
  className?: string;
  /** Focused as it appears (a heading turned into its field). */
  autoFocus?: boolean;
  /** Called when editing ends, committed or not (Enter, Escape, leaving the field). */
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = draft;
    setDraft(null);
    if (v !== value) onCommit(v);
  };
  const end = () => {
    commit();
    onDone?.();
  };
  const cls = `w-full rounded-[var(--radius-control)] border border-parchment-edge/60 bg-parchment/60 px-2 text-14 text-paper-ink placeholder:text-paper-muted/70 focus:border-brass-deep focus:shadow-[var(--ring-focus)] focus:bg-parchment focus:outline-none disabled:opacity-60 ${className}`;
  if (multiline)
    return (
      <textarea
        aria-label={label}
        disabled={disabled}
        value={draft ?? value}
        placeholder={placeholder}
        onFocus={() => setDraft(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={5}
        className={`${cls} py-1.5 leading-[1.45]`}
      />
    );
  return (
    <input
      aria-label={label}
      disabled={disabled}
      value={draft ?? value}
      placeholder={placeholder}
      // biome-ignore lint/a11y/noAutofocus: only when the person just asked to edit it (clicked its heading)
      autoFocus={autoFocus}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={end}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className={`h-8 ${cls}`}
    />
  );
}

/**
 * − value + (SPEC §28 NumberStepper): steps by one, by five with Shift, and repeats while held; the value can be typed.
 */
export function Stepper({
  value,
  onChange,
  label,
  min = -99_999,
  max = 99_999,
  disabled = false,
  big = false,
  after,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** The value in the display face, large (the sheet's HP). */
  big?: boolean;
  /** Shown after the value, inside the − … + (HP's "/ 52"). */
  after?: ReactNode;
}) {
  const repeat = useRef<number | null>(null);
  // Held down, the steps run ahead of the server's echo: count from the last step sent, and take the value from the
  // sheet again only when the sheet's value itself changes.
  const cur = useRef(value);
  const seen = useRef(value);
  if (value !== seen.current) {
    seen.current = value;
    cur.current = value;
  }
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const lastStep = useRef(0);
  const step = (by: number) => {
    // Steps that never came back (refused, or turned into a proposal) don't count for long.
    if (performance.now() - lastStep.current > 1500) cur.current = seen.current;
    lastStep.current = performance.now();
    const next = clamp(cur.current + by);
    if (next === cur.current) return;
    cur.current = next;
    onChange(next);
  };
  const stop = () => {
    if (repeat.current) window.clearInterval(repeat.current);
    repeat.current = null;
  };
  useEffect(
    () => () => {
      if (repeat.current) window.clearInterval(repeat.current);
    },
    [],
  );
  const button = (dir: 1 | -1) => (
    <button
      type="button"
      aria-label={`${label} ${dir > 0 ? "up" : "down"}`}
      disabled={disabled}
      className="grid h-8 min-h-[var(--touch-min)] w-8 min-w-[var(--touch-min)] place-items-center rounded-[var(--radius-control)] text-paper-muted hover:bg-parchment-deep hover:text-paper-ink disabled:opacity-40"
      onPointerDown={(e) => {
        const by = dir * (e.shiftKey ? 5 : 1);
        step(by);
        stop();
        const start = Date.now();
        repeat.current = window.setInterval(() => {
          if (Date.now() - start < 400) return;
          step(by);
        }, 90);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          step(dir * (e.shiftKey ? 5 : 1));
        }
      }}
    >
      {dir > 0 ? <Plus size={15} /> : <Minus size={15} />}
    </button>
  );
  return (
    <span className="inline-flex items-center" role="group" aria-label={label}>
      {button(-1)}
      <NumberField
        value={value}
        onCommit={(v) => onChange(clamp(v))}
        label={label}
        min={min}
        max={max}
        disabled={disabled}
        width={big ? "3.2rem" : undefined}
        className={big ? "display h-10 text-28 leading-none" : ""}
      />
      {after}
      {button(1)}
    </span>
  );
}

/** Pips: slots, uses, death saves — filled for spent (or earned), click one to set the count to it. */
export function Pips({
  total,
  filled,
  onSet,
  label,
  tone = "wax",
  disabled = false,
  filledMeans = "spent",
  shape = "diamond",
}: {
  total: number;
  filled: number;
  onSet: (n: number) => void;
  label: string;
  tone?: "wax" | "ink";
  disabled?: boolean;
  /** What a filled pip is: one spent (slots used), or one left (Hit Dice, as the rest cards count them). */
  filledMeans?: "spent" | "left";
  /** Death saves draw as hearts (successes) and skulls (failures), §28; anything else a diamond. */
  shape?: "diamond" | "success" | "failure";
}) {
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1"
      role="group"
      aria-label={`${label}: ${filled} of ${total}`}
    >
      {Array.from({ length: total }, (_, i) => {
        const on = i < filled;
        return (
          <button
            key={i}
            type="button"
            disabled={disabled}
            aria-label={`${label} ${i + 1}${on ? ` (${filledMeans})` : ""}`}
            aria-pressed={on}
            onClick={() => onSet(on && i === filled - 1 ? i : i + 1)}
            className="grid h-6 min-h-[var(--touch-min)] w-6 min-w-[var(--touch-min)] place-items-center disabled:opacity-50"
          >
            {shape === "diamond" ? (
              <span
                className={`block h-3.5 w-3.5 rotate-45 border ${
                  on
                    ? tone === "wax"
                      ? "border-wax bg-wax"
                      : "border-paper-ink bg-paper-ink"
                    : "border-paper-muted bg-transparent"
                }`}
                aria-hidden
              />
            ) : (
              <DeathPip kind={shape} filled={on} size={18} />
            )}
          </button>
        );
      })}
    </span>
  );
}

/** A derived value (§8.10 Derived values): computed, or set by hand with an override badge that reverts it. */
export function DerivedValue({
  value,
  auto,
  overridden,
  onOverride,
  onRevert,
  label,
  disabled = false,
  children,
}: {
  value: number;
  auto: number;
  overridden: boolean;
  onOverride: (v: number) => void;
  onRevert: () => void;
  label: string;
  disabled?: boolean;
  /** The roll-able display of the value (its button); a plain value otherwise. */
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      {editing ? (
        <NumberField
          value={value}
          label={`${label} (set by hand)`}
          onCommit={(v) => {
            setEditing(false);
            onOverride(v);
          }}
          min={-999}
          max={9999}
        />
      ) : (
        (children ?? <span className="tabular text-14 font-bold">{value}</span>)
      )}
      {overridden ? (
        <button
          type="button"
          data-testid="override-badge"
          disabled={disabled}
          title={`Set by hand (worked out: ${auto}). Click to go back to ${auto}.`}
          aria-label={`${label} is set by hand; revert to ${auto}`}
          onClick={onRevert}
          className="caps inline-flex h-5 min-h-[var(--touch-min)] min-w-[var(--touch-min)] items-center justify-center gap-0.5 rounded-chip border border-wax px-1 text-12 text-wax hover:bg-wax hover:text-parchment"
        >
          <RotateCcw size={10} aria-hidden />
          set
        </button>
      ) : !disabled ? (
        <button
          type="button"
          aria-label={`Set ${label} by hand`}
          title="Set by hand"
          onClick={() => setEditing(true)}
          className="grid h-5 min-h-[var(--touch-min)] w-5 min-w-[var(--touch-min)] place-items-center rounded-chip text-paper-muted opacity-0 hover:text-paper-ink focus:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100"
        >
          <Pencil size={12} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** A section's heading on the page. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-4 flex items-center justify-between gap-2 border-b border-parchment-edge/70 pb-1 first:mt-0">
      <h3 className="caps text-12 text-paper-muted">{children}</h3>
      {action}
    </div>
  );
}

/** Marks a field the lock keeps from this player (an edit to it becomes a proposal). */
export function LockMark({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Lock
      size={11}
      className="shrink-0 text-paper-muted"
      aria-label="Locked — changes are proposed to the DM"
    />
  );
}
