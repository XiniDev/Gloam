import type { DmPromptView, HpPreviewRow } from "@gloam/shared/protocol";
import { ChevronUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { previewHp, resolvePrompt, useHealth } from "../../net/health.ts";
import { useTable } from "../../net/table.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { WaxSeal } from "../../ui/ornaments.tsx";
import { toast } from "../../ui/Toast.tsx";
import { keepHyphenated } from "../../ui/text.tsx";
import { choiceOnly, type Decisions, PreviewRow } from "./HpDialog.tsx";

/**
 * The DM's prompts (SPEC §8.11, §19.1; AC-HP-12): what follows from damage or a condition — going down, a death-save
 * failure, an NPC at 0 HP (Dead / Unconscious / Keep at 0, the house rule's choice first), "Mark dead?", concentration
 * ending — each thing ticked to apply (or not) with its choice, then Apply or Skip; and a player's damage to check,
 * with the preview and what it takes editable. Over the free board like the players' roll cards; in a phone's open
 * panel, one-line strips.
 */
export function PromptCards() {
  const list = usePromptList();
  if (!list.length) return null;
  return (
    <ol
      aria-label="Decisions waiting for you"
      className="pointer-events-none mx-auto flex w-full max-w-[380px] flex-col gap-2 px-2 pt-2"
    >
      {list.map((p) => (
        <PromptCard key={p.id} p={p} compact />
      ))}
    </ol>
  );
}

/** The DM's prompts waiting, oldest first (none for anyone else). */
export function usePromptList(): DmPromptView[] {
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const prompts = useHealth((s) => s.prompts);
  return useMemo(
    () => (dm ? [...prompts.values()].sort((a, b) => a.createdAt - b.createdAt) : []),
    [prompts, dm],
  );
}

export { PromptCard };

function PromptCard({ p, compact }: { p: DmPromptView; compact: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [keep, setKeep] = useState<string[]>(() => p.items.map((i) => i.key));
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(p.items.filter((i) => i.choice).map((i) => [i.key, i.choice as string])),
  );
  const [busy, setBusy] = useState<"apply" | "skip" | null>(null);
  const damage = p.kind === "playerDamage" ? p.damage : undefined;
  // A player's damage: its preview as the DM would apply it (the DM's view of the creature's numbers).
  const [row, setRow] = useState<HpPreviewRow | null>(null);
  const [total, setTotal] = useState("");
  const [dec, setDec] = useState<Decisions[string] | undefined>(undefined);
  useEffect(() => {
    if (!damage || !p.tokenId || !open) return;
    let live = true;
    const t = Number(total);
    void previewHp({
      targets: [p.tokenId],
      kind: damage.kind,
      halved: damage.halved,
      crit: damage.crit,
      ...(damage.parts ? { parts: damage.parts } : {}),
      ...(damage.amount !== undefined ? { amount: damage.amount } : {}),
      ...(total.trim() && Number.isFinite(t) ? { totals: { [p.tokenId]: Math.max(0, Math.floor(t)) } } : {}),
    })
      .then((r) => {
        if (!live) return;
        const x = r[0] ?? null;
        setRow(x);
        setDec(
          (d) =>
            d ?? {
              keep: (x?.items ?? []).filter((i) => i.key !== "dying").map((i) => i.key),
              choices: Object.fromEntries(
                (x?.items ?? []).filter((i) => i.choice).map((i) => [i.key, i.choice as string]),
              ),
              seen: (x?.items ?? []).map((i) => i.key),
            },
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [damage, p.tokenId, total, open]);

  const resolve = async (apply: boolean) => {
    setBusy(apply ? "apply" : "skip");
    try {
      if (damage)
        await resolvePrompt(p.id, apply, {
          keep: dec?.keep ?? [],
          choices: dec?.choices ?? {},
          ...(total.trim() ? { total: Math.max(0, Math.floor(Number(total))) } : {}),
        });
      else await resolvePrompt(p.id, apply, { keep, choices });
    } catch (e) {
      toast.danger("Couldn't do that", (e as Error).message);
      setBusy(null);
    }
  };

  if (!open)
    return (
      <li
        className="panel pointer-events-auto flex items-center gap-2 border-wax/60 py-1 pr-1 pl-3 shadow-[var(--shadow-float)]"
        data-testid="dm-prompt"
        data-prompt={p.id}
      >
        <WaxSeal size={18} />
        <span className="min-w-0 flex-1 truncate text-14 font-bold text-bone">{p.title}</span>
        <Button size="S" variant="primary" onClick={() => setOpen(true)} aria-expanded={false}>
          Decide
        </Button>
      </li>
    );
  return (
    <li
      className="panel pointer-events-auto flex flex-col gap-2 border-wax/60 p-3 shadow-[var(--shadow-float)] motion-safe:animate-[rise-in_var(--dur-base)_var(--ease-out)_both]"
      data-testid="dm-prompt"
      data-prompt={p.id}
      aria-label={p.title}
    >
      <div className="flex items-start gap-2">
        <WaxSeal size={22} />
        <span className="min-w-0 flex-1">
          <span className="caps block text-12 text-brass">Your call</span>
          <span className="block text-18 font-bold leading-tight text-bone">{keepHyphenated(p.title)}</span>
          {p.detail ? (
            <span className="block text-13 text-muted">
              {p.detail}
              {/* A player's damage: how it was rolled (the title already says whose). */}
              {damage?.halved ? " · half (saved)" : ""}
              {damage?.crit ? " · critical hit" : ""}
              {damage?.label ? ` — ${damage.label}` : ""}
            </span>
          ) : null}
        </span>
        {compact ? (
          <IconButton label="Fold away" onClick={() => setOpen(false)} aria-expanded>
            <ChevronUp size={16} />
          </IconButton>
        ) : null}
      </div>
      {damage ? (
        row ? (
          <ul className="rounded-[var(--radius-control)] border border-line">
            <PreviewRow
              row={row}
              kind={damage.kind}
              dm
              deciding
              total={total}
              onTotal={setTotal}
              decision={dec}
              onDecision={setDec}
              tempChoice="best"
              onTempChoice={() => undefined}
            />
          </ul>
        ) : null
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="dm-prompt-items">
          {p.items.map((i) => {
            const kept = keep.includes(i.key);
            return (
              <li key={i.key} className="flex flex-wrap items-center gap-2 text-14">
                {choiceOnly(i) ? (
                  <span className="inline-flex min-h-[var(--touch-min)] items-center text-bone">
                    {i.label}
                  </span>
                ) : (
                  <label className="inline-flex min-h-[var(--touch-min)] items-center gap-2 text-bone">
                    <input
                      type="checkbox"
                      checked={kept}
                      onChange={(e) =>
                        setKeep((k) => (e.target.checked ? [...k, i.key] : k.filter((x) => x !== i.key)))
                      }
                      className="h-4 w-4 accent-[var(--brass-400)]"
                    />
                    {i.label}
                  </label>
                )}
                {i.choices && (kept || choiceOnly(i)) ? (
                  <Segmented
                    label={i.label}
                    size="S"
                    value={choices[i.key] ?? (i.choices[0]?.id as string)}
                    onChange={(v) => setChoices((c) => ({ ...c, [i.key]: v }))}
                    options={i.choices.map((c) => ({ value: c.id, label: c.label }))}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="S"
          variant="primary"
          loading={busy === "apply"}
          disabled={!damage && keep.length === 0}
          onClick={() => void resolve(true)}
        >
          Apply
        </Button>
        <Button size="S" variant="ghost" loading={busy === "skip"} onClick={() => void resolve(false)}>
          {damage ? "Decline" : "Skip"}
        </Button>
      </div>
    </li>
  );
}
