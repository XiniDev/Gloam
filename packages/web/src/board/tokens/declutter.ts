import { Box3, type Camera, type Mesh, type Object3D, Vector3 } from "three";

/**
 * Overlay decluttering (SPEC §8.5 Overlay: "readable at any zoom"): name plates and HP bars of nearby tokens must
 * never sit on top of each other, and never simply vanish when there's room nearby. Each frame the board draws, every
 * overlay's screen rectangle (from its rendered bounds) is placed in priority order — hovered, selected, the viewer's
 * own, party, then everyone else, nearer the camera first — in its own spot above its token if that's free, else slid
 * sideways back onto the screen (a token at the edge keeps its plate readable, not cut off), else in the first free
 * one of: beside it to the right or left, stacked above, above and to a side (the token draws a hairline leader to
 * it) — kept clear of other tokens' bodies (a plate sitting on a token reads as that token's) wherever that costs no
 * plate its place. Only when every spot is taken does it fade out; zooming in (or hovering) brings it back.
 */
interface Entry {
  group: Object3D;
  priority: () => number;
  /** Target visibility from the last layout: 1 shown, 0 hidden by clutter. */
  clear: number;
  /** Where the overlay goes from its own spot (screen px, y down): the token applies it, the next layout reads it. */
  offset: { dx: number; dy: number };
  /** The candidate spot chosen last time (kept while it stays free, so plates don't hop). */
  slot: number;
  /** Screen rectangle from the last layout (diagnostics). */
  rect?: { x0: number; y0: number; x1: number; y1: number };
  /** How many times its verdict changed (diagnostics: a stable layout stops changing). */
  flips: number;
  /** Its token's body on screen (px, y down), when known: other plates moved aside avoid it. */
  body?: Placed;
}

const entries = new Map<string, Entry>();
const box = new Box3();
const corner = new Vector3();
const PAD_PX = 3;

export function registerOverlay(id: string, group: Object3D, priority: () => number): () => void {
  entries.set(id, { group, priority, clear: 1, offset: { dx: 0, dy: 0 }, slot: 0, flips: 0 });
  return () => {
    if (entries.get(id)?.group === group) entries.delete(id);
  };
}

/** Where the overlay's token is on screen this frame (px, y down), or null when it isn't. */
export function setOverlayBody(id: string, body: Placed | null): void {
  const e = entries.get(id);
  if (!e) return;
  if (body) e.body = body;
  else delete e.body;
}

/** The overlay's target visibility (1 shown, 0 hidden by clutter). */
export const overlayClear = (id: string): number => entries.get(id)?.clear ?? 1;

const NO_OFFSET = { dx: 0, dy: 0 };
/** Where the overlay goes from its own spot (screen px, y down). */
export const overlayOffset = (id: string): { dx: number; dy: number } => entries.get(id)?.offset ?? NO_OFFSET;

/** Candidate spots as multiples of the plate's width and height (from its own spot, y down). */
const SLOTS: [number, number][] = [
  [0, 0],
  [0.62, 0],
  [-0.62, 0],
  [0, -1],
  [0.62, -1],
  [-0.62, -1],
  [0, -2],
];
/** The slot number of "its own spot, slid onto the screen" (tried right after its own spot). */
const SLID = SLOTS.length;
const TRY_ORDER = [0, SLID, ...SLOTS.keys()].filter((k, i, all) => all.indexOf(k) === i);
/** A plate in its own spot gives way when it would cover more than this share of another token… */
const BURIED = 0.5;
/** …and a spot aside is taken only when it covers no more than this share of one. */
const ASIDE = 0.25;
/** How close to the screen's edge a slid plate comes (px). */
const EDGE_PX = 4;

interface Placed {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * An overlay's own extent: its meshes, less anything marked `userData.overlayDecor` (the leader line and its dot —
 * drawn to the token, not part of the plate that needs room; a hidden one kept its last shape).
 */
function plateBox(g: Object3D, out: Box3): Box3 {
  out.makeEmpty();
  g.traverse((o) => {
    if (!(o as Mesh).isMesh && !(o as { isSprite?: boolean }).isSprite) return;
    for (let p: Object3D | null = o; p && p !== g; p = p.parent) if (p.userData.overlayDecor) return;
    const geo = (o as Mesh).geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingBox) return;
    part.copy(geo.boundingBox).applyMatrix4(o.matrixWorld);
    out.union(part);
  });
  return out;
}
const part = new Box3();

/**
 * Recomputes which overlays show. `covered` is the HUD drawn over the board (screen px): no plate goes under it, and
 * a token under it keeps its plate hidden too. Returns true when any target changed (the fades need frames).
 */
