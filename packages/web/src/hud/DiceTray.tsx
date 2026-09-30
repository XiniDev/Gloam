import type { RollVisibility } from "@gloam/shared/dice";
import { checkFormula, parseFormula } from "@gloam/shared/dice";
import { Minus, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addDie,
  advOf,
  countOf,
  modifierOf,
  REFS,
  refAt,
  removeDie,
  setAdv,
  stepCount,
  stepModifier,
  tokenize,
} from "../dice/formulaEdit.ts";
import { D20Icon, HandDieIcon, PinGlyph } from "../icons/dice.tsx";
import { enterManual, rollDice } from "../net/dice.ts";
import { useTable } from "../net/table.ts";
import { useBoard } from "../state/entities.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { BottomSheet } from "../ui/BottomSheet.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Segmented, Toggle } from "../ui/controls.tsx";
import { BrassPin } from "../ui/ornaments.tsx";
import { ScrollFade } from "../ui/ScrollFade.tsx";
import { toast } from "../ui/Toast.tsx";
import { underTopBar, useBoardCovers, useHudInsets, useIsPhone, useObstacle } from "./insets.ts";

const QUICK = [4, 6, 8, 10, 12, 20, "%"] as const;

/** A player's last formulas and pinned macros, per user on this device (SPEC §8.9 chips). */
interface Saved {
  recent: { formula: string; label?: string }[];
  pinned: { formula: string; label?: string }[];
}
const keyOf = (userId: string) => `gloam.dice.${userId}`;
function loadSaved(userId: string): Saved {
  try {
    const raw = globalThis.localStorage?.getItem(keyOf(userId));
    const s = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
    return { recent: (s.recent ?? []).slice(0, 10), pinned: (s.pinned ?? []).slice(0, 12) };
  } catch {
    return { recent: [], pinned: [] };
  }
}
function storeSaved(userId: string, s: Saved): void {
  try {
    globalThis.localStorage?.setItem(keyOf(userId), JSON.stringify(s));
  } catch {
    // blocked storage: chips last for this page
  }
}

/**
 * The dice tray (SPEC §8.9; hotkey D; a bottom sheet on phones): quick dice (click adds, right-click removes), count
 * and modifier steppers, advantage/disadvantage, the formula with highlighting, `@` completion and inline errors, a
 * label, who sees it, Roll, and "I rolled physically…" for a real die. The server rolls; the dice tumble on everyone's
 * screen. Rolling closes the tray so the dice have the board (a tray over the middle of the screen would leave them a
 * sliver beside it) — what's in it is kept, so D and Enter roll it again — unless it's pinned open, when the dice come
 * to rest clear of it.
 */
export function DiceTray() {
  const open = useUi((s) => s.diceTray);
  const me = useTable((s) => s.me);
  const phone = useIsPhone();
  if (!open || !me) return null;
  const dm = me.role === "dm" || me.role === "admin";
  const close = () => useUi.getState().set({ diceTray: false });
  const rolled = () => {
    if (!useSettings.getState().diceTrayKeepOpen) close();
  };
  if (phone) return <PhoneTray userId={me.userId} dm={dm} onClose={close} onRolled={rolled} />;
  return <DesktopTray userId={me.userId} dm={dm} onClose={close} onRolled={rolled} />;
}

function PhoneTray({
  userId,
  dm,
  onClose,
  onRolled,
}: {
  userId: string;
  dm: boolean;
  onClose: () => void;
  onRolled: () => void;
}) {
  // Roll stays in view under the scrolling tray, at any height.
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  return (
    <BottomSheet
      label="Dice tray"
      testId="dice-tray"
      initialSnap={1}
      footer={<div ref={setActions} />}
      header={
        <header className="flex w-full items-center gap-2 pb-1 pl-1">
          <D20Icon size={18} className="text-brass" />
          <h2 className="caps text-13 text-bone">Dice</h2>
          <span className="ml-auto" />
          <KeepOpen />
          <IconButton label="Close the tray" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
      }
    >
      <TrayBody userId={userId} dm={dm} onRolled={onRolled} actionsIn={actions} />
    </BottomSheet>
  );
}

/** Keeps the tray open after rolling (for a run of rolls), remembered on this device. */
function KeepOpen() {
  const keep = useSettings((s) => s.diceTrayKeepOpen);
  return (
    <span title="The tray stays open after rolling (it closes by default, so the dice have the board)">
      <Toggle
        compact
        label="Keep open"
        checked={keep}
        onChange={(v) => useSettings.getState().update({ diceTrayKeepOpen: v })}
      />
    </span>
  );
}

