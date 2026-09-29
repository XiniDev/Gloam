import { useEffect, useMemo, useState } from "react";
import { type InitiativeMethod, startCombat } from "../../net/combat.ts";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented, Toggle } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { toast } from "../../ui/Toast.tsx";

const METHODS: { value: InitiativeMethod; label: string; about: string }[] = [
  {
    value: "playersRoll",
    label: "Players roll",
    about: "Players roll their own; you roll the NPCs with one click.",
  },
  { value: "rollAll", label: "Roll for all", about: "Gloam rolls for every creature at once." },
  {
    value: "fixed",
    label: "Fixed",
    about: "10 + initiative modifier (+5 with advantage, −5 with disadvantage).",
  },
  { value: "skip", label: "Skip rolls", about: "No rolls: you set the order yourself." },
];

/**
 * Start combat… (SPEC §8.12; AC-CMB-01): who fights — the selected creatures, else everyone on the scene not hidden,
 * with toggles for the party and the NPCs — how initiative is found (the campaign's default preselected), one roll per
 * group of identical NPCs, and who is surprised.
 */
export function StartCombatDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tokens = useEntities((s) => boardData(s).tokens);
  const selection = useUi((s) => s.selection);
  const defaultMethod = useTable((s) => s.houseRules.defaultInitiative) as InitiativeMethod;
  const all = useMemo(
    () => [...tokens.values()].filter((t) => !t.dm?.dmHidden).sort((a, b) => a.name.localeCompare(b.name)),
    [tokens],
  );
  const pc = (id: string) => tokens.get(id)?.disposition === "party";
  const [chosen, setChosen] = useState<string[]>([]);
  const [surprised, setSurprised] = useState<string[]>([]);
  const [method, setMethod] = useState<InitiativeMethod>(defaultMethod);
  const [group, setGroup] = useState(true);
  const [busy, setBusy] = useState(false);
  // Opened: the selection if any, else everyone on the scene.
  useEffect(() => {
    if (!open) return;
    const picked = selection.filter((id) => all.some((t) => t.id === id));
    setChosen(picked.length ? picked : all.map((t) => t.id));
    setSurprised([]);
    setMethod(defaultMethod);
  }, [open, selection, all, defaultMethod]);
  const toggleAll = (party: boolean, on: boolean) => {
    const ids = all.filter((t) => pc(t.id) === party).map((t) => t.id);
    setChosen((c) => (on ? [...new Set([...c, ...ids])] : c.filter((id) => !ids.includes(id))));
  };
  const start = async () => {
    setBusy(true);
    try {
      await startCombat({
        participants: chosen,
        method,
        group,
        surprised: surprised.filter((id) => chosen.includes(id)),
      });
      onClose();
    } catch (e) {
      toast.danger("Couldn't start combat", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const partyOn = all.filter((t) => pc(t.id)).every((t) => chosen.includes(t.id));
  const npcsOn = all.filter((t) => !pc(t.id)).every((t) => chosen.includes(t.id));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start combat"
      description="Who fights, how initiative is found, who's caught by surprise."
      width={560}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!chosen.length} onClick={() => void start()}>
            {chosen.length === 1 ? "Start with 1 creature" : `Start with ${chosen.length} creatures`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="start-combat">
        <section className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="caps flex-1 text-12 text-fog">Who fights</span>
            <Toggle
              inline
              compact
              label="The party"
              checked={partyOn}
              onChange={(on) => toggleAll(true, on)}
            />
            <Toggle inline compact label="NPCs" checked={npcsOn} onChange={(on) => toggleAll(false, on)} />
          </div>
          <ul className="flex max-h-64 flex-col divide-y divide-line/60 overflow-y-auto rounded-[var(--radius-control)] border border-line">
            {all.map((t) => {
              const on = chosen.includes(t.id);
              return (
                <li
                  key={t.id}
                  className="flex items-center gap-3 px-3"
                  data-testid="combat-participant"
                  data-token={t.id}
                >
                  <label className="inline-flex min-h-[var(--touch-min)] flex-1 items-center gap-2 text-14 text-bone">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setChosen((c) => (e.target.checked ? [...c, t.id] : c.filter((x) => x !== t.id)))
                      }
                      className="h-4 w-4 accent-[var(--brass-400)]"
                    />
                    {t.name}
                    <span className="caps text-12 text-faint">{pc(t.id) ? "party" : t.disposition}</span>
                  </label>
                  <label className="inline-flex min-h-[var(--touch-min)] items-center gap-1.5 text-13 text-muted">
                    <input
                      type="checkbox"
                      disabled={!on}
                      checked={surprised.includes(t.id)}
                      onChange={(e) =>
                        setSurprised((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))
                      }
                      className="h-4 w-4 accent-[var(--brass-400)]"
                    />
                    Surprised
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="flex flex-col gap-1.5">
          <span className="caps text-12 text-fog">Initiative</span>
          <Segmented
            label="Initiative method"
            fill
            value={method}
            onChange={setMethod}
            options={METHODS.map((m) => ({ value: m.value, label: m.label }))}
          />
          <p className="text-13 text-muted">{METHODS.find((m) => m.value === method)?.about}</p>
        </section>
        <Toggle
          checked={group}
          onChange={setGroup}
          label="Group identical NPCs"
          description="One roll for each group of the same creature (SRD)."
        />
      </div>
    </Dialog>
  );
}
