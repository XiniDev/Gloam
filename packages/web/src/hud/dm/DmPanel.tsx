import { Search } from "lucide-react";
import { useUi } from "../../state/ui.ts";
import { KeyHint } from "../../ui/KeyHint.tsx";
import { WaxSeal } from "../../ui/ornaments.tsx";
import { ScrollFade } from "../../ui/ScrollFade.tsx";
import { Tooltip } from "../../ui/Tooltip.tsx";
import { ApprovalsPanel, useApprovalsCount } from "./ApprovalsPanel.tsx";
import { CombatPanel } from "./CombatPanel.tsx";
import { EffectsPanel } from "./EffectsPanel.tsx";
import { HandoutsPanel } from "./HandoutsPanel.tsx";
import { HealthPanel } from "./HealthPanel.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { HouseRulesPanel } from "./HouseRulesPanel.tsx";
import { LibraryPanel } from "./LibraryPanel.tsx";
import { LightsSection } from "./LightsSection.tsx";
import { NotesSection } from "./NotesSection.tsx";
import { PartySection } from "./PartySection.tsx";
import { RequestsPanel } from "./RequestsPanel.tsx";
import { ScenesPanel } from "./ScenesPanel.tsx";
import { SoundPanel } from "./SoundPanel.tsx";
import { SpellsPanel } from "./SpellsPanel.tsx";
import { SECTIONS, sectionOf } from "./sections.ts";
import { TokensSection } from "./TokensSection.tsx";
import { VisionSection } from "./VisionSection.tsx";
import { WallsSection } from "./WallsSection.tsx";

/**
 * The DM panel's sections as a vertical icon rail (SPEC §8.19): every section one click away, named on hover (beside
 * the rail) and to screen readers, the open one lit in brass; Approvals carries the count of what's waiting.
 */
function DmRail() {
  const section = useUi((s) => s.dmSection);
  const waiting = useApprovalsCount();
  return (
    // Seventeen sections fit a 768-px screen at 36 px each; shorter, the rail scrolls and its ends say so (a section cut
    // in half with no hint was a secret: critic P12 r1 M6).
    <ScrollFade
      outerClassName="w-12 shrink-0 border-r border-line"
      className="flex flex-col items-center py-1.5"
      testId="dm-rail-more"
      scrollerProps={{
        role: "tablist",
        "aria-label": "DM panel sections",
        "aria-orientation": "vertical",
        onKeyDown: (e) => {
          // Up/Down move between the sections (the tablist pattern).
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const i = SECTIONS.findIndex((s) => s.id === section);
          const next = SECTIONS[(i + (e.key === "ArrowDown" ? 1 : -1) + SECTIONS.length) % SECTIONS.length];
          if (!next) return;
          useUi.getState().set({ dmSection: next.id });
          const rail = e.currentTarget;
          requestAnimationFrame(() =>
            (rail.querySelector(`[data-section="${next.id}"]`) as HTMLElement | null)?.focus(),
          );
        },
      }}
    >
      {SECTIONS.map((s) => {
        const on = s.id === section;
        const Icon = s.icon;
        const count = s.id === "approvals" ? waiting : 0;
        return (
          <Tooltip key={s.id} label={count ? `${s.label} (${count} waiting)` : s.label} side="left">
            <button
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={s.label}
              tabIndex={on ? 0 : -1}
              data-section={s.id}
              onClick={() => useUi.getState().set({ dmSection: s.id })}
              className={`hit relative grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] transition-colors duration-[var(--dur-fast)] ${
                on
                  ? "bg-raised text-brass-bright shadow-[inset_0_0_0_1px_var(--brass-600)]"
                  : "text-muted hover:bg-raised hover:text-bone"
              }`}
            >
              <Icon size={18} aria-hidden />
              {count ? (
                <span
                  className="tabular pointer-events-none absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-12 font-bold text-ink-950"
                  aria-hidden
                >
                  {count}
                </span>
              ) : null}
            </button>
          </Tooltip>
        );
      })}
    </ScrollFade>
  );
}

/**
 * The DM panel (SPEC §8.19): the rail of sections on its left, the open section beside it, and "Jump to…" (Ctrl/Cmd+K)
 * in its header — any section or command by name.
 */
export default function DmPanel() {
  const section = useUi((s) => s.dmSection);
  const def = sectionOf(section);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line py-2 pl-4 pr-2">
        <WaxSeal size={20} />
        {/* The section's name (the seal and the dock's label say whose panel it is). */}
        <h2 className="min-w-0 truncate text-18 text-bone">
          <span className="sr-only">DM panel: </span>
          {def.label}
        </h2>
        <button
          type="button"
          onClick={() => useUi.getState().set({ jumpTo: true })}
          className="hit ml-auto flex h-8 shrink-0 items-center gap-2 rounded-[var(--radius-control)] border border-line px-2.5 text-13 text-muted hover:border-brass-deep hover:text-bone"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <Search size={14} aria-hidden />
          <span className="max-sm:hidden">Jump to…</span>
          <span className="pointer-coarse:hidden">
            <KeyHint keys="Mod+K" />
          </span>
        </button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1">
        <DmRail />
        <div
          role="tabpanel"
          aria-label={def.label}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip"
          data-testid="dm-section"
          data-section={section}
        >
          {section === "scenes" ? <ScenesPanel /> : null}
          {section === "tokens" ? (
            <ScrollFade>
              <TokensSection />
            </ScrollFade>
          ) : null}
          {section === "vision" ? (
            <ScrollFade>
              <VisionSection />
            </ScrollFade>
          ) : null}
          {section === "walls" ? (
            <ScrollFade>
              <WallsSection />
            </ScrollFade>
          ) : null}
          {section === "lights" ? (
            <ScrollFade>
              <LightsSection />
            </ScrollFade>
          ) : null}
          {section === "combat" ? <CombatPanel /> : null}
          {section === "health" ? <HealthPanel /> : null}
          {section === "requests" ? <RequestsPanel /> : null}
          {section === "effects" ? <EffectsPanel /> : null}
          {section === "spells" ? <SpellsPanel /> : null}
          {section === "library" ? <LibraryPanel /> : null}
          {section === "sound" ? <SoundPanel /> : null}
          {section === "party" ? (
            <ScrollFade>
              <PartySection />
            </ScrollFade>
          ) : null}
          {section === "handouts" ? (
            // (Its sections' ends fade where there's more: never a field sliced by the frame, critic P12 r1 M7.)
            <ScrollFade>
              <HandoutsPanel />
              <NotesSection />
            </ScrollFade>
          ) : null}
          {section === "approvals" ? <ApprovalsPanel /> : null}
          {section === "history" ? <HistoryPanel /> : null}
          {section === "rules" ? (
            <ScrollFade>
              <HouseRulesPanel />
            </ScrollFade>
          ) : null}
        </div>
      </div>
    </div>
  );
}
