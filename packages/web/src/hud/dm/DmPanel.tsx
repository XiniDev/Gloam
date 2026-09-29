import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { pendingProposals, useSheets } from "../../net/sheets.ts";
import { pendingCount, useLibrary } from "../../state/library.ts";
import { type DmSection, useUi } from "../../state/ui.ts";
import { Menu } from "../../ui/Menu.tsx";
import { WaxSeal } from "../../ui/ornaments.tsx";
import { visibleTabs } from "../sheet/tabsLayout.ts";
import { ApprovalsPanel } from "./ApprovalsPanel.tsx";
import { CombatPanel } from "./CombatPanel.tsx";
import { EffectsPanel } from "./EffectsPanel.tsx";
import { HealthPanel } from "./HealthPanel.tsx";
import { LibraryPanel } from "./LibraryPanel.tsx";
import { RequestsPanel } from "./RequestsPanel.tsx";
import { ScenesPanel } from "./ScenesPanel.tsx";
import { SpellsPanel } from "./SpellsPanel.tsx";

const SECTIONS: { id: DmSection; label: string }[] = [
  { id: "scenes", label: "Scenes" },
  { id: "library", label: "Library" },
  { id: "requests", label: "Requests" },
  { id: "health", label: "Health" },
  { id: "combat", label: "Combat" },
  { id: "spells", label: "Spells" },
  { id: "effects", label: "Effects" },
  { id: "approvals", label: "Approvals" },
];

const TAB_CLASS =
  "relative flex h-10 min-h-[var(--touch-min)] shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-14 font-bold transition-colors duration-[var(--dur-fast)]";
/** The tabs' gap (`gap-1`). */
const GAP = 4;

/**
 * The panel's sections in one row, in their fixed order — as many as the row holds, the rest under "+n" (as the
 * sheet's; critic P7 r2 #12: a tab cut mid-glyph read as broken). Widths come from an invisible copy of every tab and
 * of the More button, measured again as the panel is resized and once the fonts have loaded.
 */
function DmTabs({ section, pending }: { section: DmSection; pending: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ avail: number; widths: number[]; moreW: number } | null>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    const m = ruler.current;
    if (!el || !m) return;
    const update = () => {
      const cs = getComputedStyle(el);
      const avail = el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
      const all = [...m.children].map((c) => (c as HTMLElement).getBoundingClientRect().width);
      const moreW = all.pop() ?? 0;
      setRoom((r) =>
        r && r.avail === avail && r.moreW === moreW && r.widths.every((w, k) => w === all[k])
          ? r
          : { avail, widths: all, moreW },
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(m);
    void document.fonts?.ready.then(update);
    return () => ro.disconnect();
  }, []);
  const active = Math.max(
    0,
    SECTIONS.findIndex((s) => s.id === section),
  );
  const shown = room
    ? visibleTabs(room.widths, room.moreW, room.avail, active, GAP)
    : SECTIONS.map((_, k) => k);
  const rest = SECTIONS.filter((_, k) => !shown.includes(k));
  const pick = (id: DmSection) => useUi.getState().set({ dmSection: id });
  const badge = (id: DmSection) =>
    id === "approvals" && pending ? (
      <span className="tabular grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-12 text-ink-950">
        {pending}
      </span>
    ) : null;
  const restPending = rest.some((s) => s.id === "approvals") && pending > 0;
  return (
    <div ref={bar} className="relative flex shrink-0 items-center border-b border-line px-3">
      {/* The widths' ruler, laid out inside a box of no size. */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden"
      >
        <div ref={ruler} className="flex w-max">
          {SECTIONS.map((s) => (
            <span key={s.id} className={TAB_CLASS}>
              {s.label}
              {badge(s.id)}
            </span>
          ))}
          <span className="inline-flex h-9 items-center gap-1 px-2 text-13 font-bold">
            +{SECTIONS.length - 1} ●
            <ChevronDown size={14} />
          </span>
        </div>
      </div>
      <div role="tablist" aria-label="DM panel sections" className="flex min-w-0 flex-1 gap-1">
        {shown.map((k) => {
          const s = SECTIONS[k] as (typeof SECTIONS)[number];
          const on = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => pick(s.id)}
              className={`${TAB_CLASS} ${on ? "text-brass-bright" : "text-muted hover:text-bone"}`}
            >
              {s.label}
              {badge(s.id)}
              {on ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      {rest.length ? (
        <Menu
          label="More sections"
          text={`+${rest.length}${restPending ? " ●" : ""}`}
          items={rest.map((s) => ({
            label: s.id === "approvals" && pending ? `${s.label} (${pending})` : s.label,
            onSelect: () => pick(s.id),
          }))}
        />
      ) : null}
    </div>
  );
}

/** The DM panel (SPEC §8.3 DM scene tools, §8.16 Library and Approvals). Later phases add their sections here. */
export default function DmPanel() {
  const section = useUi((s) => s.dmSection);
  const pending = useLibrary(pendingCount) + useSheets(pendingProposals);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 pb-0 pt-3">
        <WaxSeal size={20} />
        <h2 className="text-18 text-bone">DM panel</h2>
      </header>
      <DmTabs section={section} pending={pending} />
      <div role="tabpanel" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip">
        {section === "scenes" ? <ScenesPanel /> : null}
        {section === "library" ? <LibraryPanel /> : null}
        {section === "requests" ? <RequestsPanel /> : null}
        {section === "health" ? <HealthPanel /> : null}
        {section === "combat" ? <CombatPanel /> : null}
        {section === "spells" ? <SpellsPanel /> : null}
        {section === "effects" ? <EffectsPanel /> : null}
        {section === "approvals" ? <ApprovalsPanel /> : null}
      </div>
    </div>
  );
}
