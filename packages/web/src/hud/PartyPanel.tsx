import type { ActorView } from "@gloam/shared/protocol";
import { deriveSheet, statusName } from "@gloam/shared/rules";
import { Users } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { StatusIcon } from "../icons/status.tsx";
import { useSheets } from "../net/sheets.ts";
import { useTable } from "../net/table.ts";
import { useUi } from "../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { WaxSeal } from "../ui/ornaments.tsx";
import { Portrait } from "../ui/Portrait.tsx";
import { RestDialog } from "./health/RestDialog.tsx";
import { useAssetImage } from "./useAssetImage.ts";

const ROLE_LABEL: Record<string, string> = {
  admin: "Host",
  dm: "DM",
  player: "Player",
  spectator: "Watching",
};

/**
 * A character at a glance (§8.3 Party): portrait, name and classes, HP on a track of one width for every row (so they
 * compare), the conditions by name, the three passive scores; it opens the sheet.
 */
export function CharacterRow({
  a,
  color,
  player,
  actions,
}: {
  a: ActorView;
  color: string;
  player: string | null;
  /** The DM's own controls for this character (DM panel → Party), beside the row. */
  actions?: ReactNode;
}) {
  const c = a.sheet.core;
  const portrait = useAssetImage(c.portraitAssetId, 96);
  const d = useMemo(() => deriveSheet(c).values, [c]);
  const frac = c.hp.max > 0 ? Math.min(1, Math.max(0, c.hp.current / c.hp.max)) : 0;
  const hpColor = frac > 0.5 ? "var(--hp-high)" : frac > 0.25 ? "var(--hp-mid)" : "var(--hp-low)";
  const classes = c.classes.map((k) => `${k.name} ${k.level}`).join(" / ");
  return (
    <li className="flex items-start gap-1">
      <button
        type="button"
        data-testid="party-character"
        data-actor={a.id}
        onClick={() => useUi.getState().set({ dock: "sheet", sheetActor: a.id })}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-[var(--radius-control)] px-2 py-2 text-left hover:bg-raised"
      >
        <Portrait name={c.name} color={color} size={36} src={portrait} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-14 font-bold text-bone">{c.name}</span>
          <span className="block truncate text-12 text-muted">
            {[classes, player].filter(Boolean).join(" · ") || "No class yet"}
          </span>
          <span className="mt-1 grid grid-cols-[6rem_auto] items-center gap-2">
            <span className="h-1.5 overflow-hidden rounded-full bg-ink-950" aria-hidden>
              <span className="block h-full" style={{ width: `${frac * 100}%`, background: hpColor }} />
            </span>
            <span className="tabular text-12 text-fog">
              {c.hp.current}/{c.hp.max}
              {c.hp.temp ? <span className="text-ice"> +{c.hp.temp}</span> : null}
            </span>
          </span>
          {c.conditions.length ? (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {c.conditions.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 text-12 text-bone">
                  <StatusIcon id={id} size={16} badge label="" />
                  {statusName(id)}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="tabular flex shrink-0 flex-col items-end text-12 text-fog">
          <span>
            <abbr title="Passive Perception">PP</abbr> {d["passive.perception"]}
          </span>
          <span>
            <abbr title="Passive Investigation">Inv</abbr> {d["passive.investigation"]}
          </span>
          <span>
            <abbr title="Passive Insight">Ins</abbr> {d["passive.insight"]}
          </span>
        </span>
      </button>
      {actions ? <span className="flex shrink-0 flex-col items-end gap-1 py-2">{actions}</span> : null}
    </li>
  );
}

/**
 * Who's at the table (SPEC §29.3 dock "Party"): the characters this person may read (a DM, everyone's) with HP,
 * conditions and passive Perception at a glance (§8.3 Party) — each opens its sheet — and presence, role and raised
 * hands.
 */
export function PartyPanel() {
  const presence = useTable((s) => s.presence);
  const people = presence.filter((p) => p.role !== "admin" || p.online);
  const actors = useSheets((s) => s.actors);
  const me = useTable((s) => s.me);
  const dm = me?.role === "dm" || me?.role === "admin";
  const [resting, setResting] = useState<"short" | "long" | null>(null);
  const characters = useMemo(
    () =>
      [...actors.values()]
        .filter((a) => a.kind === "character")
        .sort((x, y) => x.sheet.core.name.localeCompare(y.sheet.core.name)),
    [actors],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Titled like the other panels (the DM panel, the sheet); its sections labelled alike under it. */}
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Users size={18} className="text-brass" aria-hidden />
        <h2 className="flex-1 text-18 text-bone">Party</h2>
        {/* The DM's rests (§8.11 Rests): the whole party or the characters selected, previewed before applying. */}
        {dm && characters.length ? (
          <span className="flex gap-1">
            <Button size="S" variant="ghost" onClick={() => setResting("short")}>
              Short rest…
            </Button>
            <Button size="S" variant="secondary" onClick={() => setResting("long")}>
              Long rest…
            </Button>
          </span>
        ) : null}
      </header>
      <RestDialog kind={resting} characters={characters} onClose={() => setResting(null)} />
      {characters.length ? (
        <section className="border-b border-line px-2 py-2" aria-label="Characters">
          <h3 className="caps px-2 pb-1 text-12 text-fog">Characters</h3>
          <ul>
            {characters.map((a) => {
              const who = presence.find((p) => p.userId === a.ownerUserId);
              return <CharacterRow key={a.id} a={a} color={who?.color ?? ""} player={who?.name ?? null} />;
            })}
          </ul>
        </section>
      ) : null}
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3">
        <h3 className="caps text-12 text-fog">At the table</h3>
        <p className="tabular text-13 text-muted">
          {people.filter((p) => p.online).length} here · {people.filter((p) => !p.online).length} away
        </p>
      </div>
      {people.length === 0 ? (
        <EmptyState art="candle" title="Nobody else is here yet." />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {people.map((p) => (
            <li
              key={p.userId}
              className="flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 hover:bg-raised"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: p.color, opacity: p.online ? 1 : 0.4 }}
                aria-hidden
              />
              <span className={`min-w-0 flex-1 truncate text-14 ${p.online ? "text-bone" : "text-faint"}`}>
                {p.name}
              </span>
              {p.handRaised ? <span className="caps text-12 text-accent">hand raised</span> : null}
              {/* Every role reads as a word; the DM/Host also wear the wax seal (SPEC §27.4 ornaments). */}
              <span className="flex items-center gap-1.5">
                {p.role === "dm" || p.role === "admin" ? (
                  <WaxSeal size={20} label={ROLE_LABEL[p.role]} />
                ) : null}
                <span
                  className={`caps text-12 ${p.role === "dm" || p.role === "admin" ? "text-brass" : "text-fog"}`}
                >
                  {ROLE_LABEL[p.role] ?? p.role}
                </span>
              </span>
              {!p.online ? <span className="text-12 text-faint">away</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
