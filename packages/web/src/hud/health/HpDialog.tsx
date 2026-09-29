import { DAMAGE_TYPES } from "@gloam/shared";
import type { HpPreviewRow } from "@gloam/shared/protocol";
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { applyHp, type DamageTypeIn, type HpDraft, PLAYER_DAMAGE_SENT, previewHp } from "../../net/health.ts";
import { useSheets } from "../../net/sheets.ts";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { type UiStore, useUi } from "../../state/ui.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented, Toggle } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast, useToasts } from "../../ui/Toast.tsx";

type Kind = "damage" | "heal" | "temp";
interface Part {
  amount: string;
  type: DamageTypeIn;
}
/** The choice that changes nothing ("Not dead", "Keep dying", "Keep at 0"). */
export const KEEP_CHOICE = "keep";
/**
 * An item decided by its choice alone — one of its choices changes nothing — shows no checkbox beside it (two
 * controls for one decision: critic P7 r1).
 */
export const choiceOnly = (i: { choices?: { id: string }[] }): boolean =>
  Boolean(i.choices?.some((c) => c.id === KEEP_CHOICE));

/** The DM's decisions about what follows, per target: the consequences kept and the choices made. */
export type Decisions = Record<string, { keep: string[]; choices: Record<string, string>; seen: string[] }>;

