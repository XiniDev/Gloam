import type { P } from "@gloam/shared/geometry";
import { type WorldZoneShape, zoneContains, zonePolygon } from "@gloam/shared/movement";
import type { ZoneView } from "@gloam/shared/state";
import { create } from "zustand";
import { request } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { toast } from "../../ui/Toast.tsx";
import { boardApi } from "../boardApi.ts";
import { cameraRig } from "../CameraRig.tsx";
import { wake } from "../frames.ts";
import { parseZoneShape } from "../map/zoneShape.ts";
import { MIN_WALL_FT, samePoint, snapPoint } from "./wallEdit.ts";
import { wallSegs } from "./walls.ts";

/**
 * The Zones tool (SPEC §8.7 Zones; AC-WAL-05), DM only.
 *
 * - **Rectangle** / **Circle**: drag out (a rectangle corner to corner, a circle from its centre).
 * - **Polygon**: click corners; clicking the first corner, double-click, Enter or Esc closes it; Backspace removes
 *   the last corner.
 * - **Select**: click a zone (the smallest one under the pointer, so a zone inside another can be picked) to edit it
 *   in the zone panel; drag it to move it; drag a handle to reshape it (a rectangle's corners, a circle's rim, a
 *   polygon's corners); Delete removes it.
 *
 * Points snap to wall ends within 1 ft (and to the polygon's own corners); Ctrl/Cmd turns snapping off. A new zone is
 * selected once it's drawn (the tool keeps drawing), so its label, colour, visibility, note and triggers can be set straight away.
 */

export type ZoneMode = "select" | "rect" | "circle" | "polygon";

interface ZoneToolState {
  mode: ZoneMode;
  /** The polygon being drawn. */
  points: P[];
  pointer: P | null;
  /** The shape being dragged out (rectangle or circle). */
  draft: WorldZoneShape | null;
  selected: string | null;
  /** A zone's shape while it's moved or reshaped, until the server's echo arrives. */
  preview: { id: string; shape: WorldZoneShape } | null;
  /** The handle under the pointer (select mode). */
  handle: P | null;
}

export const useZoneTool = create<ZoneToolState>(() => ({
  mode: "select",
  points: [],
  pointer: null,
  draft: null,
  selected: null,
  preview: null,
  handle: null,
}));

const DRAG_PX = 4;
const HANDLE_PX = 10;
const MIN_FT = 0.5;

const set = (p: Partial<ZoneToolState>) => {
  useZoneTool.setState(p);
  wake();
};
function lockCamera(on: boolean): void {
  const c = cameraRig.controls;
  if (c) c.enabled = !on;
}
function ftPerPx(x: number, y: number): number {
  const p = boardApi.groundAt(x, y);
  const q = boardApi.groundAt(x + 10, y);
  return p && q ? Math.hypot(q.x - p.x, q.y - p.y) / 10 : 0.05;
}

