import type { ActorView } from "@gloam/shared/protocol";
import { type RestKind, restPlan, statusFromSheet } from "@gloam/shared/rules";
import { useEffect, useMemo, useState } from "react";
import { request, useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";

/**
 * Short and long rests (SPEC §8.11 Rests; AC-HP-13): the characters resting — the selection's, else the whole party —
 * each with what the rest gives it by the campaign's rules pack (rules/rests.ts), every line ticked; the DM unticks
 * anything that shouldn't happen (P2) and applies it as one undoable command. After a short rest each player spends
 * Hit Dice on their own cards.
 */
export function RestDialog({
  kind,
  characters,
  onClose,
}: {
  kind: RestKind | null;
  characters: ActorView[];
  onClose: () => void;
}) {
  const pack = useTable((s) => s.rulesPack);
  const selection = useUi((s) => s.selection);
  const tokens = useBoard((d) => d.tokens);
  const [who, setWho] = useState<string[]>([]);
  const [off, setOff] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  // Opened: the characters whose tokens are selected, else everyone; every line on.
  useEffect(() => {
    if (!kind) return;
    const selected = new Set(
      selection.map((id) => tokens.get(id)?.actorId).filter((x): x is string => Boolean(x)),
    );
    const picked = characters.filter((a) => selected.has(a.id)).map((a) => a.id);
    setWho(picked.length ? picked : characters.map((a) => a.id));
    setOff({});
  }, [kind, characters, selection, tokens]);
  const plans = useMemo(
    () =>
      kind
        ? characters.map((a) => ({ a, plan: restPlan(a.sheet, statusFromSheet(a.sheet), kind, pack) }))
        : [],
    [kind, characters, pack],
  );
  const apply = async () => {
    if (!kind) return;
    const actors: Record<string, string[]> = {};
    for (const { a, plan } of plans)
      if (who.includes(a.id) && !plan.blocked)
        actors[a.id] = plan.items.map((i) => i.key).filter((k) => !(off[a.id] ?? []).includes(k));
    if (!Object.keys(actors).length) return;
    setBusy(true);
    try {
      await request("rest.apply", { kind, actors });
      toast.success(kind === "long" ? "Long rest taken" : "Short rest taken");
      onClose();
    } catch (e) {
      toast.danger("Couldn't rest", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resting = plans.filter(({ a, plan }) => who.includes(a.id) && !plan.blocked).length;
  return (
    <Dialog
      open={kind !== null}
      onClose={onClose}
      title={kind === "long" ? "Long rest" : "Short rest"}
      description={
        kind === "long"
          ? "At least 8 hours: all HP and spent Hit Dice back, slots and uses restored, Exhaustion −1."
          : "At least 1 hour: short-rest uses and pact slots back; each player spends Hit Dice on their card."
      }
      width={600}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!resting} onClick={() => void apply()}>
            {resting === 1 ? "Rest 1 character" : `Rest ${resting} characters`}
          </Button>
        </div>
      }
    >
      <ul className="flex flex-col gap-3" data-testid="rest-dialog">
        {plans.map(({ a, plan }) => {
          const on = who.includes(a.id);
          return (
            <li
              key={a.id}
              className="flex flex-col gap-1.5 rounded-[var(--radius-control)] border border-line px-3 py-2"
              data-testid="rest-character"
              data-actor={a.id}
            >
              <label className="inline-flex min-h-[var(--touch-min)] items-center gap-2 text-14 font-bold text-bone">
                <input
                  type="checkbox"
                  checked={on && !plan.blocked}
                  disabled={Boolean(plan.blocked)}
                  onChange={(e) =>
                    setWho((w) => (e.target.checked ? [...w, a.id] : w.filter((x) => x !== a.id)))
                  }
                  className="h-4 w-4 accent-[var(--brass-400)]"
                />
                {a.sheet.core.name}
              </label>
              {plan.blocked ? (
                <p className="pl-6 text-13 text-muted">{plan.blocked}.</p>
              ) : plan.items.length === 0 ? (
                <p className="pl-6 text-13 text-muted">Nothing to restore.</p>
              ) : (
                <ul className="flex flex-col pl-6" aria-label={`What ${a.sheet.core.name} gets`}>
                  {plan.items.map((i) => {
                    const kept = !(off[a.id] ?? []).includes(i.key);
                    return (
                      <li key={i.key}>
                        <label className="inline-flex min-h-8 items-center gap-2 text-13 text-bone pointer-coarse:min-h-[var(--touch-min)]">
                          <input
                            type="checkbox"
                            checked={kept}
                            disabled={!on}
                            onChange={(e) =>
                              setOff((o) => ({
                                ...o,
                                [a.id]: e.target.checked
                                  ? (o[a.id] ?? []).filter((k) => k !== i.key)
                                  : [...(o[a.id] ?? []), i.key],
                              }))
                            }
                            className="h-4 w-4 accent-[var(--brass-400)]"
                          />
                          {i.label}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