const num = (s: string) => {
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Damage, healing and temporary HP (SPEC §8.11): typed parts ("12 slashing + 7 fire"), half on a save, a critical hit;
 * a live preview from the server per creature ("Goblin takes 7 → 0 HP; overflow 3") that the DM may edit — what each
 * takes, and what follows (kept or not, and the choice where there is one) — before applying (AC-HP-12). A player
 * sees the numbers of their own creatures only; their damage to others goes to the DM.
 */
export function HpDialog() {
  const d = useUi((s) => s.hpDialog);
  // Each opening is a fresh form (its state starts from what was asked, with no effect racing the first keystroke);
  // the last one stays mounted while the dialog closes.
  const opened = useRef<{ n: number; d: NonNullable<typeof d> } | null>(null);
  if (d && opened.current?.d !== d) opened.current = { n: (opened.current?.n ?? 0) + 1, d };
  const o = opened.current;
  if (!o) return null;
  return <HpForm key={o.n} d={o.d} open={d !== null} />;
}

function HpForm({ d, open }: { d: NonNullable<UiStore["hpDialog"]>; open: boolean }) {
  const me = useTable((s) => s.me);
  const automation = useTable((s) => s.houseRules.automation);
  const dm = me?.role === "dm" || me?.role === "admin";
  // One creature: its name on the board (or its character's), until the preview names it.
  const boardName = useBoard((b) =>
    d.targets.length === 1 ? b.tokens.get(d.targets[0] as string)?.name : undefined,
  );
  const sheetName = useSheets((s) =>
    d.targets.length === 1 ? s.actors.get(d.targets[0] as string)?.sheet.core.name : undefined,
  );
  const [kind, setKind] = useState<Kind>(d.kind);
  const [parts, setParts] = useState<Part[]>([{ amount: d.amount ? String(d.amount) : "", type: "untyped" }]);
  const [amount, setAmount] = useState(d.amount ? String(d.amount) : "");
  const [halved, setHalved] = useState(false);
  const [crit, setCrit] = useState(false);
  const [tempChoice, setTempChoice] = useState<"best" | "keep" | "replace">("best");
  const [totals, setTotals] = useState<Record<string, string>>({});
  const [decisions, setDecisions] = useState<Decisions>({});
  const [rows, setRows] = useState<HpPreviewRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  const draft = useMemo<HpDraft | null>(() => {
    const base = { targets: d.targets, kind };
    if (kind === "damage") {
      const typed = parts
        .filter((p) => num(p.amount) > 0)
        .map((p) => ({ amount: num(p.amount), type: p.type }));
      if (!typed.length) return null;
      const t: Record<string, number> = {};
      for (const [id, v] of Object.entries(totals))
        if (v.trim() !== "" && Number.isFinite(Number(v))) t[id] = Math.max(0, Math.floor(Number(v)));
      return { ...base, parts: typed, halved, crit, ...(dm && Object.keys(t).length ? { totals: t } : {}) };
    }
    if (!num(amount)) return null;
    return { ...base, amount: num(amount), ...(kind === "temp" ? { tempChoice } : {}) };
  }, [d, kind, parts, amount, halved, crit, tempChoice, totals, dm]);

  // The preview, as the numbers are typed (the server's pipeline and the creature's own resistances).
  const key = JSON.stringify(draft);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft's JSON is its identity (a new object each render)
  useEffect(() => {
    if (!draft) {
      setRows(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      previewHp(draft)
        .then((r) => {
          if (!live) return;
          setRows(r);
          // What follows starts as the rules have it: everything kept but a death (the DM ticks that), each choice
          // as the house rule preselects it.
          setDecisions((prev) => {
            const next: Decisions = {};
            for (const row of r) {
              const was = prev[row.tokenId];
              const items = row.items ?? [];
              const known = (k: string) => was?.seen.includes(k) ?? false;
              // An item decided by its choice (one of which changes nothing) is always sent with it; a death starts
              // on its no-change choice here — the DM opts into it (their prompt preselects by the house rule).
              next[row.tokenId] = {
                keep: items
                  .filter(
                    (i) => choiceOnly(i) || (known(i.key) ? was?.keep.includes(i.key) : i.key !== "dying"),
                  )
                  .map((i) => i.key),
                choices: Object.fromEntries(
                  items
                    .filter((i) => i.choice)
                    .map((i) => [
                      i.key,
                      was?.choices[i.key] ?? (i.key === "dying" ? KEEP_CHOICE : (i.choice as string)),
                    ]),
                ),
                seen: items.map((i) => i.key),
              };
            }
            return next;
          });
        })
        .catch(() => {
          if (live) setRows(null);
        });
    }, 140);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [key]);

  const close = () => useUi.getState().set({ hpDialog: null });
  const deciding = dm && automation !== "manual";
  const apply = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const decide: NonNullable<HpDraft["decide"]> = {};
      if (deciding)
        for (const row of rows ?? [])
          if (row.items?.length) {
            const dec = decisions[row.tokenId];
            decide[row.tokenId] = { keep: dec?.keep ?? [], choices: dec?.choices ?? {} };
          }
      const r = await applyHp({ ...draft, ...(Object.keys(decide).length ? { decide } : {}) });
      // Waiting on the DM — replaced by the DM's answer when it comes (net/health.ts).
      if (r.sent)
        useToasts.getState().push({
          kind: "info",
          title: r.sent === 1 ? "Sent to the DM to confirm" : `${r.sent} sent to the DM to confirm`,
          key: PLAYER_DAMAGE_SENT,
        });
      close();
    } catch (e) {
      toast.danger("Couldn't apply that", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const allHidden = rows !== null && rows.length > 0 && rows.every((r) => r.hidden);
  const toDm = rows?.some((r) => r.hidden && r.viaDm);
  const verb = kind === "damage" ? "Apply damage" : kind === "heal" ? "Heal" : "Give temporary HP";
  // Named for whom it's for, as the condition picker is ("Damage — Goblin"); a group by its count.
  const who = d.targets.length === 1 ? (rows?.[0]?.name ?? boardName ?? sheetName ?? null) : null;
  const title = `${{ damage: "Damage", heal: "Healing", temp: "Temporary HP" }[kind]}${who ? ` — ${who}` : ""}`;
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={d.targets.length > 1 ? `${d.targets.length} creatures` : undefined}
      width={560}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!draft} onClick={() => void apply()}>
            {allHidden && toDm ? "Send to the DM" : verb}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        data-testid="hp-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <Segmented
          label="Kind"
          fill
          value={kind}
          onChange={(k) => setKind(k)}
          options={[
            { value: "damage", label: "Damage" },
            { value: "heal", label: "Heal" },
            { value: "temp", label: "Temp HP" },
          ]}
        />
        {kind === "damage" ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="caps mb-1.5 text-12 text-fog">Damage by type</legend>
            {parts.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  ref={i === 0 ? first : undefined}
                  data-autofocus={i === 0 ? true : undefined}
                  aria-label={`Amount ${i + 1}`}
                  inputMode="numeric"
                  value={p.amount}
                  placeholder="0"
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 5);
                    setParts((ps) => ps.map((x, j) => (j === i ? { ...x, amount: v } : x)));
                  }}
                  className="h-11 w-24 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-center text-18 font-bold text-bone focus:border-brass focus:shadow-[var(--ring-focus)] focus:outline-none"
                />
                <select
                  aria-label={`Type ${i + 1}`}
                  value={p.type}
                  onChange={(e) =>
                    setParts((ps) =>
                      ps.map((x, j) => (j === i ? { ...x, type: e.target.value as DamageTypeIn } : x)),
                    )
                  }
                  className="h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-14 capitalize text-bone"
                >
                  <option value="untyped">untyped</option>
                  {DAMAGE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {parts.length > 1 ? (
                  <IconButton
                    label={`Remove part ${i + 1}`}
                    onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
                  >
                    <X size={16} />
                  </IconButton>
                ) : null}
              </div>
            ))}
            <div className="flex">
              <Button
                size="S"
                variant="ghost"
                icon={<Plus size={14} />}
                onClick={() => setParts((ps) => [...ps, { amount: "", type: "fire" }])}
              >
                Another type
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-1">
              <Toggle inline checked={halved} onChange={setHalved} label="Half (a successful save)" />
              <Toggle inline checked={crit} onChange={setCrit} label="Critical hit" />
            </div>
          </fieldset>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="caps text-12 text-fog">{kind === "heal" ? "HP regained" : "Temporary HP"}</span>
            <input
              data-autofocus
              aria-label={kind === "heal" ? "HP regained" : "Temporary HP"}
              inputMode="numeric"
              value={amount}
              placeholder="0"
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 5))}
              className="h-11 w-28 rounded-[var(--radius-control)] border border-line bg-ink-900 px-3 text-center text-18 font-bold text-bone focus:border-brass focus:shadow-[var(--ring-focus)] focus:outline-none"
            />
          </label>
        )}

        {/* The preview, per creature. */}
        {rows?.length ? (
          <ul
            className="flex flex-col divide-y divide-line/60 rounded-[var(--radius-control)] border border-line"
            data-testid="hp-preview"
          >
            {rows.map((r) => (
              <PreviewRow
                key={r.tokenId}
                row={r}
                kind={kind}
                dm={dm}
                deciding={deciding}
                total={totals[r.tokenId] ?? ""}
                onTotal={(v) => setTotals((t) => ({ ...t, [r.tokenId]: v }))}
                decision={decisions[r.tokenId]}
                onDecision={(v) => setDecisions((x) => ({ ...x, [r.tokenId]: v }))}
                tempChoice={tempChoice}
                onTempChoice={setTempChoice}
              />
            ))}
          </ul>
        ) : null}
      </form>
    </Dialog>
  );
}

