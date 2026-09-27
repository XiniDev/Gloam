import { PerspectiveCamera, Vector3 } from "three";
import type { Bounds } from "./scene.ts";

/** A rectangle on screen, in CSS pixels from the top-left. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Framing {
  position: [number, number, number];
  target: [number, number, number];
  distance: number;
}

const DEG = Math.PI / 180;

/**
 * The camera that shows a scene's whole map inside the part of the screen the HUD leaves visible (SPEC §8.4: scenes
 * open framed at the tabletop preset): at the given pitch, looking north, the map's four corners project inside
 * `visible` (less a margin), and the map sits centred in it — not in the middle of the screen, where the dock or
 * the toolbar would cover part of it. Works for any aspect ratio (a portrait phone frames by its width).
 */
export function frameBounds(opts: {
  bounds: Bounds;
  width: number;
  height: number;
  fovDeg: number;
  pitchDeg: number;
  visible: ScreenRect;
  margin?: number;
  minDistance?: number;
  maxDistance?: number;
}): Framing {
  const { bounds: b, width: W, height: H } = opts;
  const m = opts.margin ?? 24;
  const cam = new PerspectiveCamera(opts.fovDeg, W / Math.max(1, H), 0.5, 4000);
  const pitch = opts.pitchDeg * DEG;
  const corners = [
    new Vector3(b.minX, 0, b.minY),
    new Vector3(b.maxX, 0, b.minY),
    new Vector3(b.minX, 0, b.maxY),
    new Vector3(b.maxX, 0, b.maxY),
  ];
  const v = opts.visible;
  const rect = {
    left: v.left + m,
    right: Math.max(v.left + m + 1, v.right - m),
    top: v.top + m,
    bottom: Math.max(v.top + m + 1, v.bottom - m),
  };
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const p = new Vector3();
  const place = (tx: number, tz: number, d: number) => {
    cam.position.set(tx, d * Math.sin(pitch), tz + d * Math.cos(pitch));
    cam.lookAt(tx, 0, tz);
    cam.updateMatrixWorld();
  };
  /** The map's box on screen for the camera looking at (tx, tz) from distance d. */
  const box = (tx: number, tz: number, d: number) => {
    place(tx, tz, d);
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const c of corners) {
      p.copy(c).project(cam);
      const sx = ((p.x + 1) / 2) * W;
      const sy = ((1 - p.y) / 2) * H;
      x0 = Math.min(x0, sx);
      x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy);
      y1 = Math.max(y1, sy);
    }
    return { x0, x1, y0, y1 };
  };
  /** Where to look from distance d so the map's box is centred in the visible rect (Newton on the target). */
  const centred = (d: number) => {
    let tx = (b.minX + b.maxX) / 2;
    let tz = (b.minY + b.maxY) / 2;
    for (let i = 0; i < 6; i++) {
      const at = box(tx, tz, d);
      const ex = cx - (at.x0 + at.x1) / 2;
      const ey = cy - (at.y0 + at.y1) / 2;
      if (Math.abs(ex) < 0.25 && Math.abs(ey) < 0.25) break;
      // Screen motion per foot of target motion (numerically): moving the target east moves the map west, etc.
      const h = Math.max(0.5, d * 0.01);
      const sx = box(tx + h, tz, d);
      const sz = box(tx, tz + h, d);
      const dxdx = ((sx.x0 + sx.x1) / 2 - (at.x0 + at.x1) / 2) / h;
      const dydz = ((sz.y0 + sz.y1) / 2 - (at.y0 + at.y1) / 2) / h;
      if (Math.abs(dxdx) > 1e-9) tx += ex / dxdx;
      if (Math.abs(dydz) > 1e-9) tz += ey / dydz;
    }
    return { tx, tz, box: box(tx, tz, d) };
  };
  const fits = (d: number) => {
    const c = centred(d);
    return c.box.x1 - c.box.x0 <= rect.right - rect.left && c.box.y1 - c.box.y0 <= rect.bottom - rect.top;
  };
  let lo = opts.minDistance ?? 20;
  let hi = opts.maxDistance ?? 260;
  if (!fits(hi)) lo = hi;
  else
    for (let i = 0; i < 40 && hi - lo > 0.05; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
  const d = fits(lo) ? lo : hi;
  const c = centred(d);
  return {
    position: [c.tx, d * Math.sin(pitch), c.tz + d * Math.cos(pitch)],
    target: [c.tx, 0, c.tz],
    distance: d,
  };
}
