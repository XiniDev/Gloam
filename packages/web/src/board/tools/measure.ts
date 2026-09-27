import { create } from "zustand";
import { send } from "../../net/table.ts";
import { boardData, useEntities } from "../../state/entities.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { boardApi } from "../boardApi.ts";
import { wake } from "../frames.ts";

/**
 * Measurement tools (SPEC §8.6; AC-MOV-11/12, AC-TOK-07): Ruler (click to add points; each segment and the total),
 * Radius, Cone (53.13°: its width at distance x equals x), Line (5 ft wide by default) and Cube. Points on a token
 * snap to its centre at its elevation, so a ruler between flying creatures measures in 3D. A finished measurement
 * is shown to everyone else for 3 s unless "Share my rulers" is off. Esc clears.
 */
export interface P3 {
  x: number;
  y: number;
  z: number;
}
export type MeasureShape = "ruler" | "radius" | "cone" | "line" | "cube";

export interface Measurement {
  shape: MeasureShape;
  points: P3[];
  widthFt?: number;
}

export interface SharedMeasurement extends Measurement {
  by: string;
  name: string;
  color: string;
  at: number;
}

interface MeasureState {
  /** Placed points (ruler) or the origin (other shapes). */
  points: P3[];
  /** The live end under the pointer. */
  pointer: P3 | null;
  /** Pointer held (radius, cone, line, cube drag). */
  dragging: boolean;
  /** The measurement is finished (it stays until Esc or the next one). */
  done: boolean;
  shared: SharedMeasurement[];
}

export const useMeasure = create<MeasureState>(() => ({
  points: [],
  pointer: null,
  dragging: false,
  done: false,
  shared: [],
}));

export const SHARE_MS = 3000;

/** 3-D length of a polyline (feet). */
export function length3(points: P3[]): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as P3;
    const b = points[i] as P3;
    s += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return s;
}

/** The measurement being drawn (placed points plus the live end), or null. */
export function current(): Measurement | null {
  const s = useMeasure.getState();
  const shape = useUi.getState().measureShape;
  if (!s.points.length) return null;
  const pts = s.done || !s.pointer ? s.points : [...s.points, s.pointer];
  if (pts.length < 2) return null;
  return {
    shape,
    points: shape === "ruler" ? pts : [pts[0] as P3, pts[pts.length - 1] as P3],
    widthFt: useUi.getState().lineWidthFt,
  };
}

/** The table point under the pointer — on a token, its centre at its elevation. */
function pointAt(clientX: number, clientY: number): P3 | null {
  const id = boardApi.tokenAt(clientX, clientY);
  if (id) {
    const t = boardData(useEntities.getState()).tokens.get(id);
    if (t) return { x: t.pos.x, y: t.pos.y, z: t.elevation };
  }
  const g = boardApi.groundAt(clientX, clientY);
  return g ? { x: g.x, y: g.y, z: 0 } : null;
}

export function measureDown(clientX: number, clientY: number): void {
  const p = pointAt(clientX, clientY);
  if (!p) return;
  const s = useMeasure.getState();
  const shape = useUi.getState().measureShape;
  if (shape === "ruler") {
    if (s.done || !s.points.length) useMeasure.setState({ points: [p], pointer: p, done: false });
    else useMeasure.setState({ points: [...s.points, p] });
  } else useMeasure.setState({ points: [p], pointer: p, dragging: true, done: false });
  wake();
}

export function measureMove(clientX: number, clientY: number): void {
  const s = useMeasure.getState();
  if (!s.points.length || s.done) return;
  const p = pointAt(clientX, clientY);
  if (p) useMeasure.setState({ pointer: p });
  wake();
}

export function measureUp(): void {
  const s = useMeasure.getState();
  if (!s.dragging) return;
  useMeasure.setState({ dragging: false });
  const m = current();
  if (m && length3(m.points) >= 0.5) finish();
  else useMeasure.setState({ points: [], pointer: null });
}

/** Double-click or Enter (ruler), release (the others): the measurement stands, and is shared. */
export function finish(): void {
  const m = current();
  if (!m) return;
  // A ruler's double-click adds the same point twice: drop the duplicate end.
  const pts = m.points.filter((p, i) => i === 0 || length3([m.points[i - 1] as P3, p]) > 1e-3);
  if (pts.length < 2) return;
  useMeasure.setState({ points: pts, pointer: null, done: true, dragging: false });
  if (useSettings.getState().shareRulers !== false)
    send("measure.share", { shape: m.shape, points: pts.slice(0, 32), widthFt: m.widthFt });
  wake();
}

export function clearMeasure(): boolean {
  const s = useMeasure.getState();
  if (!s.points.length) return false;
  useMeasure.setState({ points: [], pointer: null, done: false, dragging: false });
  wake();
  return true;
}

/** Someone else's finished measurement: shown for 3 s. */
export function onSharedMeasure(m: Measurement & { by: string; name: string; color: string }): void {
  const item: SharedMeasurement = { ...m, at: performance.now() };
  useMeasure.setState({ shared: [...useMeasure.getState().shared.filter((x) => x.by !== m.by), item] });
  wake();
  setTimeout(() => {
    useMeasure.setState({ shared: useMeasure.getState().shared.filter((x) => x !== item) });
    wake();
  }, SHARE_MS);
}

/** The cone's outline (SPEC §17.1: width at distance x equals x → half-angle atan(½) ≈ 26.57°). */
export function conePolygon(origin: P3, end: P3, steps = 24): { x: number; y: number }[] {
  const len = Math.hypot(end.x - origin.x, end.y - origin.y);
  const dir = Math.atan2(end.y - origin.y, end.x - origin.x);
  const half = Math.atan(0.5);
  const pts = [{ x: origin.x, y: origin.y }];
  for (let i = 0; i <= steps; i++) {
    const a = dir - half + (2 * half * i) / steps;
    pts.push({ x: origin.x + Math.cos(a) * len, y: origin.y + Math.sin(a) * len });
  }
  return pts;
}

/** A line's rectangle, `width` wide, from origin to end. */
export function linePolygon(origin: P3, end: P3, width: number): { x: number; y: number }[] {
  const len = Math.hypot(end.x - origin.x, end.y - origin.y) || 1;
  const nx = (-(end.y - origin.y) / len) * (width / 2);
  const ny = ((end.x - origin.x) / len) * (width / 2);
  return [
    { x: origin.x + nx, y: origin.y + ny },
    { x: end.x + nx, y: end.y + ny },
    { x: end.x - nx, y: end.y - ny },
    { x: origin.x - nx, y: origin.y - ny },
  ];
}

/** A cube's square: from the origin corner toward the pointer, side = the larger offset. */
export function cubePolygon(origin: P3, end: P3): { x: number; y: number }[] {
  const s = Math.max(Math.abs(end.x - origin.x), Math.abs(end.y - origin.y));
  const sx = end.x >= origin.x ? 1 : -1;
  const sy = end.y >= origin.y ? 1 : -1;
  return [
    { x: origin.x, y: origin.y },
    { x: origin.x + sx * s, y: origin.y },
    { x: origin.x + sx * s, y: origin.y + sy * s },
    { x: origin.x, y: origin.y + sy * s },
  ];
}

/** The number a measurement reports: path length (ruler), radius, length (cone, line) or side (cube). */
export function measuredFt(m: Measurement): number {
  const a = m.points[0] as P3;
  const b = m.points[m.points.length - 1] as P3;
  if (m.shape === "ruler") return length3(m.points);
  if (m.shape === "cube") return Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return Math.hypot(b.x - a.x, b.y - a.y, m.shape === "radius" ? 0 : b.z - a.z);
}
