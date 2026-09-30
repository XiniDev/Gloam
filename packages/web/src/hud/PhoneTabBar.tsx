import { BookOpen, History, Map as MapIcon, MoreHorizontal, ScrollText, Users } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { D20Icon } from "../icons/dice.tsx";
import { useFun } from "../net/fun.ts";
import { useTable } from "../net/table.ts";
import { type DockTab, useUi } from "../state/ui.ts";
import { useOpenSheets } from "../ui/BottomSheet.tsx";
import { Menu } from "../ui/Menu.tsx";
import { Sparkle } from "../ui/ornaments.tsx";
import { useApprovalsCount } from "./dm/approvalsCount.ts";
import { FirstSteps, useNeedsCharacter } from "./FirstSteps.tsx";
import { insetMeasures, useCover, useIsPhone, useMeasuredInset } from "./insets.ts";

/** The tab bar's height above the safe area (SPEC §29.4: 64 px). */
export const TAB_BAR_H = 64;

const TAB =
  "relative flex h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-12 font-bold transition-colors duration-[var(--dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brass";

function Tab({
  label,
  short,
  icon,
  active,
  onClick,
  testId,
  badge,
  children,
}: {
  label: string;
  short?: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  testId?: string;
  badge?: number;
  children?: ReactNode;
}) {
  return (
    <div className="relative flex min-w-0 flex-1">
      {children}
      <button
        type="button"
        aria-label={badge ? `${label} (${badge})` : label}
        aria-pressed={active}
        data-testid={testId}
        onClick={onClick}
        className={`${TAB} ${active ? "text-brass-bright" : "text-muted hover:text-bone"}`}
      >
        {/* The open one: a brass stroke along its top edge. */}
        {active ? (
          <span className="absolute inset-x-4 top-0 h-0.5 rounded-b-chip bg-brass" aria-hidden />
        ) : null}
        <span className="relative">
          {icon}
          {badge ? <Badge n={badge} /> : null}
        </span>
        <span aria-hidden>{short ?? label}</span>
      </button>
    </div>
  );
}

function Badge({ n }: { n: number }) {
  return (
    <span
      className="tabular pointer-events-none absolute -right-2.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-12 font-bold text-ink-950"
      aria-hidden
    >
      {n}
    </span>
  );
}

/**
 * A phone's tab bar (SPEC §29.4): Board · Sheet · Dice · Log · More along the bottom edge, 64 px over the safe area —
 * the board, your sheet, the dice tray, the rolls, and the rest (Party, Journal, the DM panel) a menu away. Each opens
 * as a bottom sheet, which rises over the bar (it steps aside while one is open, and comes back when it closes). The
 * bar is the HUD's bottom band: the camera frames above it and cards stand clear of it.
 */
export function PhoneTabBar() {
  const phone = useIsPhone();
  const me = useTable((s) => s.me);
  const dock = useUi((s) => s.dock);
  const dice = useUi((s) => s.diceTray);
  const rolls = useUi((s) => s.rollsOpen);
  const sheets = useOpenSheets((s) => s.n);
  const dm = me?.role === "dm" || me?.role === "admin";
  const pending = useApprovalsCount();
  const unread = useFun((s) => s.unread);
  const needsCharacter = useNeedsCharacter();
  const ref = useRef<HTMLElement>(null);
  const shown = phone && me !== null && sheets === 0;
  useMeasuredInset("bottom", ref, insetMeasures.bottom, shown);
  useCover("tab-bar", ref, shown);
  if (!shown) return null;
  const set = useUi.getState().set;
  const open = (p: { dock?: DockTab | null; diceTray?: boolean; rollsOpen?: boolean }) =>
    set({ dock: null, diceTray: false, rollsOpen: false, ...p });
  const more = (dm ? pending : 0) + unread;
  const panels: { id: DockTab; label: string; icon: ReactNode; badge: number }[] = [
    { id: "party", label: "Party", icon: <Users size={16} />, badge: 0 },
    { id: "journal", label: "Journal", icon: <BookOpen size={16} />, badge: unread },
    ...(dm ? [{ id: "dm" as const, label: "DM panel", icon: <Sparkle size={15} />, badge: pending }] : []),
  ];
  return (
    <nav
      ref={ref}
      aria-label="Panels"
      data-testid="tab-bar"
      className="panel pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex rounded-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]"
    >
      <Tab
        label="Board"
        icon={<MapIcon size={20} aria-hidden />}
        active={!dock && !dice && !rolls}
        onClick={() => open({})}
      />
      <Tab
        label="Sheet"
        icon={<ScrollText size={20} aria-hidden />}
        active={dock === "sheet"}
        onClick={() => open({ dock: dock === "sheet" ? null : "sheet" })}
      >
        {needsCharacter && !dock ? <FirstSteps /> : null}
      </Tab>
      <Tab
        label="Dice tray"
        short="Dice"
        testId="dice-button"
        icon={<D20Icon size={20} />}
        active={dice}
        onClick={() => open({ diceTray: !dice })}
      />
      <Tab
        label="Rolls"
        short="Log"
        testId="rolls-tab"
        icon={<History size={20} aria-hidden />}
        active={rolls}
        onClick={() => open({ rollsOpen: !rolls })}
      />
      <div className="relative flex min-w-0 flex-1">
        <Menu
          label={more ? `More (${more})` : "More"}
          up
          trigger={{
            testId: "more-tab",
            className: `${TAB} text-muted hover:text-bone`,
            content: (
              <>
                <span className="relative">
                  <MoreHorizontal size={20} aria-hidden />
                  {more ? <Badge n={more} /> : null}
                </span>
                <span aria-hidden>More</span>
              </>
            ),
          }}
          items={panels.map((p) => ({
            label: p.badge ? `${p.label} (${p.badge})` : p.label,
            icon: p.icon,
            onSelect: () => open({ dock: p.id }),
          }))}
        />
      </div>
    </nav>
  );
}