/** The narrowest the tray lays out in (its dice four to a row, its steppers one above the other). */
const TRAY_MIN_PX = 300;
/** The room the board's covers keep round what they measure (insets.ts). */
const COVER_GAP_PX = 4;

/** The window's width, kept current as it changes. */
function useViewportWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

function DesktopTray({
  userId,
  dm,
  onClose,
  onRolled,
}: {
  userId: string;
  dm: boolean;
  onClose: () => void;
  onRolled: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // The dice come to rest clear of it.
  useObstacle("tray", ref);
  // Kept open for a run of rolls, it stands beside the dock rather than over the middle of the board, where the dice
  // come to rest.
  const keep = useSettings((s) => s.diceTrayKeepOpen);
  // In the board's free part: beside the tool column and short of an open panel (it stood over the sheet's buttons),
  // under the top bar, above the dice button — scrolling inside when a short screen (a phone on its side) can't hold it.
  const left = useHudInsets((s) => s.left);
  const right = useHudInsets((s) => s.right);
  const top = useHudInsets((s) => s.banner + s.tracker);
  const width = useViewportWidth();
  // A tablet with a panel open can leave less of the board than the tray needs: it takes the panel's place while it's
  // open (the panel is as it was when it closes) rather than squeezing into the gap or lying across the panel's buttons.
  const panel = useBoardCovers((s) => s.rects["dock-panel"]);
  const inPanel = panel && width - left - right < TRAY_MIN_PX;
  // In the panel's place, the panel steps out of sight and its rail button lets go (Dock): the tray takes only the
  // height it needs, over nothing it half-hides (critic RSP-01 r1: 450 px of empty ink, the rail still on "DM").
  useEffect(() => {
    useUi.getState().set({ trayInPanel: Boolean(inPanel) });
    return () => useUi.getState().set({ trayInPanel: false });
  }, [inPanel]);
  // Roll stays in view under the scrolling body, at any height (critic RSP-01 r1: off the screen at 844 × 390).
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const box = inPanel
    ? {
        left: panel.left + COVER_GAP_PX,
        top: panel.top + COVER_GAP_PX,
        right: width - panel.right + COVER_GAP_PX,
        bottom: window.innerHeight - panel.bottom + COVER_GAP_PX,
      }
    : { left, right, top: underTopBar(top), bottom: 76 };
  return (
    <div
      className={`pointer-events-none absolute z-40 flex ${inPanel ? "items-start" : "items-end"} ${keep ? "justify-end" : "justify-center"}`}
      style={box}
    >
      <section
        ref={ref}
        aria-label="Dice tray"
        data-testid="dice-tray"
        data-in-panel={inPanel ? "true" : undefined}
        className={`panel pointer-events-auto flex max-h-full min-h-0 w-full flex-col gap-3 p-3 ${inPanel ? "" : "max-w-[520px]"}`}
      >
        <header className="flex items-center gap-2">
          <D20Icon size={18} className="text-brass" />
          <h2 className="caps text-13 text-bone">Dice</h2>
          <span className="ml-auto" />
          <KeepOpen />
          <IconButton label="Close the tray" shortcut="Esc" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <ScrollFade outerClassName="min-h-0" className="flex flex-col [scrollbar-width:thin]">
          <TrayBody userId={userId} dm={dm} onRolled={onRolled} actionsIn={actions} />
        </ScrollFade>
        <div ref={setActions} className="shrink-0" />
      </section>
    </div>
  );
}

function TrayBody({
  userId,
  dm,
  onRolled,
  actionsIn,
}: {
  userId: string;
  dm: boolean;
  onRolled?: () => void;
  /** Where the Roll row goes (a sheet's footer); in the tray otherwise. */
  actionsIn?: HTMLElement | null;
}) {
  const draft = useUi((s) => s.diceDraft);
  const { formula, label, visibility } = draft;
  const setDraft = (p: Partial<typeof draft>) =>
    useUi.getState().set({ diceDraft: { ...useUi.getState().diceDraft, ...p } });
  const setFormula = (f: string | ((f: string) => string)) =>
    setDraft({ formula: typeof f === "function" ? f(useUi.getState().diceDraft.formula) : f });
  const setLabel = (l: string) => setDraft({ label: l });
  const setVisibility = (v: RollVisibility) => setDraft({ visibility: v });
  // Opened for a physical roll (a sheet's long-press menu): straight to entering what landed.
  const [manual, setManual] = useState(() => useUi.getState().diceDraft.manual === true);
  useEffect(() => {
    const d = useUi.getState().diceDraft;
    if (d.manual) useUi.getState().set({ diceDraft: { ...d, manual: false } });
  }, []);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(() => loadSaved(userId));
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const error = formula.trim() ? checkFormula(formula) : null;
  const adv = advOf(formula);
  const count = countOf(formula);
  // The selected token the roller controls: its numbers answer `@` references.
  const selected = useUi((s) => (s.selection.length === 1 ? s.selection[0] : undefined));
  const token = useBoard((d) => (selected ? d.tokens.get(selected) : undefined));
  const tokenId = token && (dm || token.ownerIds.includes(userId)) ? token.id : undefined;

  useEffect(() => {
    // (Without scrolling to it: a short tray opens at its top, the dice first — it opened half-way down.)
    input.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useUi.getState().set({ diceTray: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const remember = (f: string, l: string) => {
    const entry = l ? { formula: f, label: l } : { formula: f };
    const next = {
      ...saved,
      recent: [entry, ...saved.recent.filter((r) => r.formula !== f || r.label !== entry.label)].slice(0, 10),
    };
    setSaved(next);
    storeSaved(userId, next);
  };

  const roll = async () => {
    if (!formula.trim() || error || busy) return;
    setBusy(true);
    try {
      await rollDice({
        formula: formula.trim(),
        visibility,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(tokenId ? { tokenId } : {}),
      });
      remember(formula.trim(), label.trim());
      onRolled?.();
    } catch (e) {
      toast.danger("Couldn't roll", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pinned = saved.pinned.some((p) => p.formula === formula.trim() && (p.label ?? "") === label.trim());
  const togglePin = () => {
    const f = formula.trim();
    if (!f || error) return;
    const l = label.trim();
    const next = {
      ...saved,
      pinned: pinned
        ? saved.pinned.filter((p) => !(p.formula === f && (p.label ?? "") === l))
        : [...saved.pinned, l ? { formula: f, label: l } : { formula: f }].slice(-12),
    };
    setSaved(next);
    storeSaved(userId, next);
  };

  const actions = (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="S"
        icon={<HandDieIcon size={16} />}
        disabled={!formula.trim() || error !== null}
        onClick={() => setManual(true)}
      >
        I rolled physically…
      </Button>
      <span className="ml-auto" />
      <Button
        variant="primary"
        loading={busy}
        disabled={!formula.trim() || error !== null}
        onClick={() => void roll()}
      >
        Roll
      </Button>
    </div>
  );

  const ref = refAt(formula, caret);
  const suggestions = ref
    ? REFS.filter((r) => r.ref.startsWith(ref.text.toLowerCase()) && r.ref !== ref.text)
    : [];

  return (
    // Laid out by its own width (a panel's column, a phone, the board's free part): below 330 px the dice go four to a
    // row and the steppers one above the other — squeezed side by side, a stepper's + ran into the next one's −.
    <div className="@container flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-1 @[330px]:grid-cols-7" role="group" aria-label="Quick dice">
        {QUICK.map((s) => (
          <button
            key={s}
            type="button"
            className="tabular h-9 min-h-[var(--touch-min)] min-w-0 rounded-[var(--radius-control)] border border-line bg-ink-900 px-1 text-13 font-bold text-bone hover:border-brass hover:text-brass-bright"
            aria-label={`Add a d${s === "%" ? "100" : s} (right-click removes one)`}
            onClick={() => setFormula((f) => addDie(f, s))}
            onContextMenu={(e) => {
              e.preventDefault();
              setFormula((f) => removeDie(f, s));
            }}
          >
            d{s === "%" ? "100" : s}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 @[330px]:grid-cols-2">
        <Stepper
          label="Dice"
          disabled={count === null}
          onMinus={() => setFormula((f) => stepCount(f, -1))}
          onPlus={() => setFormula((f) => stepCount(f, 1))}
        >
          {count ? `${count.count} × ${count.die}` : "—"}
        </Stepper>
        <Stepper
          label="Modifier"
          onMinus={() => setFormula((f) => stepModifier(f, -1))}
          onPlus={() => setFormula((f) => stepModifier(f, 1))}
        >
          {modifierOf(formula) >= 0 ? `+${modifierOf(formula)}` : modifierOf(formula)}
        </Stepper>
      </div>
      <Segmented
        label="Advantage"
        size="S"
        fill
        value={adv ?? "none"}
        onChange={(v) => setFormula((f) => setAdv(f, v === "none" ? null : v))}
        options={[
          { value: "none", label: "Normal" },
          { value: "adv", label: "Advantage" },
          { value: "dis", label: "Disadvantage" },
        ]}
      />

      <div className="relative flex flex-col gap-1">
        <label className="sr-only" htmlFor="dice-formula">
          Formula
        </label>
        <div className="relative">
          <Highlight formula={formula} error={error ? { at: error.at, end: error.end } : null} />
          <input
            id="dice-formula"
            ref={input}
            data-testid="dice-formula"
            value={formula}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setFormula(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (suggestions[0] && ref) {
                  const f = `${formula.slice(0, ref.start)}${suggestions[0].ref}${formula.slice(caret)}`;
                  setFormula(f);
                  setCaret(ref.start + (suggestions[0].ref.length as number));
                } else void roll();
              }
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "dice-formula-error" : undefined}
            className={`mono relative h-10 min-h-[var(--touch-min)] w-full rounded-[var(--radius-control)] border bg-transparent px-3 text-16 text-transparent caret-[var(--bone-100)] focus:outline-none ${error ? "border-[var(--danger-text)]" : "border-line focus:border-brass"}`}
          />
        </div>
        {suggestions.length > 0 ? (
          <ul className="panel absolute top-11 left-2 z-10 flex flex-col py-1" aria-label="References">
            {suggestions.slice(0, 6).map((s) => (
              <li key={s.ref}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-ink-800"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (!ref) return;
                    setFormula(`${formula.slice(0, ref.start)}${s.ref}${formula.slice(caret)}`);
                    input.current?.focus();
                  }}
                >
                  <span className="mono text-13 text-arcane">{s.ref}</span>
                  <span className="text-12 text-muted">{s.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p
            id="dice-formula-error"
            data-testid="dice-formula-error"
            className="text-12 text-danger-text"
            role="alert"
          >
            {error.message}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Label"
          placeholder="Label — Perception, Longsword…"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          className="h-9 min-h-[var(--touch-min)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-14 text-bone placeholder:text-faint focus:border-brass focus:outline-none"
        />
        <IconButton label={pinned ? "Unpin this roll" : "Pin this roll"} active={pinned} onClick={togglePin}>
          <PinGlyph size={17} />
        </IconButton>
      </div>

      <Segmented
        label="Who sees it"
        size="S"
        fill
        value={visibility}
        onChange={setVisibility}
        options={
          dm
            ? [
                { value: "public", label: "Public" },
                { value: "dm", label: "Private", hint: "Only DMs see it; players see “The DM rolls…”" },
              ]
            : [
                { value: "public", label: "Public" },
                { value: "dm", label: "Private to DM" },
                { value: "self", label: "Self" },
              ]
        }
      />

      {saved.pinned.length || saved.recent.length ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Your rolls">
          {[
            ...saved.pinned.map((p) => ({ ...p, pin: true })),
            ...saved.recent.map((p) => ({ ...p, pin: false })),
          ]
            .filter((c, i, all) => all.findIndex((o) => o.formula === c.formula && o.label === c.label) === i)
            .slice(0, 14)
            .map((c) => (
              <button
                key={`${c.pin ? "p" : "r"}:${c.formula}:${c.label ?? ""}`}
                type="button"
                data-testid="dice-chip"
                onClick={() => {
                  setFormula(c.formula);
                  setLabel(c.label ?? "");
                }}
                className={`flex h-7 min-h-[var(--touch-min)] items-center gap-1 rounded-chip border px-2.5 text-12 ${c.pin ? "border-brass-deep text-brass-bright" : "border-line text-muted"} hover:text-bone`}
              >
                {c.pin ? <BrassPin size={12} /> : null}
                <span className="mono">{c.label ? `${c.label} · ${c.formula}` : c.formula}</span>
              </button>
            ))}
        </div>
      ) : null}

      {manual ? (
        <ManualEntry
          formula={formula}
          label={label}
          visibility={visibility}
          onDone={() => {
            remember(formula.trim(), label.trim());
            setManual(false);
            onRolled?.();
          }}
          onCancel={() => setManual(false)}
        />
      ) : actionsIn ? (
        createPortal(actions, actionsIn)
      ) : (
        actions
      )}
    </div>
  );
}

function Stepper({
  label,
  children,
  onMinus,
  onPlus,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onMinus: () => void;
  onPlus: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1" role="group" aria-label={label}>
      <span className="caps text-12 text-fog">{label}</span>
      <div className="flex items-center gap-1 rounded-[var(--radius-control)] border border-line bg-ink-900">
        <IconButton label={`${label} down`} onClick={onMinus} disabled={disabled}>
          <Minus size={14} />
        </IconButton>
        <span
          className={`tabular min-w-[3ch] flex-1 whitespace-nowrap text-center text-13 font-bold ${disabled ? "text-faint" : "text-bone"}`}
        >
          {children}
        </span>
        <IconButton label={`${label} up`} onClick={onPlus} disabled={disabled}>
          <Plus size={14} />
        </IconButton>
      </div>
    </div>
  );
}

const KIND_CLASS: Record<string, string> = {
  dice: "text-brass-bright",
  number: "text-bone",
  op: "text-muted",
  ref: "text-arcane",
  tag: "text-ember",
  keyword: "text-verdigris",
  space: "",
  other: "text-danger-text",
};

/** The formula's colours, under a transparent input (the input keeps the caret, selection and typing). */
function Highlight({ formula, error }: { formula: string; error: { at: number; end: number } | null }) {
  const pieces = useMemo(() => tokenize(formula), [formula]);
  return (
    <div
      aria-hidden
      className="mono pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre rounded-[var(--radius-control)] bg-ink-900 px-3 text-16"
    >
      {pieces.map((p) => {
        const bad = error && p.at < error.end && p.at + p.text.length > error.at;
        return (
          <span
            key={`${p.at}`}
            className={`${KIND_CLASS[p.kind]} ${bad ? "underline decoration-[var(--danger-text)] decoration-wavy" : ""}`}
          >
            {p.text}
          </span>
        );
      })}
    </div>
  );
}

/** "I rolled physically…" (AC-DICE-05): one field per die of the formula, in order — or just the total. */
function ManualEntry({
  formula,
  label,
  visibility,
  onDone,
  onCancel,
}: {
  formula: string;
  label: string;
  visibility: RollVisibility;
  onDone: () => void;
  onCancel: () => void;
}) {
  // The dice a formula rolls, in order (the counts a hand-rolled formula has as literals).
  const dice = useMemo(() => {
    try {
      const out: number[] = [];
      const walk = (n: ReturnType<typeof parseFormula>["expr"]): void => {
        if (n.k === "dice") {
          const count = n.count.k === "num" ? n.count.v : 0;
          for (let i = 0; i < count; i++) out.push(n.sides);
        } else if (n.k === "bin") {
          walk(n.a);
          walk(n.b);
        } else if (n.k === "neg" || n.k === "group") walk(n.x);
      };
      const p = parseFormula(formula);
      walk(p.expr);
      if (p.adv) out.push(20);
      return out.length <= 20 ? out : null;
    } catch {
      return null;
    }
  }, [formula]);
  const [values, setValues] = useState<string[]>(() => (dice ?? []).map(() => ""));
  const [total, setTotal] = useState("");
  const [busy, setBusy] = useState(false);
  const byDie =
    dice !== null &&
    values.every((v, i) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= (dice[i] as number));
  const byTotal = /^-?\d+$/.test(total.trim());
  const submit = async () => {
    if (busy || (!byDie && !byTotal)) return;
    setBusy(true);
    try {
      await enterManual({
        formula: formula.trim(),
        visibility,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(byTotal && total.trim() ? { total: Number(total) } : { values: values.map(Number) }),
      });
      onDone();
    } catch (e) {
      toast.danger("Couldn't record that", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-testid="manual-entry"
      className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line p-2"
    >
      <p className="text-12 text-muted">Enter each die as it landed — or just the total.</p>
      {dice?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {dice.map((sides, i) => (
            <input
              key={i}
              aria-label={`Die ${i + 1} (d${sides})`}
              inputMode="numeric"
              value={values[i] ?? ""}
              onChange={(e) =>
                setValues((v) => v.map((x, k) => (k === i ? e.target.value.replace(/\D/g, "") : x)))
              }
              placeholder={`d${sides}`}
              className="tabular h-9 min-h-[var(--touch-min)] w-14 rounded-[var(--radius-control)] border border-line bg-ink-900 px-2 text-center text-14 text-bone placeholder:text-faint"
            />
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          aria-label="Total"
          inputMode="numeric"
          value={total}
          onChange={(e) => setTotal(e.target.value.replace(/[^\d-]/g, ""))}
          placeholder="Total"
          className="tabular h-9 min-h-[var(--touch-min)] w-24 rounded-[var(--radius-control)] border border-line bg-ink-900 px-2 text-14 text-bone placeholder:text-faint"
        />
        <span className="ml-auto" />
        <Button variant="ghost" size="S" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="S"
          loading={busy}
          disabled={!byDie && !byTotal}
          onClick={() => void submit()}
        >
          Record roll
        </Button>
      </div>
    </div>
  );
}