export function PreviewRow({
  row: r,
  kind,
  dm,
  deciding,
  total,
  onTotal,
  decision,
  onDecision,
  tempChoice,
  onTempChoice,
}: {
  row: HpPreviewRow;
  kind: Kind;
  dm: boolean;
  deciding: boolean;
  total: string;
  onTotal: (v: string) => void;
  decision: Decisions[string] | undefined;
  onDecision: (v: Decisions[string]) => void;
  tempChoice: "best" | "keep" | "replace";
  onTempChoice: (v: "best" | "keep" | "replace") => void;
}) {
  if (r.hidden)
    return (
      <li
        className="flex items-center justify-between gap-3 px-3 py-2 text-14"
        data-testid="hp-preview-row"
        data-token={r.tokenId}
      >
        <span className="font-bold text-bone">{r.name}</span>
        <span className="text-13 text-muted">{r.viaDm ? "The DM confirms it" : "Applied at once"}</span>
      </li>
    );
  const b = r.before as NonNullable<HpPreviewRow["before"]>;
  const a = r.after as NonNullable<HpPreviewRow["after"]>;
  const dmg = r.damage;
  const items = r.items ?? [];
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5" data-testid="hp-preview-row" data-token={r.tokenId}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-14">
        <span className="font-bold text-bone">{r.name}</span>
        {kind === "damage" && dmg ? (
          <span className="text-muted">
            takes{" "}
            {dm ? (
              <input
                aria-label={`${r.name} takes`}
                inputMode="numeric"
                value={total === "" ? String(dmg.total) : total}
                onChange={(e) => onTotal(e.target.value.replace(/\D/g, "").slice(0, 5))}
                className="h-8 w-14 rounded-[var(--radius-control)] border border-line bg-ink-950/70 px-1 text-center text-14 font-bold text-bone focus:border-brass focus:outline-none"
              />
            ) : (
              <strong className="tabular text-bone">{dmg.total}</strong>
            )}
          </span>
        ) : null}
        <span className="tabular text-muted" data-testid="hp-preview-hp">
          {b.hp}
          {b.hpTemp ? <span className="text-[var(--hp-temp)]"> +{b.hpTemp}</span> : null} →{" "}
          <strong className={a.hp === 0 ? "text-danger-text" : "text-bone"}>{a.hp}</strong>
          {a.hpTemp ? <span className="text-[var(--hp-temp)]"> +{a.hpTemp}</span> : null} / {b.hpMax} HP
        </span>
        {dmg?.overflow ? <span className="text-13 text-muted">· overflow {dmg.overflow}</span> : null}
        {dmg?.fromTemp ? <span className="text-13 text-muted">· {dmg.fromTemp} from temp HP</span> : null}
      </div>
      {dmg?.parts.some((p) => p.steps.length) ? (
        <p className="text-13 text-muted">
          {dmg.parts
            .filter((p) => p.steps.length)
            .map(
              (p) =>
                `${p.amount} ${p.type === "untyped" ? "" : p.type} → ${p.applied} (${p.steps.join(", ")})`,
            )
            .join(" · ")}
        </p>
      ) : null}
      {kind === "temp" && r.temp ? (
        <div className="flex flex-col items-start gap-1.5">
          <span className="text-13 text-muted">Temporary HP don't stack — which stays?</span>
          <Segmented
            label="Temporary HP"
            size="S"
            value={tempChoice === "best" ? (r.temp.best === r.temp.current ? "keep" : "replace") : tempChoice}
            onChange={(v) => onTempChoice(v)}
            options={[
              { value: "keep", label: `Keep ${r.temp.current}` },
              { value: "replace", label: `Take ${r.temp.incoming}` },
            ]}
          />
        </div>
      ) : null}
      {items.length ? (
        <div className="flex flex-col gap-1.5" data-testid="hp-follows">
          <span className="caps text-12 text-fog">{deciding ? "What follows" : "Then"}</span>
          {items.map((i) => {
            const kept = decision?.keep.includes(i.key) ?? false;
            const choice = decision?.choices[i.key] ?? i.choice;
            return (
              <div key={i.key} className="flex flex-wrap items-center gap-2 text-14">
                {deciding && choiceOnly(i) ? (
                  <span className="text-bone">{i.label}</span>
                ) : deciding ? (
                  <label className="inline-flex min-h-[var(--touch-min)] items-center gap-2 text-bone">
                    <input
                      type="checkbox"
                      checked={kept}
                      onChange={(e) =>
                        onDecision({
                          keep: e.target.checked
                            ? [...(decision?.keep ?? []), i.key]
                            : (decision?.keep ?? []).filter((k) => k !== i.key),
                          choices: decision?.choices ?? {},
                          seen: decision?.seen ?? [],
                        })
                      }
                      className="h-4 w-4 accent-[var(--brass-400)]"
                    />
                    {i.label}
                  </label>
                ) : (
                  <span className="text-bone">
                    {i.label}
                    {r.asked?.includes(i.key) ? <span className="text-muted"> — the DM decides</span> : null}
                  </span>
                )}
                {deciding && i.choices && (kept || choiceOnly(i)) ? (
                  <Segmented
                    label={i.label}
                    size="S"
                    value={choice ?? (i.choices[0]?.id as string)}
                    onChange={(v) =>
                      onDecision({
                        keep: decision?.keep ?? [],
                        choices: { ...(decision?.choices ?? {}), [i.key]: v },
                        seen: decision?.seen ?? [],
                      })
                    }
                    options={i.choices.map((c) => ({ value: c.id, label: c.label }))}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </li>
  );
}
