import { Hand, MousePointer2, Radar, Ruler, X } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { boardApi } from "../board/boardApi.ts";
import { setFogShape } from "../board/tools/fog.ts";
import { setWallMode, useWallTool } from "../board/tools/walls.ts";
import { HoodedLanternIcon } from "../icons/lights.tsx";
import { FogIcon, WallsIcon, ZonesIcon } from "../icons/table.tsx";
import { request, useTable } from "../net/table.ts";
import { type Tool, useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";
import { ScrollFade } from "../ui/ScrollFade.tsx";
import { openEmoteWheel } from "./EmoteWheel.tsx";
import { hudOrder } from "./Intro.tsx";
import {
  insetMeasures,
  underTopBar,
  useCover,
  useHudInsets,
  useIsPhone,
  useMeasuredInset,
} from "./insets.ts";

/** Quick Unit glyph: a coin with a plus (custom, since creatures are a game concept; SPEC §27.6). */
function QuickUnitGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
    >
      <ellipse cx="11" cy="15" rx="7.5" ry="3.2" />
      <path d="M3.5 15v2.2c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2V15" />
      <path d="M11 6.5a2.2 2.2 0 1 0 0-.01M7.5 12.5c.6-1.8 2-2.8 3.5-2.8s2.9 1 3.5 2.8" />
      <path d="M19 3v5M16.5 5.5h5" />
    </svg>
  );
}

/** SPEC §29.3 left toolbar and Appendix H keys (H is Hand raise; panning also works with Space+drag). */
const TOOLS: { id: Tool; label: string; key?: string; icon: ReactElement; dm?: boolean }[] = [
  { id: "select", label: "Select", key: "V", icon: <MousePointer2 size={19} /> },
  { id: "pan", label: "Pan (or Space+drag)", icon: <Hand size={19} /> },
  { id: "measure", label: "Measure", key: "M", icon: <Ruler size={19} /> },
  { id: "ping", label: "Ping (or Alt+click)", icon: <Radar size={19} /> },
  { id: "walls", label: "Walls", key: "W", icon: <WallsIcon size={19} />, dm: true },
  { id: "zones", label: "Zones", key: "Z", icon: <ZonesIcon size={19} />, dm: true },
  { id: "lights", label: "Lights", key: "I", icon: <HoodedLanternIcon size={19} />, dm: true },
  { id: "fog", label: "Fog", key: "B", icon: <FogIcon size={19} />, dm: true },
];

/** Tools whose options open as a bar along the bottom (a sheet on phones). */
const SHEET_TOOLS: readonly Tool[] = ["measure", "walls", "zones", "lights", "fog"];

/** Picks a tool from the toolbar: a second press on the tool in hand puts it down (back to Select). */
function pick(t: Tool): void {
  const now = useUi.getState().tool;
  useUi.getState().set({ tool: now === t && t !== "select" ? "select" : t });
}

/** The toolbar's buttons: everyone's tools, then the DM's, then Quick unit. */
function ToolButtons({ tool, dm, after }: { tool: Tool; dm: boolean; after?: () => void }) {
  const button = (t: (typeof TOOLS)[number]) => (
    <IconButton
      key={t.id}
      label={t.label}
      shortcut={t.key}
      active={tool === t.id}
      onClick={() => {
        pick(t.id);
        after?.();
      }}
    >
      {t.icon}
    </IconButton>
  );
  return (
    <>
      {TOOLS.filter((t) => !t.dm).map(button)}
      {dm ? (
        <>
          <span className="my-1 h-px w-7 bg-[var(--line-soft)]" aria-hidden />
          {TOOLS.filter((t) => t.dm).map(button)}
          <IconButton
            label="Quick unit"
            shortcut="Q"
            onClick={() => {
              openQuickUnit();
              after?.();
            }}
          >
            <QuickUnitGlyph />
          </IconButton>
        </>
      ) : null}
    </>
  );
}

/**
 * The board's left toolbar (SPEC §29.3). Tools arrive with their phases; only working ones are shown. On a phone
 * (§29.4 has no side rail) it folds into one button in the top-left corner showing the tool in hand, which drops the
 * list open.
 */
export function LeftToolbar() {
  const tool = useUi((s) => s.tool);
  const role = useTable((s) => s.me?.role);
  const dm = role === "dm" || role === "admin";
  const phone = useIsPhone();
  useToolKeys(dm);
  return phone ? <PhoneTools tool={tool} dm={dm} /> : <Rail tool={tool} dm={dm} />;
}

function Rail({ tool, dm }: { tool: Tool; dm: boolean }) {
  const navRef = useRef<HTMLElement>(null);
  const banner = useHudInsets((s) => s.banner);
  const tracker = useHudInsets((s) => s.tracker);
  useMeasuredInset("left", navRef, insetMeasures.left);
  useCover("toolbar", navRef);
  return (
    // Between the top bar (and a banner or the tracker under it) and the foot of the screen: in the middle of that when
    // it fits, scrolling when a short screen can't hold every tool — a phone on its side ran the DM's column off both
    // ends, its first tool under the title.
    <div
      className="pointer-events-none absolute bottom-3 left-3 z-30 flex flex-col justify-center"
      style={{ top: underTopBar(banner + tracker) }}
    >
      <nav
        ref={navRef}
        {...hudOrder(1)}
        aria-label="Board tools"
        data-hud="toolbar"
        className="panel pointer-events-auto flex max-h-full min-h-0 min-w-[52px] flex-col overflow-hidden p-1.5"
      >
        <ScrollFade
          outerClassName="min-h-0"
          className="flex flex-col items-center gap-1 [scrollbar-width:none]"
          chevrons
        >
          <ToolButtons tool={tool} dm={dm} />
        </ScrollFade>
      </nav>
    </div>
  );
}

