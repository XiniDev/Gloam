import { ABILITIES, DAMAGE_TYPES, SPELL_SCHOOLS } from "@gloam/shared";
import {
  SPELL_LEVEL_NAMES,
  type SpellFilter,
  spellClasses,
  spellMatches,
  spellRank,
} from "@gloam/shared/rules";
import type { Spell } from "@gloam/shared/schemas";
import { ChevronLeft, Search, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { StatusIcon } from "../../icons/status.tsx";
import { allSpells, loadSrdSpells, useSpells } from "../../net/spells.ts";
import { IconButton } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/EmptyState.tsx";
import { ScrollFade } from "../../ui/ScrollFade.tsx";
import { D20Spinner } from "../../ui/Spinner.tsx";
import { useIsPhone } from "../insets.ts";
import { SpellCard } from "./SpellCard.tsx";

const SHAPES = ["sphere", "cylinder", "cone", "cube", "line", "emanation", "wall", "none"] as const;
const TIMES = ["action", "bonus", "reaction", "minute", "hour"] as const;
const TIME_LABEL: Record<(typeof TIMES)[number], string> = {
  action: "Action",
  bonus: "Bonus",
  reaction: "Reaction",
  minute: "Minutes",
  hour: "Hours",
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The spell browser (SPEC §8.13 Content; AC-SPL-02): every spell the table has — the SRD's and the campaign's homebrew —
 * searched by name and text and filtered by level, school, class, casting time, concentration, ritual, damage type,
 * save, area shape and source. A spell picked shows its card beside the list (below it on a phone), with the actions
 * the place it's opened from gives it (Add to the sheet, Cast, Duplicate as homebrew).
 */
export function SpellBrowser({
  actions,
  initial,
}: {
  /** What can be done with the spell shown (buttons under its card). */
  actions?: (s: Spell) => ReactNode;
  /** A spell to show first. */
  initial?: string;
}) {
  const srd = useSpells((s) => s.srd);
  const homebrew = useSpells((s) => s.homebrew);
  const loading = useSpells((s) => s.loading);
  const failed = useSpells((s) => s.failed);
  const phone = useIsPhone();
  useEffect(() => {
    void loadSrdSpells().catch(() => {});
  }, []);
  const spells = useMemo(() => allSpells({ srd, homebrew }), [srd, homebrew]);
  const classes = useMemo(() => spellClasses(spells), [spells]);
  const [f, setF] = useState<SpellFilter>({});
  const [showFilters, setShowFilters] = useState(false);
  const [picked, setPicked] = useState<string | null>(initial ?? null);
  const shown = useMemo(
    () =>
      spells
        .filter((s) => spellMatches(s, f))
        .sort((a, b) => spellRank(a, f.q) - spellRank(b, f.q) || a.name.localeCompare(b.name)),
    [spells, f],
  );
  const current = shown.find((s) => s.id === picked) ?? spells.find((s) => s.id === picked) ?? null;
  const toggle = <K extends keyof SpellFilter>(
    k: K,
    v: NonNullable<SpellFilter[K]> extends (infer T)[] ? T : never,
  ) =>
    setF((x) => {
      const cur = (x[k] as unknown[] | undefined) ?? [];
      const next = cur.includes(v) ? cur.filter((y) => y !== v) : [...cur, v];
      return { ...x, [k]: next.length ? next : undefined };
    });
  const active = Object.entries(f).filter(([k, v]) => k !== "q" && v !== undefined).length;
  if (!srd && loading)
    return (
      <div className="grid place-items-center py-12 text-muted" data-testid="spell-browser">
        <D20Spinner size={28} label="Loading spells" />
      </div>
    );
  if (!srd && failed)
    return (
      <div data-testid="spell-browser">
        <EmptyState art="die" title={`The spells couldn't be loaded: ${failed}`} />
      </div>
    );
  const list = (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <label className="relative flex min-w-0 flex-1 items-center">
          <Search size={15} className="pointer-events-none absolute left-2.5 text-faint" aria-hidden />
          <input
            type="search"
            data-testid="spell-search"
            aria-label="Search spells"
            placeholder="e.g. fire, heal, invisible"
            value={f.q ?? ""}
            onChange={(e) => setF((x) => ({ ...x, q: e.target.value || undefined }))}
            className="h-10 min-h-[var(--touch-min)] w-full rounded-[var(--radius-control)] border border-line bg-ink-900 pr-2 pl-8 text-14 text-bone placeholder:text-faint focus:border-brass focus:outline-none"
          />
        </label>
        <IconButton
          label={showFilters ? "Hide filters" : "Filters"}
          aria-expanded={showFilters}
          active={showFilters || active > 0}
          onClick={() => setShowFilters((s) => !s)}
        >
          <SlidersHorizontal size={17} />
        </IconButton>
      </div>
      <p className="text-12 text-muted" data-testid="spell-count">
        {shown.length} {shown.length === 1 ? "spell" : "spells"}
      </p>
      {/* The filters and the list scroll as one (critic P9 r1 #14: a band of its own sliced its last row and left the
          list three rows): scrolled past, the filters give the list the whole column. */}
      <div className="flex min-h-48 flex-1 flex-col overflow-hidden rounded-[var(--radius-control)] border border-line">
        <ScrollFade>
          {showFilters ? (
            <div className="flex flex-col gap-2 border-b border-line p-2.5" data-testid="spell-filters">
              <Chips label="Level">
                {SPELL_LEVEL_NAMES.map((n, i) => (
                  <Chip key={n} on={f.levels?.includes(i)} onClick={() => toggle("levels", i)}>
                    {i === 0 ? "Cantrip" : String(i)}
                  </Chip>
                ))}
              </Chips>
              <Chips label="School">
                {SPELL_SCHOOLS.map((s) => (
                  <Chip key={s} on={f.schools?.includes(s)} onClick={() => toggle("schools", s)}>
                    {cap(s)}
                  </Chip>
                ))}
              </Chips>
              <Chips label="Class">
                {classes.map((c) => (
                  <Chip key={c} on={f.classes?.includes(c)} onClick={() => toggle("classes", c)}>
                    {cap(c)}
                  </Chip>
                ))}
              </Chips>
              <Chips label="Casting time">
                {TIMES.map((t) => (
                  <Chip key={t} on={f.castingTime?.includes(t)} onClick={() => toggle("castingTime", t)}>
                    {TIME_LABEL[t]}
                  </Chip>
                ))}
              </Chips>
              <Chips label="Concentration · ritual">
                <Chip
                  on={f.concentration === true}
                  onClick={() =>
                    setF((x) => ({ ...x, concentration: x.concentration === true ? undefined : true }))
                  }
                >
                  Concentration
                </Chip>
                <Chip
                  on={f.concentration === false}
                  onClick={() =>
                    setF((x) => ({ ...x, concentration: x.concentration === false ? undefined : false }))
                  }
                >
                  No concentration
                </Chip>
                <Chip
                  on={f.ritual === true}
                  onClick={() => setF((x) => ({ ...x, ritual: x.ritual ? undefined : true }))}
                >
                  Ritual
                </Chip>
              </Chips>
              <Chips label="Damage">
                {DAMAGE_TYPES.map((t) => (
                  <Chip key={t} on={f.damageTypes?.includes(t)} onClick={() => toggle("damageTypes", t)}>
                    {cap(t)}
                  </Chip>
                ))}
              </Chips>
              <Chips label="Save">
                {ABILITIES.map((a) => (
                  <Chip key={a} on={f.saves?.includes(a)} onClick={() => toggle("saves", a)}>
                    {a.toUpperCase()}
                  </Chip>
                ))}
              </Chips>
              <Chips label="Area">
                {SHAPES.map((s) => (
                  <Chip key={s} on={f.shapes?.includes(s)} onClick={() => toggle("shapes", s)}>
                    {s === "none" ? "No area" : cap(s)}
                  </Chip>
                ))}
              </Chips>
              <Chips label="Source">
                {(["srd", "homebrew"] as const).map((s) => (
                  <Chip
                    key={s}
                    on={f.source === s}
                    onClick={() => setF((x) => ({ ...x, source: x.source === s ? undefined : s }))}
                  >
                    {s === "srd" ? "SRD 5.2.1" : "Homebrew"}
                  </Chip>
                ))}
              </Chips>
              {active ? (
                <button
                  type="button"
                  onClick={() => setF((x) => ({ q: x.q }))}
                  className="self-start text-13 text-muted underline decoration-dotted hover:text-bone"
                >
                  Clear the filters
                </button>
              ) : null}
            </div>
          ) : null}
          {shown.length ? (
            <ul className="flex flex-col" aria-label="Spells">
              {shown.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    data-testid="spell-row"
                    data-spell={s.id}
                    aria-pressed={s.id === current?.id}
                    onClick={() => setPicked(s.id)}
                    className={`flex min-h-10 w-full items-center gap-2 border-b border-line/50 px-3 py-1.5 text-left hover:bg-raised ${s.id === current?.id ? "bg-raised shadow-[inset_2px_0_0_var(--brass-400)]" : ""}`}
                  >
                    <span className="tabular w-6 shrink-0 text-12 text-fog">
                      {s.level === 0 ? "C" : s.level}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-14 text-bone">{s.name}</span>
                    {/* Concentration as its §30.2 icon; a ritual as a small word mark (critic P9 r1 #26: a bare "C"). */}
                    {s.duration.concentration ? (
                      <span className="shrink-0 text-fog" title="Concentration" data-mark="concentration">
                        <StatusIcon id="concentrating" size={15} label="Concentration" />
                      </span>
                    ) : null}
                    {s.ritual ? (
                      <span
                        className="caps shrink-0 rounded-[var(--radius-chip)] border border-line px-1 text-12 leading-4 text-fog"
                        title="Ritual"
                        data-mark="ritual"
                      >
                        Ritual
                      </span>
                    ) : null}
                    {s.source.pack.startsWith("srd") ? null : (
                      <span className="caps shrink-0 text-12 text-brass">Homebrew</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState art="die" title="No spell matches. Clear a filter or search for fewer words." />
          )}
        </ScrollFade>
      </div>
    </div>
  );
  const card = current ? (
    <div className="flex min-h-0 flex-col gap-2" data-testid="spell-shown">
      {phone ? (
        // Back to the results, at the left (the dialog's own X stays the only close: critic P9 r1 #15).
        <div className="flex">
          <button
            type="button"
            aria-label="Back to the results"
            onClick={() => setPicked(null)}
            className="-ml-1 inline-flex min-h-[var(--touch-min)] items-center gap-0.5 rounded-[var(--radius-control)] px-1 text-14 font-bold text-muted hover:text-bone"
          >
            <ChevronLeft size={17} aria-hidden />
            Results
          </button>
        </div>
      ) : null}
      <div className="min-h-0 overflow-y-auto">
        <SpellCard
          spell={current}
          footer={actions ? <div className="flex flex-wrap gap-2 pt-1">{actions(current)}</div> : null}
        />
      </div>
    </div>
  ) : (
    <p className="grid h-full place-items-center p-6 text-center text-14 text-muted">
      Pick a spell to read its card.
    </p>
  );
  return (
    <div
      className={
        phone
          ? "flex min-h-0 flex-1 flex-col gap-3"
          : "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-4"
      }
      data-testid="spell-browser"
    >
      {phone && current ? card : list}
      {phone ? null : card}
    </div>
  );
}

function Chips({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="caps mb-1 text-12 text-fog">{label}</legend>
      <div className="flex flex-wrap gap-1">{children}</div>
    </fieldset>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={Boolean(on)}
      onClick={onClick}
      className={`h-7 min-h-[var(--touch-min)] rounded-[var(--radius-chip)] border px-2 text-12 font-bold transition-colors duration-[var(--dur-fast)] ${
        on
          ? "border-brass bg-[var(--glow-brass)] text-brass-bright"
          : "border-line text-muted hover:border-line-strong hover:text-bone"
      }`}
    >
      {children}
    </button>
  );
}
