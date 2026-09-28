import { BrickWall, CloudFog, Hand, Lamp, LandPlot, MousePointer2, Radar, Ruler } from "lucide-react";
import { type ReactElement, useEffect, useRef } from "react";
import { boardApi } from "../board/boardApi.ts";
import { setFogShape } from "../board/tools/fog.ts";
import { setWallMode, useWallTool } from "../board/tools/walls.ts";
import { request, useTable } from "../net/table.ts";
import { type Tool, useUi } from "../state/ui.ts";
import { IconButton } from "../ui/Button.tsx";
import { hudOrder } from "./Intro.tsx";
import { insetMeasures, useIsPhone, useMeasuredInset } from "./insets.ts";

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
  { id: "walls", label: "Walls", key: "W", icon: <BrickWall size={19} />, dm: true },
  { id: "zones", label: "Zones", key: "Z", icon: <LandPlot size={19} />, dm: true },
  { id: "lights", label: "Lights", key: "I", icon: <Lamp size={19} />, dm: true },
  { id: "fog", label: "Fog", key: "B", icon: <CloudFog size={19} />, dm: true },
];

/** The board's left toolbar (SPEC §29.3). Tools arrive with their phases; only working ones are shown. */
export function LeftToolbar() {
  const tool = useUi((s) => s.tool);
  const role = useTable((s) => s.me?.role);
  const dm = role === "dm" || role === "admin";
  const navRef = useRef<HTMLElement>(null);
  const phone = useIsPhone();
  // On a phone the map tools take the toolbar's place while they're open.
  const aligning = useUi((s) => s.mapTool !== null);
  useMeasuredInset("left", navRef, insetMeasures.left, !(phone && aligning));

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

  if (phone && aligning) return null;

  return (
    <nav
      ref={navRef}
      {...hudOrder(1)}
      aria-label="Board tools"
      data-hud="toolbar"
      className="panel pointer-events-auto absolute left-3 top-1/2 z-30 flex min-w-[52px] -translate-y-1/2 flex-col items-center gap-1 p-1.5"
    >
      {TOOLS.filter((t) => !t.dm).map((t) => (
        <IconButton
          key={t.id}
          label={t.label}
          shortcut={t.key}
          active={tool === t.id}
          onClick={() => useUi.getState().set({ tool: tool === t.id && t.id !== "select" ? "select" : t.id })}
        >
          {t.icon}
        </IconButton>
      ))}
      {dm ? (
        <>
          <span className="my-1 h-px w-7 bg-[var(--line-soft)]" aria-hidden />
          {TOOLS.filter((t) => t.dm).map((t) => (
            <IconButton
              key={t.id}
              label={t.label}
              shortcut={t.key}
              active={tool === t.id}
              onClick={() => useUi.getState().set({ tool: tool === t.id ? "select" : t.id })}
            >
              {t.icon}
            </IconButton>
          ))}
          <IconButton label="Quick unit" shortcut="Q" tone="accent" onClick={openQuickUnit}>
            <QuickUnitGlyph />
          </IconButton>
        </>
      ) : null}
    </nav>
  );
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
