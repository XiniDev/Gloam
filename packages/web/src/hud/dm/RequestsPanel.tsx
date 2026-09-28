import { ABILITIES, SKILL_IDS, SKILLS, type SkillId } from "@gloam/shared";
import type { RollRequestView } from "@gloam/shared/protocol";
import { Check, Pencil, SkipForward, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { D20Icon } from "../../icons/dice.tsx";
import {
  answerRequest,
  closeRequest,
  createRequest,
  type RequestDraft,
  useSheets,
} from "../../net/sheets.ts";
import { useBoard } from "../../state/entities.ts";
import { prefersReducedMotion } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented, Select, Toggle } from "../../ui/controls.tsx";
import { TextInput } from "../../ui/Field.tsx";
import { toast } from "../../ui/Toast.tsx";
import { type AbilityKey, abilityName, skillName } from "../sheet/sheetActions.ts";

type Kind = RequestDraft["type"];

interface Candidate {
  id: string;
  name: string;
  party: boolean;
}

/**
 * The creatures a DM can ask: the tokens on the board (party first), and characters with no token here. A character
 * with a token on this board is asked through its token (its roll then belongs to the token).
 */
function useCandidates(): Candidate[] {
  const tokens = useBoard((d) => d.tokens);
  const actors = useSheets((s) => s.actors);
  return useMemo(() => {
    const out: Candidate[] = [];
    const onBoard = new Set<string>();
    for (const t of tokens.values()) {
      if (t.actorId) onBoard.add(t.actorId);
      out.push({ id: t.id, name: t.name, party: t.disposition === "party" });
    }
    for (const a of actors.values())
      if (a.kind === "character" && !onBoard.has(a.id))
        out.push({ id: a.id, name: a.sheet.core.name, party: a.ownerUserId !== null });
    return out.sort((x, y) => Number(y.party) - Number(x.party) || x.name.localeCompare(y.name));
  }, [tokens, actors]);
}