/**
 * Phones: the toolbar as one button in the top-left corner (mirroring the dock's rail in the top-right) with the tool
 * in hand on it; pressing it drops the tools open below, and picking one (or pressing anywhere else) folds them away.
 * While a tool's sheet is open along the bottom — or the map tools are — the corner is left clear: the sheet's Close
 * puts the tool down.
 */
function PhoneTools({ tool, dm }: { tool: Tool; dm: boolean }) {
  const [open, setOpen] = useState(false);
  const banner = useHudInsets((s) => s.banner);
  // In combat the tracker spans a phone's width under the top bar: the corner steps down below it.
  const tracker = useHudInsets((s) => s.tracker);
  const aligning = useUi((s) => s.mapTool !== null);
  const navRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const shown = !aligning && !SHEET_TOOLS.includes(tool);
  // A bottom sheet raised past the corner (a panel at 95 %) would leave the button's top peeking over its edge
  // (critic RSP-01 r1): the button steps out of sight under it — its corner kept, so nothing moves — and back as the
  // sheet comes down. (The bottom band is the sheet's top edge's distance from the bottom, plus the gap.)
  const band = useHudInsets((s) => s.bottom);
  const corner = useHudInsets((s) => s.cornerLeft);
  const underSheet = band > 0 && corner > 0 && window.innerHeight - band < corner;
  // No side column on a phone: the corner is the HUD's instead.
  useEffect(() => {
    useHudInsets.getState().set({ left: 0 });
  }, []);
  useMeasuredInset("cornerLeft", buttonRef, insetMeasures.corner, shown);
  useCover("toolbar", navRef, shown && !underSheet);
  useEffect(() => {
    if (underSheet) setOpen(false);
  }, [underSheet]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!shown) return null;
  const current = TOOLS.find((t) => t.id === tool) ?? (TOOLS[0] as (typeof TOOLS)[number]);
  const order = hudOrder(1);
  return (
    <nav
      ref={navRef}
      {...order}
      aria-label="Board tools"
      data-hud="toolbar"
      data-under-sheet={underSheet ? "true" : undefined}
      className={`panel pointer-events-auto absolute left-3 z-30 flex flex-col items-center gap-1 p-1.5 ${underSheet ? "invisible" : ""}`}
      // 12 px under the top bar (3.5 rem: it grows with the UI scale), and under a banner or the tracker.
      style={{ ...order.style, top: underTopBar(banner + tracker) }}
    >
      <div ref={buttonRef}>
        <IconButton
          label={open ? "Close tools" : `Tools: ${current.label}`}
          aria-expanded={open}
          active={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X size={19} /> : current.icon}
        </IconButton>
      </div>
      {open ? (
        <>
          <span className="my-1 h-px w-7 bg-[var(--line-soft)]" aria-hidden />
          <ToolButtons tool={tool} dm={dm} after={() => setOpen(false)} />
        </>
      ) : null}
    </nav>
  );
}

/** The toolbar's keys (Appendix H): V, M, H, G, W / Shift+W, Z, I, B, R, Q. */
function useToolKeys(dm: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ui = useUi.getState();
      // The 3D map tools use W / E / R for their gizmo while they're open.
      if (ui.mapTool && (e.code === "KeyW" || e.code === "KeyE" || e.code === "KeyR")) return;
      // Shift+W: the Walls tool drawing doors.
      if (e.shiftKey) {
        if (e.code === "KeyW" && dm) drawWalls("door");
        return;
      }
      if (e.code === "KeyV") ui.set({ tool: "select" });
      else if (e.code === "KeyM") ui.set({ tool: ui.tool === "measure" ? "select" : "measure" });
      else if (e.code === "KeyH") void request("hand.toggle", {}).catch(() => {});
      else if (e.code === "KeyE") {
        // (The key's own press shouldn't type into the wheel's first field.)
        e.preventDefault();
        openEmoteWheel();
      } else if (e.code === "KeyG") ui.set({ rangeOverlay: !ui.rangeOverlay });
      else if (e.code === "KeyW" && dm) drawWalls("wall");
      else if (e.code === "KeyZ" && dm) ui.set({ tool: "zones" });
      else if (e.code === "KeyI" && dm) ui.set({ tool: "lights" });
      else if (e.code === "KeyB" && dm) {
        setFogShape("brush");
        ui.set({ tool: "fog" });
      } else if (e.code === "KeyR" && dm) {
        setFogShape("room");
        ui.set({ tool: "fog" });
      } else if (e.code === "KeyQ" && dm) openQuickUnit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dm]);
}

/** W / Shift+W: the Walls tool, drawing walls or doors. */
function drawWalls(kind: "wall" | "door"): void {
  useUi.getState().set({ tool: "walls", wallKind: kind });
  if (useWallTool.getState().mode === "select") setWallMode("draw");
}

/** Opens the Quick Unit dialog, placing the unit at the cursor (or the view's centre). */
export function openQuickUnit(): void {
  const el = boardApi.element;
  const r = el?.getBoundingClientRect();
  const at = boardApi.cursor ??
    (r ? boardApi.groundAt(r.left + r.width / 2, r.top + r.height / 2) : null) ?? { x: 0, y: 0 };
  useUi.getState().set({ quickUnit: at });
}
