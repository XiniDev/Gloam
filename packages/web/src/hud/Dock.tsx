import { BookOpen, ScrollText, Users, X } from "lucide-react";
import { type ReactElement, Suspense, useEffect, useRef, useState } from "react";
import { useFun } from "../net/fun.ts";
import { useTable } from "../net/table.ts";
import { type DockTab, useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";
import { lazyPage } from "../ui/lazyPage.ts";
import { Sparkle } from "../ui/ornaments.tsx";
import { useApprovalsCount } from "./dm/approvalsCount.ts";
import { FirstSteps, useNeedsCharacter } from "./FirstSteps.tsx";
import { PromptCards } from "./health/PromptCards.tsx";
import { hudOrder } from "./Intro.tsx";
import {
  insetMeasures,
  useBoardCovers,
  useCover,
  useHudInsets,
  useIsPhone,
  useMeasuredInset,
} from "./insets.ts";
import { JournalPanel } from "./journal/JournalPanel.tsx";
import { PartyPanel } from "./PartyPanel.tsx";
import { RequestCards } from "./RequestCards.tsx";
import { SheetPanel } from "./sheet/SheetPanel.tsx";

const DmPanel = lazyPage(() => import("./dm/DmPanel.tsx"));

const WIDTH_KEY = "gloam.dock.width";
const MIN_W = 320;
const MAX_W = 520;
/** The rail, the gap beside it and both screen gutters. */
const RAIL_ROOM = 84;
/** A phone's right inset: its gutter (the rail is a row in the corner). */
const PHONE_RIGHT = () => 12;

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
  // Everything waiting for the DM (AC-DMP-04): knocks, uploads, sheet and homebrew proposals.
  const pending = useApprovalsCount();
  // Handouts given since the Journal was last open (a player's reminder that something is waiting).
  const unread = useFun((s) => s.unread);
  const [width, setWidth] = useState(loadWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const phone = useIsPhone();
  const banner = useHudInsets((s) => s.banner);
  const tracker = useHudInsets((s) => s.tracker);
  const actionBand = useHudInsets((s) => s.bottom);
  // A phone's rail is a row in the top-right corner (cornerRight), not a column down the side: nothing holds the
  // right edge below it, so the HUD beside it and the board's clear area take the whole width.
  useMeasuredInset("right", asideRef, phone ? PHONE_RIGHT : insetMeasures.right);
  // What of it is drawn over the board: the open panel and the rail (the dock's own box is an invisible column the
  // height of the screen — plates beside the rail were hidden under nothing).
  const panelRef = useRef<HTMLElement>(null);
  useCover("dock-panel", panelRef, tab !== null);
  // On a phone the rail takes the top-right corner, not a column down the side.
  const railRef = useRef<HTMLElement>(null);
  useMeasuredInset("cornerRight", railRef, insetMeasures.corner, phone);
  useCover("dock-rail", railRef, !(phone && tab !== null));

  useEffect(() => {
    if (tab === "dm" && !dm) useUi.getState().set({ dock: null });
  }, [tab, dm]);

  const tabs: { id: DockTab; label: string; icon: ReactElement; badge?: number }[] = [
    { id: "party", label: "Party", icon: <Users size={19} /> },
    { id: "sheet", label: "Sheet", icon: <ScrollText size={19} /> },
    { id: "journal", label: "Journal", icon: <BookOpen size={19} />, badge: unread },
    ...(dm ? [{ id: "dm" as const, label: "DM panel", icon: <Sparkle size={18} />, badge: pending }] : []),
  ];

  const order = hudOrder(2);
  const toggle = (id: DockTab) => useUi.getState().set({ dock: tab === id ? null : id });
  // A phone's panel is a page (§8.10: "a full-screen page on phones"): the whole width, the rail folded into a bar
  // across its top with the close button.
  const page = phone && tab !== null;
  // A phone's page ends above the toasts at its foot (a knock card stays until it's decided: under it, the rail's last
  // sections couldn't be reached).
  const toasts = useBoardCovers((s) => s.rects.toasts);
  const toastFoot =
    page && toasts && toasts.top > window.innerHeight / 2
      ? Math.round(window.innerHeight - toasts.top) + 4
      : 0;
  const needsCharacter = useNeedsCharacter();
  const railButtons = tabs.map((t) => (
    <div key={t.id} className="relative">
      {t.id === "sheet" && needsCharacter && tab === null ? <FirstSteps /> : null}
      <IconButton
        label={
          t.badge ? `${t.label} (${t.badge} ${t.id === "journal" ? "new" : "waiting for approval"})` : t.label
        }
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
  ));

  return (
    <aside
      ref={asideRef}
      {...order}
      className={`pointer-events-none absolute right-3 z-30 flex items-stretch gap-2 ${page ? "left-3" : ""}`}
      // Below the top bar — and on phones below the prep banner, which spans the screen there, and above the action
      // bar (its dice button stood on the sheet). (Merged with the intro's stagger variable, which a second `style`
      // prop would drop.)
      style={{
        ...order.style,
        // (A phone's rail steps down below the combat tracker, which spans the width under the top bar.)
        top: 68 + (phone ? banner + (page ? 0 : tracker) : 0),
        bottom: phone ? Math.max(12, actionBand, toastFoot) : 12,
      }}
      data-hud="dock"
    >
      {tab ? (
        <section
          ref={panelRef}
          className="panel pointer-events-auto relative flex min-w-0 flex-col overflow-hidden overflow-x-clip"
          // Never wider than the screen leaves beside the rail; on a phone, all of it.
          style={{ width: page ? "100%" : `min(${width}px, calc(100vw - ${RAIL_ROOM}px))` }}
          aria-label={
            tab === "dm"
              ? "DM panel"
              : tab === "sheet"
                ? "Character sheet"
                : tab === "journal"
                  ? "Journal"
                  : "Party"
          }
        >
          {page ? (
            <nav
              aria-label="Panels"
              className="flex shrink-0 items-center gap-1 border-b border-line px-1.5 py-1"
            >
              {railButtons}
              <span className="flex-1" />
              <IconButton label="Close panel" onClick={() => useUi.getState().set({ dock: null })}>
                <X size={19} />
              </IconButton>
            </nav>
          ) : null}
          {page ? <RequestCards /> : null}
          {page ? <PromptCards /> : null}
          {/* Resize handle on the panel's left edge. */}
          <div
            hidden={page}
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
            {tab === "journal" ? <JournalPanel /> : null}
            {tab === "dm" && dm ? (
              <Suspense fallback={null}>
                <DmPanel />
              </Suspense>
            ) : null}
          </ErrorBoundary>
        </section>
      ) : null}
      {/* Hidden, not unmounted, under a phone's page: its measured corner (what the request cards stand below)
          follows it back. */}
      <nav
        ref={railRef}
        aria-label="Panels"
        hidden={page}
        className={`panel pointer-events-auto flex items-center gap-1 self-start p-1.5 ${phone ? "flex-row" : "flex-col"}`}
      >
        {page ? null : railButtons}
      </nav>
    </aside>
  );
}
