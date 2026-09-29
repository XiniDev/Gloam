import type { TokenView } from "@gloam/shared/state";
import { useEffect, useMemo, useState } from "react";
import { ringColorOf } from "../../board/colors.ts";
import { type InitiativeMethod, startCombat } from "../../net/combat.ts";
import { useTable } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented, Toggle } from "../../ui/controls.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { Portrait } from "../../ui/Portrait.tsx";
import { ScrollFade } from "../../ui/ScrollFade.tsx";
import { toast } from "../../ui/Toast.tsx";
import { useIsPhone } from "../insets.ts";
import { useAssetImage } from "../useAssetImage.ts";

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
          <span className="caps text-12 text-fog">Who fights</span>
          {/* The two switches on a row of their own (left-aligned on every screen, critic P8 r1 #24). */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <Toggle
              inline
              compact
              label="The party"
              checked={partyOn}
              onChange={(on) => toggleAll(true, on)}
            />
            <Toggle inline compact label="NPCs" checked={npcsOn} onChange={(on) => toggleAll(false, on)} />
          </div>
          <div className="flex max-h-64 flex-col overflow-hidden rounded-[var(--radius-control)] border border-line">
            {/* Surprised as a column of its own, headed once (critic P8 r2 B4: a label per row clipped on phones). */}
            <div className="caps flex items-center gap-3 border-b border-line/60 px-3 py-1 text-12 text-fog">
              <span className="flex-1">Creature</span>
              <span className="w-20 text-center">Surprised</span>
            </div>
            <ScrollFade>
              <ul className="flex flex-col divide-y divide-line/60">
                {all.map((t) => (
                  <Participant
                    key={t.id}
                    t={t}
                    party={pc(t.id)}
                    on={chosen.includes(t.id)}
                    surprised={surprised.includes(t.id)}
                    onChoose={(yes) => setChosen((c) => (yes ? [...c, t.id] : c.filter((x) => x !== t.id)))}
                    onSurprise={(yes) =>
                      setSurprised((x) => (yes ? [...x, t.id] : x.filter((y) => y !== t.id)))
                    }
                  />
                ))}
              </ul>
            </ScrollFade>
          </div>
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

/**
 * One creature in the list (32-px rows): its portrait in its ring, its name and side (a phone: the side under the
 * name), and Surprised in its column.
 */
function Participant({
  t,
  party,
  on,
  surprised,
  onChoose,
  onSurprise,
}: {
  t: TokenView;
  party: boolean;
  on: boolean;
  surprised: boolean;
  onChoose: (on: boolean) => void;
  onSurprise: (on: boolean) => void;
}) {
  const colorBlind = useSettings((s) => s.colorBlind);
  const phone = useIsPhone();
  const src = useAssetImage(t.portraitAssetId || t.assetId || null, 64);
  const side = <span className="caps shrink-0 text-12 text-faint">{party ? "party" : t.disposition}</span>;
  return (
    <li className="flex min-h-8 items-center gap-3 px-3" data-testid="combat-participant" data-token={t.id}>
      <label className="inline-flex min-h-8 min-w-0 flex-1 items-center gap-2.5 py-1 text-14 text-bone">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onChoose(e.target.checked)}
          className="h-4 w-4 shrink-0 accent-[var(--brass-400)]"
        />
        <Portrait name={t.name} color={ringColorOf(t, colorBlind)} size={20} src={src} />
        {phone ? (
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate">{t.name}</span>
            {side}
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate">{t.name}</span>
            {side}
          </>
        )}
      </label>
      {/* The whole cell is the touch target (the box itself stays 16 px). */}
      <label className="grid min-h-8 w-20 shrink-0 cursor-pointer place-items-center self-stretch">
        <input
          type="checkbox"
          aria-label="Surprised"
          title={`${t.name} is surprised`}
          disabled={!on}
          checked={surprised}
          onChange={(e) => onSurprise(e.target.checked)}
          className="h-4 w-4 accent-[var(--brass-400)]"
        />
      </label>
    </li>
  );
}