/** A new roll request (SPEC §8.9 Roll requests): who, what, the DC and how the results show. */
function NewRequest() {
  const candidates = useCandidates();
  const incoming = useUi((s) => s.requestTargets);
  const [picked, setPicked] = useState<string[]>([]);
  const [kind, setKind] = useState<Kind>("check");
  const [ability, setAbility] = useState<AbilityKey>("dex");
  const [skill, setSkill] = useState<SkillId | "">("perception");
  const [formula, setFormula] = useState("1d20 + @str + @prof");
  const [label, setLabel] = useState("");
  const [dc, setDc] = useState("");
  const [showDc, setShowDc] = useState(false);
  const [adv, setAdv] = useState<RequestDraft["adv"]>("none");
  const [visibility, setVisibility] = useState<RequestDraft["visibility"]>("public");
  const [busy, setBusy] = useState(false);
  // Asked from the radial menu: those creatures, ready to go.
  useEffect(() => {
    if (!incoming) return;
    setPicked(incoming);
    useUi.getState().set({ requestTargets: null });
  }, [incoming]);
  const known = new Set(candidates.map((c) => c.id));
  const targets = picked.filter((id) => known.has(id));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const dcNum = dc.trim() ? Number(dc) : undefined;
  const dcBad = dcNum !== undefined && (!Number.isInteger(dcNum) || dcNum < 1 || dcNum > 50);
  const send = async () => {
    setBusy(true);
    try {
      await createRequest({
        targets,
        type: kind,
        ...(kind === "check" ? (skill ? { skill } : { ability }) : {}),
        ...(kind === "save" ? { ability } : {}),
        ...(kind === "attack" || kind === "custom" ? { formula: formula.trim() } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(dcNum !== undefined ? { dc: dcNum } : {}),
        showDc,
        adv,
        visibility,
      });
      setPicked([]);
      setLabel("");
    } catch (e) {
      toast.danger("Couldn't ask for that roll", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const selection = useUi((s) => s.selection);
  return (
    <section aria-label="New roll request" className="flex flex-col gap-3" data-testid="new-request">
      <h3 className="caps text-13 text-brass">New request</h3>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="caps text-12 text-fog">Who rolls</span>
          <span className="-mr-1.5 flex text-13">
            <button
              type="button"
              className={QUICK}
              onClick={() => setPicked(candidates.filter((c) => c.party).map((c) => c.id))}
            >
              All party
            </button>
            {selection.length ? (
              <button
                type="button"
                className={QUICK}
                onClick={() => setPicked(selection.filter((id) => known.has(id)))}
              >
                Selected
              </button>
            ) : null}
            {targets.length ? (
              <button
                type="button"
                className={`${QUICK} !text-muted hover:!text-bone`}
                onClick={() => setPicked([])}
              >
                None
              </button>
            ) : null}
          </span>
        </div>
        {candidates.length === 0 ? (
          <p className="text-13 text-muted">No creatures yet — place tokens or create characters.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Creatures">
            {candidates.map((c) => {
              const on = targets.includes(c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(c.id)}
                    // Picked: the brass hairline with its 2-px glow and a check (§27.4 selected).
                    className={`inline-flex h-8 min-h-[var(--touch-min)] items-center gap-1 rounded-chip border px-2.5 text-13 transition-[color,border-color,box-shadow] duration-[var(--dur-fast)] ${
                      on
                        ? "border-brass bg-[var(--glow-brass-soft)] text-brass-bright shadow-[0_0_0_2px_var(--glow-brass-soft)]"
                        : "border-line text-muted hover:border-line-strong hover:text-bone"
                    }`}
                  >
                    {on ? <Check size={13} aria-hidden className="-ml-0.5" /> : null}
                    {c.name}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Caption text="What to roll">
        <Segmented
          label="What to roll"
          value={kind}
          onChange={setKind}
          fill
          size="S"
          options={[
            { value: "check", label: "Check" },
            { value: "save", label: "Save" },
            { value: "attack", label: "Attack" },
            { value: "custom", label: "Custom" },
          ]}
        />
      </Caption>
      {kind === "check" ? (
        <div className="grid grid-cols-2 gap-2">
          <Select
            label="Skill"
            value={skill}
            onChange={(v) => setSkill(v as SkillId | "")}
            options={[
              { value: "", label: "No skill" },
              ...SKILL_IDS.map((s) => ({
                value: s,
                label: `${skillName(s)} (${SKILLS[s].toUpperCase()})`,
              })),
            ]}
          />
          {skill ? null : (
            <Select
              label="Ability"
              value={ability}
              onChange={(v) => setAbility(v as AbilityKey)}
              options={ABILITIES.map((a) => ({ value: a, label: abilityName(a as AbilityKey) }))}
            />
          )}
        </div>
      ) : kind === "save" ? (
        <Select
          label="Saving throw"
          value={ability}
          onChange={(v) => setAbility(v as AbilityKey)}
          options={ABILITIES.map((a) => ({ value: a, label: abilityName(a as AbilityKey) }))}
        />
      ) : (
        <TextInput
          label="Formula"
          mono
          value={formula}
          maxLength={200}
          onChange={(e) => setFormula(e.target.value)}
          help="@ references come from each creature's sheet."
        />
      )}
      <TextInput
        label="Label (optional)"
        value={label}
        maxLength={80}
        placeholder={`Auto: ${autoLabel(kind, ability, skill)}`}
        onChange={(e) => setLabel(e.target.value)}
      />
      <div className="grid grid-cols-[5rem_1fr] items-end gap-3">
        <TextInput
          label="DC"
          inputMode="numeric"
          value={dc}
          placeholder="—"
          error={dcBad ? "1–50" : null}
          onChange={(e) => setDc(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
        />
        {dcNum !== undefined ? (
          <Toggle
            checked={showDc}
            onChange={setShowDc}
            label="Show the DC to players"
            description="Hidden, they see only their roll; you see each against it."
          />
        ) : (
          <p className="pb-3 text-13 text-muted">No DC: you judge each result.</p>
        )}
      </div>
      <Caption text="Roll with">
        <Segmented
          label="Roll with"
          value={adv}
          onChange={setAdv}
          fill
          size="S"
          options={[
            { value: "none", label: "Normal" },
            { value: "adv", label: "Advantage" },
            { value: "dis", label: "Disadvantage" },
          ]}
        />
      </Caption>
      <Caption text="Who sees the result">
        <Segmented
          label="Who sees the result"
          value={visibility}
          onChange={setVisibility}
          fill
          size="S"
          options={[
            { value: "public", label: "Public", hint: "Everyone sees each result" },
            { value: "dm", label: "Private to DM", hint: "Only you and the roller see it" },
            { value: "blind", label: "Blind", hint: "They roll, only you see the number" },
          ]}
        />
      </Caption>
      <Button
        variant="primary"
        icon={<D20Icon size={16} />}
        loading={busy}
        disabled={!targets.length || dcBad || ((kind === "attack" || kind === "custom") && !formula.trim())}
        onClick={() => void send()}
      >
        {targets.length
          ? `Ask ${targets.length === 1 ? "1 creature" : `${targets.length} creatures`}`
          : "Pick who rolls"}
      </Button>
    </section>
  );
}

/** A caption over a control (the segmented controls carry no visible label of their own). */
/** The request form's quick picks: text buttons with a full touch target. */
const QUICK =
  "inline-flex min-h-8 min-w-[var(--touch-min)] items-center justify-center rounded-[var(--radius-control)] px-1.5 text-brass hover:bg-raised hover:text-brass-bright pointer-coarse:min-h-[var(--touch-min)] max-sm:min-h-[var(--touch-min)]";

/** What a request is called when the DM names it nothing (as the server names it). */
function autoLabel(kind: Kind, ability: AbilityKey, skill: SkillId | ""): string {
  if (kind === "save") return `${abilityName(ability)} save`;
  if (kind === "check") return skill ? `${skillName(skill)} check` : `${abilityName(ability)} check`;
  return kind === "attack" ? "Attack" : "Roll";
}

function Caption({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="caps text-12 text-fog" aria-hidden>
        {text}
      </span>
      {children}
    </div>
  );
}

const STATE_WORD: Record<string, string> = {
  pending: "waiting",
  rolled: "rolled",
  manual: "entered",
  skipped: "skipped",
  dm: "by you",
};

function Row({ r, t }: { r: RollRequestView; t: RollRequestView["targets"][number] }) {
  const res = r.responses[t.id] ?? { state: "pending" as const };
  const [setting, setSetting] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (action: "roll" | "set" | "skip", total?: number) => {
    setBusy(true);
    try {
      await answerRequest(r.id, t.id, action, total);
      setSetting(false);
      setValue("");
    } catch (e) {
      toast.danger("Couldn't do that", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pending = res.state === "pending";
  const outcome = res.success === undefined ? "text-bone" : res.success ? "text-success" : "text-danger-text";
  return (
    <li
      className="flex flex-col gap-1 border-t border-line/60 py-1.5"
      data-target={t.id}
      data-state={res.state}
      data-testid="request-row"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-14 text-bone">{t.name}</span>
          <span className="mono block truncate text-12 text-fog">
            {t.formula}
            {t.controllers.length ? "" : " · yours to roll"}
          </span>
        </span>
        {pending ? (
          <span className="caps text-12 text-fog">{STATE_WORD.pending}</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="caps text-12 text-fog">{STATE_WORD[res.state]}</span>
            {res.total !== undefined ? (
              <span className={`tabular text-18 font-bold ${outcome}`} data-testid="request-total">
                {res.total}
              </span>
            ) : null}
            {res.success !== undefined ? (
              <span className={`caps text-12 ${outcome}`}>{res.success ? "pass" : "fail"}</span>
            ) : null}
            {setting ? null : (
              <IconButton label="Change the result" onClick={() => setSetting(true)}>
                <Pencil size={15} />
              </IconButton>
            )}
          </span>
        )}
      </div>
      {setting ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(value);
            if (value.trim() && Number.isInteger(n)) void act("set", n);
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: opened by the DM's own click to type the result
            autoFocus
            aria-label={`${t.name}'s result`}
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9-]/g, "").slice(0, 5))}
            className="tabular h-8 min-h-[var(--touch-min)] w-20 rounded-[var(--radius-control)] border border-line bg-ink-950/60 px-2 text-14 text-bone focus:border-accent focus:outline-none"
          />
          <IconButton label="Set the result" type="submit" disabled={busy || !value.trim()}>
            <Check size={16} />
          </IconButton>
          <IconButton label="Cancel" onClick={() => setSetting(false)}>
            <X size={16} />
          </IconButton>
        </form>
      ) : pending ? (
        // A creature still to roll: its actions on one row under it (answered ones change their result inline).
        <div className="flex flex-wrap gap-1.5">
          <Button size="S" variant="secondary" loading={busy} onClick={() => void act("roll")}>
            {t.controllers.length ? "Roll for them" : "Roll"}
          </Button>
          <Button size="S" variant="ghost" icon={<Pencil size={14} />} onClick={() => setSetting(true)}>
            Set
          </Button>
          <Button size="S" variant="ghost" icon={<SkipForward size={14} />} onClick={() => void act("skip")}>
            Skip
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** One open request on the live board: each creature's state and result against the DC. */
function Board({ r }: { r: RollRequestView }) {
  const [busy, setBusy] = useState(false);
  const answered = r.targets.filter((t) => (r.responses[t.id]?.state ?? "pending") !== "pending").length;
  const passed = r.targets.filter((t) => r.responses[t.id]?.success === true).length;
  const npcs = r.targets.filter(
    (t) => !t.controllers.length && (r.responses[t.id]?.state ?? "pending") === "pending",
  );
  const rollNpcs = async () => {
    setBusy(true);
    try {
      for (const t of npcs) await answerRequest(r.id, t.id, "roll");
    } catch (e) {
      toast.danger("Couldn't roll them all", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const meta = [
    r.dc !== undefined ? `DC ${r.dc}${r.showDc ? "" : " (hidden)"}` : null,
    r.adv === "adv" ? "advantage" : r.adv === "dis" ? "disadvantage" : null,
    r.visibility === "blind" ? "blind" : r.visibility === "dm" ? "private" : null,
  ].filter(Boolean);
  return (
    <li
      className="flex flex-col gap-1 rounded-[var(--radius-panel)] border border-line p-3"
      data-request={r.id}
      data-testid="request-board"
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-16 font-bold text-bone">{r.label}</span>
          <span className="block text-12 text-muted">
            {[
              ...meta,
              `${answered} of ${r.targets.length} in${r.dc !== undefined ? ` · ${passed} passed` : ""}`,
            ].join(" · ")}
          </span>
        </span>
        <IconButton label="Close the request" onClick={() => void closeRequest(r.id)}>
          <X size={16} />
        </IconButton>
      </div>
      <ul className="flex flex-col">
        {r.targets.map((t) => (
          <Row key={t.id} r={r} t={t} />
        ))}
      </ul>
      {npcs.length > 1 ? (
        <Button
          size="S"
          variant="secondary"
          icon={<D20Icon size={14} />}
          loading={busy}
          onClick={() => void rollNpcs()}
        >
          Roll the {npcs.length} that are yours
        </Button>
      ) : null}
    </li>
  );
}

/** DM panel → Requests (SPEC §8.3, §8.9; AC-DICE-06): a new roll request, and the open requests' live board. */
export function RequestsPanel() {
  const requests = useSheets((s) => s.requests);
  const open = useMemo(
    () => [...requests.values()].filter((r) => r.status === "open").sort((a, b) => b.createdAt - a.createdAt),
    [requests],
  );
  // A request just asked comes into view at the top (on a phone the form had scrolled it away).
  const scroller = useRef<HTMLDivElement>(null);
  const newest = open[0]?.id;
  const seen = useRef(newest);
  useEffect(() => {
    if (!newest || newest === seen.current) return;
    seen.current = newest;
    scroller.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [newest]);
  return (
    <div
      ref={scroller}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-clip px-3 py-3"
    >
      {open.length ? (
        <section aria-label="Open requests" className="flex flex-col gap-2">
          <h3 className="caps text-12 text-fog">Open</h3>
          <ul className="flex flex-col gap-2">
            {open.map((r) => (
              <Board key={r.id} r={r} />
            ))}
          </ul>
        </section>
      ) : null}
      {open.length ? <div className="engraved-divider mx-6 my-1" aria-hidden /> : null}
      <NewRequest />
    </div>
  );
}
