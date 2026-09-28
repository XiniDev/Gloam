import { ScrollText, Users } from "lucide-react";
import { type ReactElement, Suspense, useEffect, useRef, useState } from "react";
import { pendingProposals, useSheets } from "../net/sheets.ts";
import { useTable } from "../net/table.ts";
import { pendingCount, useLibrary } from "../state/library.ts";
import { type DockTab, useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";
import { lazyPage } from "../ui/lazyPage.ts";
import { Sparkle } from "../ui/ornaments.tsx";
import { hudOrder } from "./Intro.tsx";
import { insetMeasures, useHudInsets, useIsPhone, useMeasuredInset } from "./insets.ts";
import { PartyPanel } from "./PartyPanel.tsx";
import { SheetPanel } from "./sheet/SheetPanel.tsx";

const DmPanel = lazyPage(() => import("./dm/DmPanel.tsx"));

const WIDTH_KEY = "gloam.dock.width";
const MIN_W = 320;
const MAX_W = 520;
/** The rail, the gap beside it and both screen gutters. */
const RAIL_ROOM = 84;

function loadWidth(): number {
  try {
    const n = Number(globalThis.localStorage?.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= MIN_W && n <= MAX_W ? n : 380;
  } catch {
    return 380;
  }
}

/**
 * The right dock (SPEC §28 Dock, §29.3): an icon rail and a resizable panel (320–520 px, remembered on this device).
 * Phase 2 has the party and, for DMs, the DM panel (scenes, library, approvals); sheet, spells and the log arrive
 * with their phases.
 */
export function Dock() {
  const tab = useUi((s) => s.dock);
  const role = useTable((s) => s.me?.role);
  const dm = role === "dm" || role === "admin";
  const pending = useLibrary(pendingCount) + useSheets(pendingProposals);
  const [width, setWidth] = useState(loadWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const phone = useIsPhone();
  const banner = useHudInsets((s) => s.banner);
  useMeasuredInset("right", asideRef, insetMeasures.right);
  // On a phone the rail takes the top-right corner, not a column down the side.
  const railRef = useRef<HTMLElement>(null);
  useMeasuredInset("cornerRight", railRef, insetMeasures.corner, phone);

  useEffect(() => {
    if (tab === "dm" && !dm) useUi.getState().set({ dock: null });
  }, [tab, dm]);

  const tabs: { id: DockTab; label: string; icon: ReactElement; badge?: number }[] = [
    { id: "party", label: "Party", icon: <Users size={19} /> },
    { id: "sheet", label: "Sheet", icon: <ScrollText size={19} /> },
    ...(dm ? [{ id: "dm" as const, label: "DM panel", icon: <Sparkle size={18} />, badge: pending }] : []),
  ];

  const order = hudOrder(2);
  const toggle = (id: DockTab) => useUi.getState().set({ dock: tab === id ? null : id });

  return (
    <aside
      ref={asideRef}
      {...order}
      className="pointer-events-none absolute bottom-3 right-3 z-30 flex items-stretch gap-2"
      // Below the top bar — and on phones below the prep banner, which spans the screen there. (Merged with the
      // intro's stagger variable, which a second `style` prop would drop.)
      style={{ ...order.style, top: 68 + (phone ? banner : 0) }}
      data-hud="dock"
    >
      {tab ? (
        <section
          className="panel pointer-events-auto relative flex min-w-0 flex-col overflow-hidden"
          // Never wider than the screen leaves beside the rail (phones: nearly full width, over the toolbar, until
          // P14's bottom sheets).
          style={{ width: `min(${width}px, calc(100vw - ${RAIL_ROOM}px))` }}
          aria-label={tab === "dm" ? "DM panel" : tab === "sheet" ? "Character sheet" : "Party"}
        >
          {/* Resize handle on the panel's left edge. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-valuemin={MIN_W}
            aria-valuemax={MAX_W}
            aria-valuenow={width}
            tabIndex={0}
            className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize hover:bg-[var(--glow-brass-soft)] focus-visible:bg-[var(--glow-brass-soft)]"
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, w: width };
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              setWidth(Math.min(MAX_W, Math.max(MIN_W, drag.current.w + (drag.current.x - e.clientX))));
            }}
            onPointerUp={() => {
              drag.current = null;
              try {
                globalThis.localStorage?.setItem(WIDTH_KEY, String(width));
              } catch {
                // storage blocked: width lasts for this page only
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setWidth((w) => Math.min(MAX_W, w + 20));
              if (e.key === "ArrowRight") setWidth((w) => Math.max(MIN_W, w - 20));
            }}
          />
          <ErrorBoundary where={tab}>
            {tab === "party" ? <PartyPanel /> : null}
            {tab === "sheet" ? <SheetPanel /> : null}
            {tab === "dm" && dm ? (
              <Suspense fallback={null}>
                <DmPanel />
              </Suspense>
            ) : null}
          </ErrorBoundary>
        </section>
      ) : null}
      <nav
        ref={railRef}
        aria-label="Panels"
        className="panel pointer-events-auto flex flex-col items-center gap-1 self-start p-1.5"
      >
        {tabs.map((t) => (
          <div key={t.id} className="relative">
            <IconButton
              label={t.badge ? `${t.label} (${t.badge} waiting for approval)` : t.label}
              active={tab === t.id}
              onClick={() => toggle(t.id)}
            >
              {t.icon}
            </IconButton>
            {t.badge ? (
              <span
                className="tabular pointer-events-none absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-12 font-bold text-ink-950"
                aria-hidden
              >
                {t.badge}
              </span>
            ) : null}
          </div>
        ))}
      </nav>
    </aside>
  );
}
