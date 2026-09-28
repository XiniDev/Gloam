import { Box3, type Camera, type Object3D, Vector3 } from "three";

/**
 * Overlay decluttering (SPEC §8.5 Overlay: "readable at any zoom"): name plates and HP bars of nearby tokens must
 * never sit on top of each other. Each frame the board draws, every overlay's screen rectangle (from its rendered
 * bounds) is placed in priority order — hovered, selected, the viewer's own, party, then everyone else, nearer the
 * camera first — and an overlay that would overlap one already placed fades out. Zooming in (or hovering) brings
 * them back.
 */
interface Entry {
  group: Object3D;
  priority: () => number;
  /** Target visibility from the last layout: 1 shown, 0 hidden by clutter. */
  clear: number;
  /** Screen rectangle from the last layout (diagnostics). */
  rect?: { x0: number; y0: number; x1: number; y1: number };
  /** How many times its verdict changed (diagnostics: a stable layout stops changing). */
  flips: number;
}

const entries = new Map<string, Entry>();
const box = new Box3();
const corner = new Vector3();
const PAD_PX = 3;

export function registerOverlay(id: string, group: Object3D, priority: () => number): () => void {
  entries.set(id, { group, priority, clear: 1, flips: 0 });
  return () => {
    if (entries.get(id)?.group === group) entries.delete(id);
  };
}

/** The overlay's target visibility (1 shown, 0 hidden by clutter). */
export const overlayClear = (id: string): number => entries.get(id)?.clear ?? 1;

interface Placed {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Recomputes which overlays show. Returns true when any target changed (the fades need frames). */
export function layoutOverlays(camera: Camera, width: number, height: number): boolean {
  const items: { e: Entry; r: Placed; p: number; d: number }[] = [];
  for (const e of entries.values()) {
    if (!e.group.parent) continue;
    e.group.updateWorldMatrix(true, true);
    box.setFromObject(e.group);
    if (box.isEmpty()) continue;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    let behind = false;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      corner.project(camera);
      if (corner.z > 1) behind = true;
      const sx = ((corner.x + 1) / 2) * width;
      const sy = ((1 - corner.y) / 2) * height;
      x0 = Math.min(x0, sx);
      y0 = Math.min(y0, sy);
      x1 = Math.max(x1, sx);
      y1 = Math.max(y1, sy);
    }
    if (behind) continue;
    box.getCenter(corner);
    items.push({ e, r: { x0, y0, x1, y1 }, p: e.priority(), d: corner.distanceToSquared(camera.position) });
  }
  items.sort((a, b) => b.p - a.p || a.d - b.d);
  const placed: Placed[] = [];
  let changed = false;
  for (const it of items) {
    const { r } = it;
    const hit = placed.some(
      (q) => r.x0 < q.x1 + PAD_PX && r.x1 > q.x0 - PAD_PX && r.y0 < q.y1 + PAD_PX && r.y1 > q.y0 - PAD_PX,
    );
    const clear = hit ? 0 : 1;
    if (!hit) placed.push(r);
    it.e.rect = r;
    if (it.e.clear !== clear) {
      it.e.clear = clear;
      it.e.flips++;
      changed = true;
    }
  }
  return changed;
}

/** The screen rectangles (canvas pixels) of the overlays showing now — for HUD labels that must not cover them. */
export function shownOverlayRects(): Placed[] {
  const out: Placed[] = [];
  for (const e of entries.values()) if (e.clear === 1 && e.rect && e.group.parent) out.push(e.rect);
  return out;
}

/** Overlay priorities (higher wins a spot on screen). */
export const PRIORITY = { hovered: 5, selected: 4, own: 3, party: 2, other: 1 } as const;

/** Diagnostics for the test hooks: every overlay's verdict, rectangle and flip count. */
export function overlayDiagnostics() {
  return [...entries].map(([id, e]) => ({ id, clear: e.clear, rect: e.rect, flips: e.flips }));
}
