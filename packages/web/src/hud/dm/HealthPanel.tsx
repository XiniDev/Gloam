import { HP_BAND_HIDDEN, HP_BAND_LABELS, statusName } from "@gloam/shared/rules";
import type { TokenView } from "@gloam/shared/state";
import { HeartPulse } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusIcon } from "../../icons/status.tsx";
import { requestDeathSaves, useHealth } from "../../net/health.ts";
import { useSheets } from "../../net/sheets.ts";
import { useBoard } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../../ui/Button.tsx";
import { toast } from "../../ui/Toast.tsx";
import { RestDialog } from "../health/RestDialog.tsx";

const dying = (t: TokenView) => t.markers.includes("deathsaves") && !t.markers.includes("stable") && !t.dead;

/**
 * DM panel → Health (SPEC §8.11): every creature on the scene — its HP, its conditions and markers — with Damage /
 * Heal, Conditions and, for the dying, "Request death save" (outside combat). The selection first; the decisions
 * waiting for the DM counted at the top (they stand over the board).
 */
export function HealthPanel() {
  const tokens = useBoard((d) => d.tokens);
  const selection = useUi((s) => s.selection);
  const waiting = useHealth((s) => s.prompts.size);
  const actors = useSheets((s) => s.actors);
  const party = useMemo(() => [...actors.values()].filter((a) => a.kind === "character"), [actors]);
  const [resting, setResting] = useState<"short" | "long" | null>(null);
  const rows = useMemo(() => {
    const sel = new Set(selection);
    return [...tokens.values()].sort(
      (a, b) =>
        Number(sel.has(b.id)) - Number(sel.has(a.id)) ||
        Number(b.disposition === "party") - Number(a.disposition === "party") ||
        a.name.localeCompare(b.name),
    );
  }, [tokens, selection]);
  const dyingNow = rows.filter(dying);
  const hpFor = (targets: string[], kind: "damage" | "heal") =>
    useUi.getState().set({ hpDialog: { targets, kind } });
  const deathSaves = async (ids: string[]) => {
    try {
      const r = await requestDeathSaves(ids);
      toast.info(r.asked === 1 ? "Death save asked for" : `${r.asked} death saves asked for`);
    } catch (e) {
      toast.danger("Couldn't ask", (e as Error).message);
    }
  };
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-clip px-3 py-3"
      data-testid="dm-health"
    >
      {waiting ? (
        <p className="rounded-[var(--radius-control)] border border-wax/50 px-3 py-2 text-13 text-bone">
          {waiting === 1 ? "A decision is waiting for you" : `${waiting} decisions are waiting for you`} —
          over the board.
        </p>
      ) : null}
      {party.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="caps text-12 text-fog">Rest</span>
          <Button size="S" variant="ghost" onClick={() => setResting("short")}>
            Short rest…
          </Button>
          <Button size="S" variant="ghost" onClick={() => setResting("long")}>
            Long rest…
          </Button>
        </div>
      ) : null}
      <RestDialog kind={resting} characters={party} onClose={() => setResting(null)} />
      {selection.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="caps text-12 text-fog">Selected ({selection.length})</span>
          <Button size="S" variant="secondary" onClick={() => hpFor(selection, "damage")}>
            Damage…
          </Button>
          <Button size="S" variant="ghost" onClick={() => hpFor(selection, "heal")}>
            Heal…
          </Button>
        </div>
      ) : null}
      {dyingNow.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="caps text-12 text-fog">Dying ({dyingNow.length})</span>
          <Button size="S" variant="secondary" onClick={() => void deathSaves(dyingNow.map((t) => t.id))}>
            Request death saves
          </Button>
        </div>
      ) : null}
      {rows.length === 0 ? <p className="text-13 text-muted">No creatures on this scene.</p> : null}
      <ul className="flex flex-col" aria-label="Creatures on this scene">
        {rows.map((t) => {
          const hp = t.hp
            ? `${t.hp.hp}/${t.hp.hpMax}`
            : t.hpBand !== HP_BAND_HIDDEN
              ? HP_BAND_LABELS[t.hpBand]
              : "—";
          // As its plate shows them: conditions, Exhaustion (with its level), concentration, then markers.
          const statuses = [
            ...t.conditions,
            ...(t.exhaustion > 0 && !t.conditions.includes("exhaustion") ? ["exhaustion"] : []),
            ...(t.concentrating && !t.markers.includes("concentrating") ? ["concentrating"] : []),
            ...t.markers.filter((m) => !m.startsWith("custom:")),
          ];
          const named = (id: string) =>
            id === "exhaustion" ? `${statusName(id)} ${t.exhaustion}` : statusName(id);
          return (
            <li
              key={t.id}
              className="flex flex-col gap-0.5 border-t border-line/60 py-1.5"
              data-testid="health-row"
              data-token={t.id}
            >
              {/* Two lines, so a long name keeps its width and the HP and actions line up down the list. */}
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate text-14 text-bone">
                  {t.name}
                  {t.dead ? <span className="caps ml-1.5 text-12 text-danger-text">dead</span> : null}
                </span>
                <span className="tabular shrink-0 text-13 text-fog">{hp}</span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  role="img"
                  className="flex min-w-0 flex-1 items-center gap-0.5"
                  aria-label={statuses.map(named).join(", ") || "No conditions"}
                >
                  {statuses.slice(0, 6).map((id) => (
                    <StatusIcon
                      key={id}
                      id={id}
                      size={16}
                      badge
                      label=""
                      level={id === "exhaustion" ? t.exhaustion : undefined}
                    />
                  ))}
                  {statuses.length > 6 ? (
                    <span className="tabular ml-0.5 text-12 text-fog">+{statuses.length - 6}</span>
                  ) : null}
                </span>
                <span className="-mr-2 flex shrink-0 items-center">
                  <Button
                    size="S"
                    variant="ghost"
                    icon={<HeartPulse size={14} />}
                    aria-label={`${t.name}: damage or heal`}
                    onClick={() => hpFor([t.id], "damage")}
                  >
                    HP
                  </Button>
                  <Button
                    size="S"
                    variant="ghost"
                    aria-label={`${t.name}: conditions`}
                    onClick={() => useUi.getState().set({ statusPicker: { tokenId: t.id } })}
                  >
                    Conditions
                  </Button>
                  {dying(t) ? (
                    <Button size="S" variant="ghost" onClick={() => void deathSaves([t.id])}>
                      Death save
                    </Button>
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
