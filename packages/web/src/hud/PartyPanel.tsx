import type { ActorView } from "@gloam/shared/protocol";
import { deriveSheet } from "@gloam/shared/rules";
import { useMemo } from "react";
import { useSheets } from "../net/sheets.ts";
import { useTable } from "../net/table.ts";
import { useUi } from "../state/ui.ts";
import { EmptyState } from "../ui/EmptyState.tsx";
import { WaxSeal } from "../ui/ornaments.tsx";
import { Portrait } from "../ui/Portrait.tsx";
import { useAssetImage } from "./useAssetImage.ts";

const ROLE_LABEL: Record<string, string> = {
  admin: "Host",
  dm: "DM",
  player: "Player",
  spectator: "Watching",
};

/** A character at a glance: portrait, name and classes, HP, conditions and passive Perception; opens its sheet. */
function CharacterRow({ a, color, player }: { a: ActorView; color: string; player: string | null }) {
  const c = a.sheet.core;
  const portrait = useAssetImage(c.portraitAssetId, 96);
  const pp = useMemo(() => deriveSheet(c).values["passive.perception"], [c]);
  const frac = c.hp.max > 0 ? Math.min(1, Math.max(0, c.hp.current / c.hp.max)) : 0;
  const hpColor = frac > 0.5 ? "var(--hp-high)" : frac > 0.25 ? "var(--hp-mid)" : "var(--hp-low)";
  const classes = c.classes.map((k) => `${k.name} ${k.level}`).join(" / ");
  return (
    <li>
      <button
        type="button"
        data-testid="party-character"
        data-actor={a.id}
        onClick={() => useUi.getState().set({ dock: "sheet", sheetActor: a.id })}
        className="flex w-full items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 text-left hover:bg-raised"
      >
        <Portrait name={c.name} color={color} size={36} src={portrait} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-14 font-bold text-bone">{c.name}</span>
          <span className="block truncate text-12 text-muted">
            {[classes, player].filter(Boolean).join(" · ") || "No class yet"}
          </span>
          <span className="mt-1 flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-950" aria-hidden>
              <span className="block h-full" style={{ width: `${frac * 100}%`, background: hpColor }} />
            </span>
            <span className="tabular text-12 text-fog">
              {c.hp.current}/{c.hp.max}
              {c.hp.temp ? ` +${c.hp.temp}` : ""}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-12">
          <span className="tabular text-fog" title="Passive Perception">
            PP {pp}
          </span>
          {c.conditions.length ? (
            <span className="text-warning">
              {c.conditions.length} condition{c.conditions.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
      </button>
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
  const characters = useMemo(
    () =>
      [...actors.values()]
        .filter((a) => a.kind === "character")
        .sort((x, y) => x.sheet.core.name.localeCompare(y.sheet.core.name)),
    [actors],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {characters.length ? (
        <section className="border-b border-line px-2 py-2" aria-label="Characters">
          <h2 className="caps px-2 pb-1 text-12 text-fog">Characters</h2>
          <ul>
            {characters.map((a) => {
              const who = presence.find((p) => p.userId === a.ownerUserId);
              return <CharacterRow key={a.id} a={a} color={who?.color ?? ""} player={who?.name ?? null} />;
            })}
          </ul>
        </section>
      ) : null}
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-18 text-bone">At the table</h2>
        <p className="text-13 text-muted">
          {people.filter((p) => p.online).length} here · {people.filter((p) => !p.online).length} away
        </p>
      </header>
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
