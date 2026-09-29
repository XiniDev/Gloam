import type { CastTargetView, CastView } from "@gloam/shared/protocol";
import { Check, ChevronDown, ChevronUp, EyeOff, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { D20Icon } from "../../icons/dice.tsx";
import {
  castApply,
  castCancel,
  castClose,
  castNpcSaves,
  castRevealDc,
  castRoll,
  castSet,
  castSkip,
  castTarget,
  useSpells,
} from "../../net/spells.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { toast } from "../../ui/Toast.tsx";
import { keepHyphenated } from "../../ui/text.tsx";
import { asksOf } from "./castHide.ts";

const ABILITY: Record<string, string> = {
  str: "STR",
  dex: "DEX",
  con: "CON",
  int: "INT",
  wis: "WIS",
  cha: "CHA",
};
const COVER: Record<string, string> = {
  half: "half cover (+2)",
  threeQuarters: "¾ cover (+5)",
  total: "total cover",
};
const STEP_LABEL = {
  targets: "Targets",
  attacks: "Attacks",
  saves: "Saves",
  damage: "Damage",
  apply: "Apply",
} as const;

const act = (p: Promise<unknown>, what: string) => void p.catch((e: Error) => toast.danger(what, e.message));

/** "8d6 [fire] + 2d6 [cold]" as its parts: each formula and its damage type (the card shows a chip, not the tag). */
export function damageParts(formula: string): { formula: string; type: string | null }[] {
  const out: { formula: string; type: string | null }[] = [];
  const re = /\s*(.+?)\s*\[([a-z]+)\]\s*(?:\+|$)/g;
  let m: RegExpExecArray | null = re.exec(formula);
  if (!m) return [{ formula: formula.trim(), type: null }];
  while (m) {
    out.push({ formula: (m[1] ?? "").trim(), type: m[2] ?? null });
    m = re.exec(formula);
  }
  return out;
}

/** A damage type as a small chip in its own colour (§27.2 --dmg-*). */
function TypeChip({ type }: { type: string }) {
  return (
    <span
      className="inline-flex items-center rounded-[var(--radius-chip)] px-1.5 text-12 font-bold"
      style={{
        color: `var(--dmg-${type})`,
        background: `color-mix(in srgb, var(--dmg-${type}) 16%, transparent)`,
      }}
    >
      {type}
    </span>
  );
}

/** What gives an attack advantage or disadvantage, in words (the server's "target Restrained"). */
function hintWords(h: string, target: string, attacker: string): string {
  if (h === "target outlined") return `${target} is outlined`;
  if (h.startsWith("target ")) return `${target} is ${h.slice(7)}`;
  return `${attacker} is ${h}`;
}

/**
 * A resolution card (SPEC §8.13 Resolution card, §29.5; AC-SPL-04/05/12/13): what was cast (or swung) and at whom —
 * the DM's whole card: its steps, the save with its DC (hidden from players until shown) and "Roll all NPC saves", the
 * damage rolled or entered, a row per creature (its save or hit, what it takes, full / half / none, its resistances —
 * each toggleable — conditions to tick, the final number to edit, its HP before and after; one cut off by a wall is
 * "blocked", added back by hand), the cover hint, Skip / Apply / Apply all / Cancel & refund. The caster's card has
 * their rolls — attacks per target, the damage — and Cancel before anything's applied; others see a line in the feed.
 */
export function ResolutionCard({ c }: { c: CastView }) {
  const dm = c.can.edit;
  const [open, setOpen] = useState<string | null>(null);
  const waiting = c.targets.filter((t) => t.state === "in");
  const npcSavesLeft = dm && c.save ? waiting.some((t) => !t.pc && t.save?.total === undefined) : false;
  const rolled = c.damage?.per === "cast" ? c.damage.roll : null;
  return (
    <li
      className="panel pointer-events-auto flex flex-col gap-2 border-brass/60 p-3 shadow-[var(--shadow-float)] motion-safe:animate-[rise-in_var(--dur-base)_var(--ease-out)_both]"
      data-testid="resolution-card"
      data-cast={c.id}
      aria-label={`${c.name}: resolution`}
    >
      <header className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="caps block text-12 text-brass">
            {c.subtitle} · {keepHyphenated(c.casterName)}
          </span>
          <span className="display block truncate text-22 leading-tight text-bone">{c.name}</span>
        </span>
        {dm ? (
          <IconButton label="Close the card" onClick={() => act(castClose(c.id), "Couldn't close it")}>
            <X size={16} />
          </IconButton>
        ) : (
          // The caster's: hidden on their screen (the DM's card goes on); back when it asks something new of them.
          <IconButton
            label="Hide the card"
            onClick={() => {
              const s = useSpells.getState();
              s.set({ hiddenCasts: new Map(s.hiddenCasts).set(c.id, asksOf(c)) });
            }}
          >
            <X size={16} />
          </IconButton>
        )}
      </header>
      {dm ? (
        // Where the card stands: the steps done (a check), the one under way (underlined), those to come (muted).
        <ol className="flex flex-wrap items-center gap-1 text-12 text-muted" aria-label="Steps">
          {c.steps.map((s, i) => {
            const state = stepState(c, s);
            return (
              <li key={s} className="flex items-center gap-1" data-step={s} data-state={state}>
                {i ? <span aria-hidden>→</span> : null}
                <span
                  className={`inline-flex items-center gap-0.5 ${state === "done" ? "text-[var(--hp-high)]" : state === "now" ? "border-b border-brass text-bone" : ""}`}
                >
                  {state === "done" ? <Check size={12} aria-hidden /> : null}
                  {STEP_LABEL[s]}
                  {s === "targets" ? ` ${waiting.length}` : ""}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {c.save ? (
        <Row>
          <span className="min-w-0 flex-1 text-13 text-bone">
            <span className="font-bold">{ABILITY[c.save.ability]} save</span>
            {c.save.dc !== undefined ? (
              <span className="text-muted">
                {" "}
                · DC {c.save.dc}
                {dm && !c.save.revealed ? (
                  <span title="Hidden from the players">
                    {" "}
                    <EyeOff size={12} className="inline align-[-1px]" aria-hidden />
                    <span className="sr-only">hidden from the players</span>
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="text-muted">
              {c.save.onSuccess === "half"
                ? " · half on a success"
                : c.save.onSuccess === "none"
                  ? " · none on a success"
                  : ""}
            </span>
          </span>
          {dm && c.save.dc !== undefined ? (
            <Button
              size="S"
              variant="ghost"
              onClick={() => act(castRevealDc(c.id, !c.save?.revealed), "Couldn't change that")}
            >
              {c.save.revealed ? "Hide DC" : "Show DC"}
            </Button>
          ) : null}
          {npcSavesLeft ? (
            <Button
              size="S"
              variant="secondary"
              icon={<D20Icon size={14} />}
              onClick={() => act(castNpcSaves(c.id), "Couldn't roll them")}
            >
              Roll NPC saves
            </Button>
          ) : null}
        </Row>
      ) : null}
      {c.damage ? (
        <Row>
          <span className="min-w-0 flex-1 text-13 text-bone">
            <span className="font-bold">{c.damage.healing ? "Healing" : "Damage"}</span>{" "}
            {damageParts(c.damage.formula).map((p, i) => (
              <span key={`${p.formula}${i}`} className="inline-flex items-center gap-1">
                {i ? <span className="text-muted">+</span> : null}
                <span className="mono text-12 text-muted">{p.formula}</span>
                {p.type && !c.damage?.healing ? <TypeChip type={p.type} /> : null}
              </span>
            ))}
            {rolled ? (
              <span className="ml-1.5 text-bone" data-testid="cast-rolled">
                · rolled <span className="tabular font-bold">{rolled.total}</span>
                {rolled.entered ? " (entered)" : ""}
              </span>
            ) : null}
          </span>
          {c.damage.per === "cast" && !rolled && c.can.roll ? <DamageRoll c={c} /> : null}
        </Row>
      ) : null}
      <ul className="flex flex-col divide-y divide-line/60" aria-label="Targets">
        {c.targets.map((t) => (
          <TargetRow
            key={t.key}
            c={c}
            t={t}
            dm={dm}
            open={open === t.key}
            onToggle={() => setOpen((o) => (o === t.key ? null : t.key))}
          />
        ))}
      </ul>
      {c.coverNote ? (
        <p className="text-12 text-muted" data-testid="cover-note">
          {c.coverNote}
        </p>
      ) : null}
      <footer className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {c.can.cancel ? (
          <Button size="S" variant="ghost" onClick={() => act(castCancel(c.id), "Couldn't cancel it")}>
            {c.slot ? "Cancel & refund slot" : "Cancel"}
          </Button>
        ) : null}
        {dm && waiting.length
          ? (() => {
              const r = readiness(c, waiting);
              return (
                <Button
                  size="S"
                  variant={r.ready ? "primary" : "secondary"}
                  disabled={r.nothing}
                  title={r.why ?? undefined}
                  onClick={() => act(castApply(c.id), "Couldn't apply it")}
                >
                  {r.nothing ? r.why : r.ready ? (waiting.length === 1 ? "Apply" : "Apply all") : "Apply now"}
                </Button>
              );
            })()
          : null}
      </footer>
    </li>
  );
}

/** A step of the card: done, the one under way, or to come. */
function stepState(c: CastView, s: CastView["steps"][number]): "done" | "now" | "later" {
  const order = c.steps;
  const done = (x: CastView["steps"][number]): boolean => {
    const rows = c.targets.filter((t) => t.state === "in");
    switch (x) {
      case "targets":
        return true;
      case "attacks":
        return rows.every((t) => t.attack?.total !== undefined);
      case "saves":
        return rows.every(
          (t) => !t.save || t.save.total !== undefined || typeof t.save.success === "boolean",
        );
      case "damage":
        return c.damage?.per === "cast"
          ? Boolean(c.damage.roll)
          : rows.every((t) => t.roll || (c.attack && t.attack?.hit === false));
      case "apply":
        return !rows.length;
    }
  };
  if (done(s)) return "done";
  const first = order.find((x) => !done(x));
  return first === s ? "now" : "later";
}

/** Whether Apply has what it needs: its damage rolled, its saves in — else what's missing (and whether it's nothing). */
function readiness(
  c: CastView,
  rows: CastTargetView[],
): { ready: boolean; nothing: boolean; why: string | null } {
  const damageIn = !c.damage || (c.damage.per === "cast" ? Boolean(c.damage.roll) : rows.some((t) => t.roll));
  const savesLeft = rows.filter(
    (t) => t.save && t.save.total === undefined && typeof t.save.success !== "boolean",
  ).length;
  const lands = rows.some((t) => t.conditions.some((x) => x.on));
  if (c.damage && !damageIn && !lands) return { ready: false, nothing: true, why: "Roll the damage first" };
  if (!damageIn)
    return { ready: false, nothing: false, why: "The damage isn't rolled: only what lands without it" };
  if (savesLeft)
    return {
      ready: false,
      nothing: false,
      why: `${savesLeft} ${savesLeft === 1 ? "save isn't" : "saves aren't"} in: they count as failed`,
    };
  return { ready: true, nothing: false, why: null };
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-raised/60 px-2.5 py-1.5">
      {children}
    </div>
  );
}

/** Roll the damage (or healing) — or enter a number (a physical roll, the DM's say). */
function DamageRoll({ c, targetId }: { c: CastView; targetId?: string }) {
  const [entering, setEntering] = useState(false);
  const [v, setV] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // The field takes the focus when it opens (Enter… was the request to type a number).
  useEffect(() => {
    if (entering) input.current?.focus();
  }, [entering]);
  if (entering)
    return (
      <span className="flex items-center gap-1">
        <input
          ref={input}
          aria-label="Damage total"
          inputMode="numeric"
          value={v}
          onChange={(e) => setV(e.target.value.replace(/\D/g, "").slice(0, 5))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && v) {
              act(
                castRoll(c.id, "damage", { ...(targetId ? { targetId } : {}), entered: Number(v) }),
                "Couldn't enter it",
              );
              setEntering(false);
            }
            if (e.key === "Escape") setEntering(false);
          }}
          className="tabular h-8 w-16 rounded-[var(--radius-control)] border border-line bg-ink-900 text-center text-14 text-bone focus:border-brass focus:outline-none"
        />
        <Button
          size="S"
          variant="primary"
          disabled={!v}
          onClick={() => {
            act(
              castRoll(c.id, "damage", { ...(targetId ? { targetId } : {}), entered: Number(v) }),
              "Couldn't enter it",
            );
            setEntering(false);
          }}
        >
          Enter
        </Button>
      </span>
    );
  return (
    <span className="flex items-center gap-1">
      <Button
        size="S"
        variant="secondary"
        icon={<D20Icon size={14} />}
        onClick={() => act(castRoll(c.id, "damage", targetId ? { targetId } : {}), "Couldn't roll it")}
      >
        Roll
      </Button>
      <Button size="S" variant="ghost" onClick={() => setEntering(true)}>
        Enter…
      </Button>
    </span>
  );
}

function TargetRow({
  c,
  t,
  dm,
  open,
  onToggle,
}: {
  c: CastView;
  t: CastTargetView;
  dm: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const saved = t.save;
  const saveChip =
    c.save && saved ? (
      saved.pending ? (
        <span className="text-12 text-muted" data-testid="save-waiting">
          waiting…
        </span>
      ) : saved.total !== undefined || typeof saved.success === "boolean" ? (
        // A roll's total — or, set by the DM without one, the word (saves / fails).
        <span
          className={`tabular text-13 font-bold ${saved.success ? "text-[var(--hp-high)]" : "text-ember"}`}
          data-testid="save-result"
          data-success={saved.success ? "true" : "false"}
        >
          {saved.autoFail ? "fails" : (saved.total ?? (saved.success ? "saves" : "fails"))}{" "}
          {saved.success ? (
            <Check size={13} className="inline align-[-2px]" aria-label="saved" />
          ) : (
            <X size={13} className="inline align-[-2px]" aria-label="failed" />
          )}
        </span>
      ) : null
    ) : null;
  const atk = t.attack;
  // An attack still to roll: the mode its hints add up to, until the roller sets it aside (§19.3).
  const hints = t.attackHints;
  const [picked, setPicked] = useState<"none" | "adv" | "dis" | null>(null);
  const mode = picked ?? hints?.mode ?? "none";
  const attackChip = c.attack ? (
    atk?.total !== undefined ? (
      <span
        className={`tabular text-13 font-bold ${atk.crit ? "text-brass-bright" : atk.hit === false ? "text-ember" : atk.hit ? "text-[var(--hp-high)]" : "text-bone"}`}
        data-testid="attack-result"
      >
        {atk.total}
        {atk.hit !== undefined && atk.hit !== null ? (atk.hit ? " hit" : " miss") : ""}
        {atk.crit ? " crit" : ""}
        {dm && atk.entered ? <span className="font-normal text-muted"> (entered)</span> : null}
      </span>
    ) : c.can.roll && t.state === "in" ? (
      <AttackRoll c={c} t={t} mode={mode} />
    ) : null
  ) : null;
  if (t.state === "blocked" || t.state === "removed")
    return (
      <li
        className="flex items-center gap-2 py-1.5 text-13 text-muted"
        data-testid="cast-target"
        data-token={t.id}
        data-state={t.state}
      >
        <span className="min-w-0 flex-1 truncate">
          {keepHyphenated(t.name)}{" "}
          <span className="text-12">{t.state === "blocked" ? "· blocked by a wall" : "· left out"}</span>
        </span>
        {dm ? (
          <Button
            size="S"
            variant="ghost"
            onClick={() => act(castTarget(c.id, t.key, true), "Couldn't add it")}
          >
            {t.state === "blocked" ? "Add anyway" : "Add back"}
          </Button>
        ) : null}
      </li>
    );
  const done = t.state === "applied" || t.state === "skipped";
  const num = t.final ?? t.computed;
  return (
    <li
      className={`flex flex-col gap-1 py-1.5 ${done ? "opacity-60" : ""}`}
      data-testid="cast-target"
      data-token={t.id}
      data-state={t.state}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-14 text-bone">
          {keepHyphenated(t.name)}
          {t.times > 1 ? <span className="text-muted"> ×{t.times}</span> : null}
          {t.cover !== "none" ? (
            <span
              className="ml-1.5 whitespace-nowrap rounded-[var(--radius-chip)] bg-brass/15 px-1.5 text-12 text-brass"
              title={`Cover hint (§17.5): ${COVER[t.cover]}`}
            >
              {t.cover === "threeQuarters"
                ? "¾ cover · +5 AC"
                : t.cover === "half"
                  ? "½ cover · +2 AC"
                  : "total cover"}
            </span>
          ) : null}
        </span>
        {saveChip}
        {attackChip}
        {c.damage?.per === "target" && t.state === "in" && (!c.attack || atk?.hit) ? (
          t.roll ? (
            <span className="tabular text-12 text-muted">rolled {t.roll.total}</span>
          ) : c.can.roll ? (
            <DamageRoll c={c} targetId={t.key} />
          ) : null
        ) : null}
        {dm && c.damage && num !== undefined ? (
          <FinalInput c={c} t={t} value={num} edited={t.final !== undefined} />
        ) : null}
        {done ? <span className="caps text-12 text-fog">{t.state}</span> : null}
        {dm && !done ? (
          <IconButton
            label={open ? `Less on ${t.name}` : `More on ${t.name}`}
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </IconButton>
        ) : null}
      </div>
      {hints && !atk && c.can.roll && t.state === "in" ? (
        <AttackHintLine
          hints={hints}
          mode={mode}
          onMode={setPicked}
          target={t.name}
          attacker={c.casterName}
        />
      ) : null}
      {dm && t.hp && !done ? (
        <span className="tabular pl-0.5 text-12 text-muted" data-testid="hp-change">
          {c.damage?.healing ? "HP" : t.outcome === "none" ? "no damage" : `takes ${t.outcome}`} · HP{" "}
          {t.hp.now} → {t.hp.after}
        </span>
      ) : null}
      {dm && open && !done ? <Details c={c} t={t} /> : null}
    </li>
  );
}

/**
 * An attack's hints under its row (§19.3): what gives advantage or disadvantage and why, Exhaustion's penalty, a hit
 * that would be a critical hit — and the mode, set from them, which the roller can change before rolling.
 */
function AttackHintLine({
  hints,
  mode,
  onMode,
  target,
  attacker,
}: {
  hints: NonNullable<CastTargetView["attackHints"]>;
  mode: "none" | "adv" | "dis";
  onMode: (m: "none" | "adv" | "dis") => void;
  target: string;
  attacker: string;
}) {
  const why = [
    ...hints.adv.map((x) => `Advantage — ${hintWords(x, target, attacker)}`),
    ...hints.dis.map((x) => `Disadvantage — ${hintWords(x, target, attacker)}`),
    ...(hints.penalty ? [`${hints.penalty} from Exhaustion`] : []),
    ...(hints.critOnHit ? [`a hit is a critical hit (${target} is ${hints.critOnHit})`] : []),
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-0.5" data-testid="attack-hints">
      <span role="group" aria-label="Roll with" className="inline-flex gap-1">
        {(["none", "adv", "dis"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => onMode(m)}
            className={`min-h-[var(--touch-min)] rounded-[var(--radius-chip)] border px-2 text-12 font-bold ${mode === m ? "border-brass text-brass-bright" : "border-line text-muted"}`}
          >
            {m === "none" ? "Normal" : m === "adv" ? "Advantage" : "Disadvantage"}
            {m === hints.mode && m !== "none" ? (
              <span className="font-normal text-muted"> · suggested</span>
            ) : null}
          </button>
        ))}
      </span>
      {why.length ? <span className="text-12 text-muted">{why.join(" · ")}</span> : null}
    </div>
  );
}

/**
 * Roll the attack — or enter the d20 rolled at the table (two with advantage or disadvantage): the die says whether
 * it's a natural 20 or 1 (never a typed total, security review M3).
 */
function AttackRoll({ c, t, mode }: { c: CastView; t: CastTargetView; mode: "none" | "adv" | "dis" }) {
  const [entering, setEntering] = useState(false);
  const [dice, setDice] = useState<string[]>([]);
  const first = useRef<HTMLInputElement>(null);
  const count = mode === "none" ? 1 : 2;
  useEffect(() => {
    if (entering) first.current?.focus();
  }, [entering]);
  const faces = dice.slice(0, count).map(Number);
  const ready = faces.length === count && faces.every((n) => Number.isInteger(n) && n >= 1 && n <= 20);
  const send = () => {
    if (!ready) return;
    act(castRoll(c.id, "attack", { targetId: t.key, dice: faces, adv: mode }), "Couldn't enter it");
    setEntering(false);
    setDice([]);
  };
  if (entering)
    return (
      <span className="flex items-center gap-1">
        {Array.from({ length: count }, (_, i) => (
          <input
            key={i}
            ref={i === 0 ? first : undefined}
            aria-label={i === 0 ? "d20 rolled" : "Second d20"}
            placeholder="d20"
            inputMode="numeric"
            value={dice[i] ?? ""}
            onChange={(e) => {
              const next = [...dice];
              next[i] = e.target.value.replace(/\D/g, "").slice(0, 2);
              setDice(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
              if (e.key === "Escape") setEntering(false);
            }}
            className="tabular h-8 w-12 rounded-[var(--radius-control)] border border-line bg-ink-900 text-center text-14 text-bone placeholder:text-fog focus:border-brass focus:outline-none"
          />
        ))}
        <Button size="S" variant="primary" disabled={!ready} onClick={send}>
          Enter
        </Button>
      </span>
    );
  return (
    <span className="flex items-center gap-1">
      <Button
        size="S"
        variant="secondary"
        icon={<D20Icon size={13} />}
        onClick={() => act(castRoll(c.id, "attack", { targetId: t.key, adv: mode }), "Couldn't roll it")}
      >
        Attack
      </Button>
      <Button size="S" variant="ghost" onClick={() => setEntering(true)}>
        Enter…
      </Button>
    </span>
  );
}

/** The final number (§8.13 "final numbers editable"): the computed one until the DM types another. */
function FinalInput({
  c,
  t,
  value,
  edited,
}: {
  c: CastView;
  t: CastTargetView;
  value: number;
  edited: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() === "") act(castSet(c.id, t.key, { final: null }), "Couldn't change it");
    else if (Number.isInteger(n) && n !== value)
      act(castSet(c.id, t.key, { final: n }), "Couldn't change it");
  };
  return (
    <input
      aria-label={`What ${t.name} takes`}
      inputMode="numeric"
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      title={edited ? "Edited by the DM (clear it for the computed number)" : "Computed — type to change it"}
      className={`tabular h-8 w-14 shrink-0 rounded-[var(--radius-control)] border bg-ink-900 text-center text-14 focus:border-brass focus:outline-none ${edited ? "border-brass text-brass-bright" : "border-line text-bone"}`}
    />
  );
}

/** A row's details (DM): full / half / none, its resistances (each toggleable), conditions, its save by hand, Skip. */
function Details({ c, t }: { c: CastView; t: CastTargetView }) {
  const set = (p: Parameters<typeof castSet>[2]) => act(castSet(c.id, t.key, p), "Couldn't change it");
  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-control)] bg-raised/60 p-2 text-13"
      data-testid="cast-details"
    >
      {t.attack?.total !== undefined ? (
        // A critical hit by the DM's word (a feature, an entered total with no die to read, a house rule).
        <label className="inline-flex min-h-[var(--touch-min)] items-center gap-1.5 text-bone">
          <input
            type="checkbox"
            checked={Boolean(t.attack.crit)}
            onChange={(e) => set({ crit: e.target.checked })}
            className="h-4 w-4 accent-[var(--brass-400)]"
          />
          Critical hit
        </label>
      ) : null}
      {c.damage && !c.damage.healing ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="caps text-12 text-fog">Takes</span>
          {(["full", "half", "none"] as const).map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={t.outcome === o}
              onClick={() => set({ outcome: o })}
              className={`min-h-[var(--touch-min)] rounded-[var(--radius-chip)] border px-2 text-12 font-bold ${t.outcome === o ? "border-brass text-brass-bright" : "border-line text-muted"}`}
            >
              {o}
            </button>
          ))}
        </div>
      ) : null}
      {c.damage && !c.damage.healing && (t.adjust.has.resist || t.adjust.has.vuln || t.adjust.has.immune) ? (
        <div className="flex flex-wrap items-center gap-3">
          {(["resist", "vuln", "immune"] as const)
            .filter((k) => t.adjust.has[k])
            .map((k) => (
              <label key={k} className="inline-flex min-h-[var(--touch-min)] items-center gap-1.5 text-bone">
                <input
                  type="checkbox"
                  checked={t.adjust[k]}
                  onChange={(e) => set({ ignore: { [k]: !e.target.checked } })}
                  className="h-4 w-4 accent-[var(--brass-400)]"
                />
                {k === "resist" ? "Resistance" : k === "vuln" ? "Vulnerability" : "Immunity"}
              </label>
            ))}
        </div>
      ) : null}
      {t.conditions.length ? (
        <div className="flex flex-wrap items-center gap-3">
          {t.conditions.map((x) => (
            <label key={x.id} className="inline-flex min-h-[var(--touch-min)] items-center gap-1.5 text-bone">
              <input
                type="checkbox"
                checked={x.on}
                onChange={(e) =>
                  set({
                    // One of a choice's group: ticking it unticks the rest of its group.
                    conditions: t.conditions
                      .filter((y) =>
                        y.id === x.id
                          ? e.target.checked
                          : y.on && !(e.target.checked && x.group && y.group === x.group),
                      )
                      .map((y) => y.id),
                  })
                }
                className="h-4 w-4 accent-[var(--brass-400)]"
              />
              {x.id.charAt(0).toUpperCase() + x.id.slice(1)}
            </label>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {c.save ? (
          <>
            <Button size="S" variant="ghost" onClick={() => set({ saveSuccess: true })}>
              Saved
            </Button>
            <Button size="S" variant="ghost" onClick={() => set({ saveSuccess: false })}>
              Failed
            </Button>
          </>
        ) : null}
        {c.attack ? (
          <>
            <Button size="S" variant="ghost" onClick={() => set({ hit: true })}>
              Hit
            </Button>
            <Button size="S" variant="ghost" onClick={() => set({ hit: false })}>
              Miss
            </Button>
          </>
        ) : null}
        <span className="flex-1" />
        <Button
          size="S"
          variant="ghost"
          onClick={() => act(castTarget(c.id, t.key, false), "Couldn't leave it out")}
        >
          Leave out
        </Button>
        <Button size="S" variant="ghost" onClick={() => act(castSkip(c.id, t.key), "Couldn't skip it")}>
          Skip
        </Button>
        <Button size="S" variant="primary" onClick={() => act(castApply(c.id, [t.key]), "Couldn't apply it")}>
          Apply
        </Button>
      </div>
    </div>
  );
}