export function layoutOverlays(
  camera: Camera,
  width: number,
  height: number,
  covered: readonly Placed[] = [],
): boolean {
  lastCovered = covered;
  const items: { id: string; e: Entry; r: Placed; p: number; d: number }[] = [];
  const bodies: { id: string; r: Placed }[] = [];
  for (const [id, e] of entries) {
    if (e.group.parent && e.body) bodies.push({ id, r: e.body });
    if (!e.group.parent) continue;
    e.group.updateWorldMatrix(true, true);
    plateBox(e.group, box);
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
    // Its own spot: where it was drawn, less the offset it was drawn with.
    const o = e.offset;
    const r = { x0: x0 - o.dx, y0: y0 - o.dy, x1: x1 - o.dx, y1: y1 - o.dy };
    items.push({ id, e, r, p: e.priority(), d: corner.distanceToSquared(camera.position) });
  }
  items.sort((a, b) => b.p - a.p || a.d - b.d);
  // Kept clear of the tokens where that costs no plate; where it would hide one, plates over tokens it is.
  let layout = place(items, bodies, covered, width, height, true);
  const hidden = (l: Layout) => l.reduce((n, x) => n + (x.slot < 0 ? 1 : 0), 0);
  if (hidden(layout) > 0) {
    const loose = place(items, bodies, covered, width, height, false);
    if (hidden(loose) < hidden(layout)) layout = loose;
  }
  let changed = false;
  for (const [n, it] of items.entries()) {
    const { slot, q, dx, dy } = layout[n] as Layout[number];
    const clear = slot >= 0 ? 1 : 0;
    it.e.rect = q;
    if (slot >= 0 && (Math.abs(dx - it.e.offset.dx) > 0.5 || Math.abs(dy - it.e.offset.dy) > 0.5)) {
      it.e.offset = { dx, dy };
      changed = true;
    }
    if (slot >= 0) it.e.slot = slot;
    if (it.e.clear !== clear) {
      it.e.clear = clear;
      it.e.flips++;
      changed = true;
    }
  }
  return changed;
}

type Layout = { slot: number; q: Placed; dx: number; dy: number }[];

/**
 * One layout pass, in priority order: each plate in the spot it had (no hopping), else its own, else the first free
 * candidate. Keeping clear of tokens (`clearOfTokens`), its own spot mustn't bury another token (cover more than half
 * of it — clipping a neighbour's rim is fine) and a spot aside mustn't cover more than a quarter of one.
 */
function place(
  items: { id: string; e: Entry; r: Placed }[],
  bodies: { id: string; r: Placed }[],
  covered: readonly Placed[],
  width: number,
  height: number,
  clearOfTokens: boolean,
): Layout {
  const placed: Placed[] = [];
  const out: Layout = [];
  const free = (q: Placed) =>
    q.x0 >= 0 &&
    q.y0 >= 0 &&
    q.x1 <= width &&
    q.y1 <= height &&
    !covered.some((c) => q.x0 < c.x1 && q.x1 > c.x0 && q.y0 < c.y1 && q.y1 > c.y0) &&
    !placed.some(
      (p) => q.x0 < p.x1 + PAD_PX && q.x1 > p.x0 - PAD_PX && q.y0 < p.y1 + PAD_PX && q.y1 > p.y0 - PAD_PX,
    );
  for (const it of items) {
    const { r } = it;
    // A token under the HUD (the dock, the feed) shows no plate: it would point at nothing to be seen.
    const b = it.e.body;
    if (b) {
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      if (covered.some((c) => cx > c.x0 && cx < c.x1 && cy > c.y0 && cy < c.y1)) {
        out.push({ slot: -1, q: r, dx: 0, dy: 0 });
        continue;
      }
    }
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0 + PAD_PX;
    // Sliding onto the screen: only sideways, and only as far as its own width (its token is at least partly on it).
    const slide = r.x0 < EDGE_PX ? EDGE_PX - r.x0 : r.x1 > width - EDGE_PX ? width - EDGE_PX - r.x1 : 0;
    const shift = (k: number): [number, number] => {
      if (k === SLID) return [Math.abs(slide) <= w ? slide : Number.NaN, 0];
      const [sx, sy] = SLOTS[k] as [number, number];
      return [sx * w, sy * h];
    };
    const at = (k: number): Placed => {
      const [dx, dy] = shift(k);
      return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
    };
    const covers = (q: Placed, limit: number) =>
      bodies.some((b) => {
        if (b.id === it.id) return false;
        const ix = Math.min(q.x1, b.r.x1) - Math.max(q.x0, b.r.x0);
        const iy = Math.min(q.y1, b.r.y1) - Math.max(q.y0, b.r.y0);
        if (ix <= 0 || iy <= 0) return false;
        const area = Math.max(1, (b.r.x1 - b.r.x0) * (b.r.y1 - b.r.y0));
        return (ix * iy) / area > limit;
      });
    const ok = (k: number) =>
      (k !== SLID || (slide !== 0 && Math.abs(slide) <= w)) &&
      free(at(k)) &&
      (!clearOfTokens || !covers(at(k), k === 0 || k === SLID ? BURIED : ASIDE));
    let slot = -1;
    if (it.e.slot > 0 && ok(it.e.slot) && !ok(0)) slot = it.e.slot;
    else for (const k of TRY_ORDER) if (slot < 0 && ok(k)) slot = k;
    const q = slot >= 0 ? at(slot) : r;
    if (slot >= 0) placed.push(q);
    const [dx, dy] = slot >= 0 ? shift(slot) : [0, 0];
    out.push({ slot, q, dx, dy });
  }
  return out;
}

let lastCovered: readonly Placed[] = [];
/** The HUD over the board at the last layout (diagnostics: where plates may not go). */
export const plateCovers = (): readonly Placed[] => lastCovered;

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
  return [...entries].map(([id, e]) => ({
    id,
    clear: e.clear,
    rect: e.rect,
    flips: e.flips,
    offset: e.offset,
  }));
}