interface PointerLike {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

function snapAt(raw: P, e: PointerLike): P {
  const { segs, index } = wallSegs();
  return snapPoint(raw, {
    ends: index,
    segs: segs.values(),
    extra: useZoneTool.getState().points,
    off: e.ctrlKey || e.metaKey,
  }).p;
}

/** The zones on the board with their shapes. */
function zoneShapes(): { zone: ZoneView; shape: WorldZoneShape }[] {
  const out: { zone: ZoneView; shape: WorldZoneShape }[] = [];
  for (const zone of boardData(useEntities.getState()).zones.values()) {
    const shape = parseZoneShape(zone.shapeJson);
    if (shape) out.push({ zone, shape });
  }
  return out;
}

export function zoneArea(s: WorldZoneShape): number {
  if (s.kind === "circle") return Math.PI * s.r * s.r;
  if (s.kind === "rect") return s.w * s.h;
  const pts = s.points;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as P;
    const q = pts[(i + 1) % pts.length] as P;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

/** The smallest zone containing p (so an inner zone can be picked), or null. */
export function zoneAt(p: P): string | null {
  let best: string | null = null;
  let area = Number.POSITIVE_INFINITY;
  for (const { zone, shape } of zoneShapes()) {
    if (!zoneContains(shape, p)) continue;
    const a = zoneArea(shape);
    if (a < area) {
      best = zone.id;
      area = a;
    }
  }
  return best;
}

/** A shape's handles: a rectangle's four corners, a circle's rim point (east), a polygon's corners. */
export function handlesOf(s: WorldZoneShape): P[] {
  if (s.kind === "circle") return [{ x: s.x + s.r, y: s.y }];
  if (s.kind === "rect") return zonePolygon(s);
  return s.points;
}

/** A rectangle from two opposite corners. */
function rectFrom(a: P, b: P): WorldZoneShape {
  return {
    kind: "rect",
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function moved(s: WorldZoneShape, dx: number, dy: number): WorldZoneShape {
  if (s.kind === "polygon")
    return { kind: "polygon", points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  return { ...s, x: s.x + dx, y: s.y + dy };
}

/** The shape with handle `i` dragged to `to`. */
function reshaped(s: WorldZoneShape, i: number, to: P): WorldZoneShape {
  if (s.kind === "circle") return { ...s, r: Math.max(MIN_FT, Math.hypot(to.x - s.x, to.y - s.y)) };
  if (s.kind === "rect") {
    const corners = zonePolygon(s);
    const opposite = corners[(i + 2) % 4] as P;
    return rectFrom(opposite, to);
  }
  return { kind: "polygon", points: s.points.map((p, k) => (k === i ? to : p)) };
}

function validShape(s: WorldZoneShape): boolean {
  if (s.kind === "circle") return s.r >= MIN_FT;
  if (s.kind === "rect") return s.w >= MIN_FT && s.h >= MIN_FT;
  return s.points.length >= 3 && zoneArea(s) >= MIN_FT * MIN_FT;
}

let press: {
  sx: number;
  sy: number;
  at: P;
  started: boolean;
  kind: "draw" | "move" | "handle";
  zone?: { id: string; shape: WorldZoneShape };
  handle?: number;
} | null = null;

/** A left press with the Zones tool; false when the board should handle it (Alt+click pings). */
export function zonesDown(e: PointerLike): boolean {
  const raw = boardApi.groundAt(e.clientX, e.clientY);
  if (!raw || e.altKey) return false;
  const s = useZoneTool.getState();
  if (s.mode === "polygon") {
    const p = snapAt(raw, e);
    const last = s.points[s.points.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_WALL_FT) return true;
    if (s.points.length >= 3 && samePoint(p, s.points[0] as P)) {
      closePolygon();
      return true;
    }
    set({ points: [...s.points, p], pointer: p });
    return true;
  }
  if (s.mode === "rect" || s.mode === "circle") {
    press = { sx: e.clientX, sy: e.clientY, at: snapAt(raw, e), started: false, kind: "draw" };
    lockCamera(true);
    return true;
  }
  // Select: a handle of the selected zone, the selected zone itself, or another zone.
  const sel = s.selected ? zoneShapes().find((z) => z.zone.id === s.selected) : undefined;
  if (sel) {
    const tol = HANDLE_PX * ftPerPx(e.clientX, e.clientY);
    const hs = handlesOf(sel.shape);
    const i = hs.findIndex((h) => Math.hypot(h.x - raw.x, h.y - raw.y) <= tol);
    if (i >= 0) {
      press = {
        sx: e.clientX,
        sy: e.clientY,
        at: raw,
        started: false,
        kind: "handle",
        zone: sel.zone && { id: sel.zone.id, shape: sel.shape },
        handle: i,
      };
      lockCamera(true);
      return true;
    }
  }
  const hit = zoneAt(raw);
  if (!hit) {
    set({ selected: null });
    return true;
  }
  const z = zoneShapes().find((x) => x.zone.id === hit);
  set({ selected: hit });
  if (z) {
    press = {
      sx: e.clientX,
      sy: e.clientY,
      at: raw,
      started: false,
      kind: "move",
      zone: { id: hit, shape: z.shape },
    };
    lockCamera(true);
  }
  return true;
}

export function zonesMove(e: PointerLike): void {
  const raw = boardApi.groundAt(e.clientX, e.clientY);
  if (!raw) return;
  const s = useZoneTool.getState();
  if (s.mode === "polygon") {
    set({ pointer: snapAt(raw, e) });
    return;
  }
  if (press) {
    if (!press.started && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) < DRAG_PX) return;
    press.started = true;
    if (press.kind === "draw") {
      const p = snapAt(raw, e);
      const a = press.at;
      set({
        draft:
          s.mode === "circle"
            ? { kind: "circle", x: a.x, y: a.y, r: Math.hypot(p.x - a.x, p.y - a.y) }
            : rectFrom(a, p),
        pointer: p,
      });
    } else if (press.kind === "move" && press.zone) {
      set({
        preview: {
          id: press.zone.id,
          shape: moved(press.zone.shape, raw.x - press.at.x, raw.y - press.at.y),
        },
      });
    } else if (press.kind === "handle" && press.zone && press.handle !== undefined) {
      set({
        preview: { id: press.zone.id, shape: reshaped(press.zone.shape, press.handle, snapAt(raw, e)) },
      });
    }
    return;
  }
  if (s.mode === "select" && s.selected) {
    const sel = zoneShapes().find((z) => z.zone.id === s.selected);
    const tol = HANDLE_PX * ftPerPx(e.clientX, e.clientY);
    const h = sel
      ? (handlesOf(sel.shape).find((q) => Math.hypot(q.x - raw.x, q.y - raw.y) <= tol) ?? null)
      : null;
    if (h !== s.handle) set({ handle: h });
  }
}

export function zonesUp(): void {
  const p = press;
  press = null;
  lockCamera(false);
  if (!p?.started) return;
  const s = useZoneTool.getState();
  if (p.kind === "draw") {
    const draft = s.draft;
    set({ draft: null });
    if (draft && validShape(draft)) void createZone(draft);
    return;
  }
  if (s.preview) void commitShape(s.preview.id, s.preview.shape);
}

export function zonesDoubleClick(): void {
  if (useZoneTool.getState().mode === "polygon") closePolygon();
}

/** Keys while the Zones tool is active; true when handled. */
export function zonesKey(e: KeyboardEvent): boolean {
  const s = useZoneTool.getState();
  if (s.mode === "polygon" && s.points.length) {
    if (e.key === "Enter" || e.key === "Escape") {
      if (s.points.length >= 3) closePolygon();
      else set({ points: [] });
      return true;
    }
    if (e.key === "Backspace") {
      set({ points: s.points.slice(0, -1) });
      return true;
    }
  }
  if (e.key === "Escape") {
    if (press) {
      press = null;
      lockCamera(false);
      set({ draft: null, preview: null });
    } else if (s.selected) set({ selected: null });
    else useUi.getState().set({ tool: "select" });
    return true;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && s.selected) {
    void deleteZone(s.selected);
    return true;
  }
  return false;
}

export function setZoneMode(mode: ZoneMode): void {
  press = null;
  // Drawing starts clean: the bar's kind then applies to the next zone, not to the one that was selected.
  set({
    mode,
    points: [],
    draft: null,
    pointer: null,
    handle: null,
    ...(mode === "select" ? {} : { selected: null }),
  });
}

export function closePolygon(): void {
  const s = useZoneTool.getState();
  if (s.points.length < 3) return;
  const shape: WorldZoneShape = { kind: "polygon", points: s.points };
  set({ points: [] });
  if (validShape(shape)) void createZone(shape);
}

async function createZone(shape: WorldZoneShape): Promise<void> {
  const sceneId = boardData(useEntities.getState()).scene?.id;
  if (!sceneId) return;
  const kind = useUi.getState().zoneKind;
  try {
    const r = await request<{ zoneId: string }>("zone.create", { sceneId, kind, shape: roundShape(shape) });
    // The new zone is selected (its panel opens for label, colour, triggers); the tool keeps drawing.
    set({ selected: r.zoneId });
  } catch (err) {
    toast.danger("Couldn't add that zone", (err as Error).message);
  }
}

async function commitShape(id: string, shape: WorldZoneShape): Promise<void> {
  const clear = () => {
    if (useZoneTool.getState().preview?.shape === shape) set({ preview: null });
  };
  if (!validShape(shape)) {
    clear();
    return;
  }
  try {
    const sent = roundShape(shape);
    await request("zone.update", { zoneId: id, shape: sent });
    const json = JSON.stringify(sent);
    const arrived = () => boardData(useEntities.getState()).zones.get(id)?.shapeJson === json;
    if (arrived()) clear();
    else {
      const off = useEntities.subscribe(() => {
        if (!arrived()) return;
        off();
        clear();
      });
      setTimeout(() => {
        off();
        clear();
      }, 2000);
    }
  } catch (err) {
    clear();
    toast.danger("Couldn't reshape that zone", (err as Error).message);
  }
}

export async function deleteZone(id: string): Promise<void> {
  set({ selected: null, handle: null });
  try {
    await request("zone.delete", { zoneIds: [id] });
    toast.info("Zone deleted", "Ctrl+Z brings it back.");
  } catch (err) {
    toast.danger("Couldn't delete that zone", (err as Error).message);
  }
}

/** Hundredths of a foot: plenty for a zone, and the shape reads back exactly as sent. */
function roundShape(s: WorldZoneShape): WorldZoneShape {
  const r = (v: number) => Math.round(v * 100) / 100;
  if (s.kind === "circle") return { kind: "circle", x: r(s.x), y: r(s.y), r: r(s.r) };
  if (s.kind === "rect") return { kind: "rect", x: r(s.x), y: r(s.y), w: r(s.w), h: r(s.h) };
  return { kind: "polygon", points: s.points.map((p) => ({ x: r(p.x), y: r(p.y) })) };
}

// Leaving the tool drops what was being drawn and the selection; a new scene starts clean; a deleted zone leaves it.
useUi.subscribe((ui, prev) => {
  if (prev.tool === "zones" && ui.tool !== "zones") {
    press = null;
    useZoneTool.setState({ points: [], draft: null, selected: null, handle: null, pointer: null });
  }
});
useEntities.subscribe((st) => {
  const s = useZoneTool.getState();
  if (s.selected && !boardData(st).zones.has(s.selected))
    useZoneTool.setState({ selected: null, handle: null });
});
