import { pendingCount, useLibrary } from "../../state/library.ts";
import { type DmSection, useUi } from "../../state/ui.ts";
import { WaxSeal } from "../../ui/ornaments.tsx";
import { ApprovalsPanel } from "./ApprovalsPanel.tsx";
import { LibraryPanel } from "./LibraryPanel.tsx";
import { ScenesPanel } from "./ScenesPanel.tsx";

const SECTIONS: { id: DmSection; label: string }[] = [
  { id: "scenes", label: "Scenes" },
  { id: "library", label: "Library" },
  { id: "approvals", label: "Approvals" },
];

/** The DM panel (SPEC §8.3 DM scene tools, §8.16 Library and Approvals). Later phases add their sections here. */
export default function DmPanel() {
  const section = useUi((s) => s.dmSection);
  const pending = useLibrary(pendingCount);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 pb-0 pt-3">
        <WaxSeal size={20} />
        <h2 className="text-18 text-bone">DM panel</h2>
      </header>
      <div role="tablist" aria-label="DM panel sections" className="flex gap-1 border-b border-line px-3">
        {SECTIONS.map((s) => {
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => useUi.getState().set({ dmSection: s.id })}
              className={`relative flex h-10 items-center gap-1.5 px-3 text-14 font-bold transition-colors duration-[var(--dur-fast)] ${
                active ? "text-brass-bright" : "text-muted hover:text-bone"
              }`}
            >
              {s.label}
              {s.id === "approvals" && pending ? (
                <span className="tabular grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-12 text-ink-950">
                  {pending}
                </span>
              ) : null}
              {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {section === "scenes" ? <ScenesPanel /> : null}
        {section === "library" ? <LibraryPanel /> : null}
        {section === "approvals" ? <ApprovalsPanel /> : null}
      </div>
    </div>
  );
}
