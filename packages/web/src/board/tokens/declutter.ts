import { Box3, type Camera, type Mesh, type Object3D, Vector3 } from "three";

/**
 * Overlay decluttering (SPEC §8.5 Overlay: "readable at any zoom"): name plates and HP bars of nearby tokens must
 * never sit on top of each other, and never simply vanish when there's room nearby. Each frame the board draws, every
 * overlay's screen rectangle (from its rendered bounds) is placed in priority order — hovered, selected, the viewer's
 * own, party, then everyone else, nearer the camera first — in its own spot above its token if that's free, else slid
 * back onto the free board (sideways off the screen's edge; down from under the top of the screen or the HUD — a
 * visible token keeps its plate), else nudged sideways off whatever takes its spot's side, else under its token's
 * base (plates at the feet don't collide with the tokens standing behind), else in the first free one of: beside it to
 * the right or left, stacked above, above and to a side (the token draws a leader to it). All of it kept clear of
 * other tokens' bodies — a plate sitting on a token reads as that token's — wherever that costs no plate its place.
 * Only when every spot is taken does it fade out; zooming in (or hovering) brings it back.
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
/** "Its own spot, brought down onto the free board" (the top of the screen or the HUD above took it). */
const CLAMPED = SLOTS.length + 1;
/** "Under its token's base". */
const BELOW = SLOTS.length + 2;
const TRY_ORDER = [0, SLID, ...SLOTS.keys()].filter((k, i, all) => all.indexOf(k) === i);
/** The gap between a token's base and a plate under it (px). */
const BELOW_GAP_PX = 6;
/** Slot numbers from here on are nudges (a few pixels sideways off whatever takes its spot's side). */
const NUDGE = 100;
/** …and from here, nudges of the spot under its base. */
const BELOW_NUDGE = 200;
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
    // Its own spot: where it was drawn, less the offset it was drawn with.
    const o = e.offset;
    const r = { x0: x0 - o.dx, y0: y0 - o.dy, x1: x1 - o.dx, y1: y1 - o.dy };
    items.push({ id, e, r, p: e.priority(), d: -r.y1 });
  }
  // Nearer the camera first: lower on the screen, from the own spot (never where a plate was moved to — a plate moved
  // up or down would change its turn and the layout would never settle); the id breaks ties.
  items.sort((a, b) => b.p - a.p || a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
      // …nor does one none of which shows on the free board (off the screen, or all of what's on it under one piece).
      const v = {
        x0: Math.max(0, b.x0),
        y0: Math.max(0, b.y0),
        x1: Math.min(width, b.x1),
        y1: Math.min(height, b.y1),
      };
      const unseen =
        v.x0 >= v.x1 ||
        v.y0 >= v.y1 ||
        covered.some((c) => v.x0 >= c.x0 && v.x1 <= c.x1 && v.y0 >= c.y0 && v.y1 <= c.y1);
      if (unseen || covered.some((c) => cx > c.x0 && cx < c.x1 && cy > c.y0 && cy < c.y1)) {
        out.push({ slot: -1, q: r, dx: 0, dy: 0 });
        continue;
      }
    }
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0 + PAD_PX;
    // Sliding onto the screen: only sideways, and only as far as its own width (its token is at least partly on it).
    const slide = r.x0 < EDGE_PX ? EDGE_PX - r.x0 : r.x1 > width - EDGE_PX ? width - EDGE_PX - r.x1 : 0;
    // Nudges: when only the side of its own spot is taken (a HUD piece, a plate, by a few pixels), just far enough
    // sideways to clear it — at most as far as the spots beside it — nearest first.
    const nudges: number[] = [];
    const blockers = [
      ...covered,
      ...placed.map((p) => ({ x0: p.x0 - PAD_PX, y0: p.y0 - PAD_PX, x1: p.x1 + PAD_PX, y1: p.y1 + PAD_PX })),
    ];
    for (const b of blockers) {
      if (!(r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0)) continue;
      for (const dx of [b.x0 - r.x1 - 0.5, b.x1 - r.x0 + 0.5]) if (Math.abs(dx) <= 0.62 * w) nudges.push(dx);
    }
    nudges.sort((a, b) => Math.abs(a) - Math.abs(b));
    // Brought down onto the free board: past the top of the screen and any HUD piece over its column, no further
    // than its token's body reaches (it stays on or at its token) — sideways onto the screen as well.
    const clampDown = (): [number, number] => {
      if (!b) return [Number.NaN, 0];
      let y = Math.max(r.y0, EDGE_PX);
      for (let pass = 0; pass < 6; pass++) {
        const hit = covered.find(
          (c) => r.x0 + slide < c.x1 && r.x1 + slide > c.x0 && y < c.y1 && y + (r.y1 - r.y0) > c.y0,
        );
        if (!hit) break;
        y = hit.y1 + PAD_PX;
      }
      const dy = y - r.y0;
      // Only a plate that belonged just above its token (no further off than its token is tall), onto a token at
      // least partly on the screen (a slide no wider than itself).
      const near = dy <= b.y1 - b.y0 + (r.y1 - r.y0) + 2 * BELOW_GAP_PX && Math.abs(slide) <= w;
      return dy > 0.5 && y < b.y1 && near ? [slide, dy] : [Number.NaN, 0];
    };
    const down = clampDown();
    // Under its base — slid onto the screen as well, for a token at its edge — and, when a HUD piece or a plate
    // takes the side of that spot, nudged sideways off it (as its own spot is).
    const belowDy = b && Math.abs(slide) <= w ? b.y1 + BELOW_GAP_PX - r.y0 : Number.NaN;
    const belowNudges: number[] = [];
    if (!Number.isNaN(belowDy)) {
      const q = { x0: r.x0 + slide, y0: r.y0 + belowDy, x1: r.x1 + slide, y1: r.y1 + belowDy };
      for (const o of blockers) {
        if (!(q.x0 < o.x1 && q.x1 > o.x0 && q.y0 < o.y1 && q.y1 > o.y0)) continue;
        for (const dx of [o.x0 - q.x1 - 0.5, o.x1 - q.x0 + 0.5])
          if (Math.abs(dx) <= 0.62 * w) belowNudges.push(dx);
      }
      belowNudges.sort((x, y) => Math.abs(x) - Math.abs(y));
    }
    const shift = (k: number): [number, number] => {
      if (k === SLID) return [Math.abs(slide) <= w ? slide : Number.NaN, 0];
      if (k === CLAMPED) return down;
      if (k === BELOW) return [Number.isNaN(belowDy) ? Number.NaN : slide, belowDy];
      if (k >= BELOW_NUDGE) return [slide + (belowNudges[k - BELOW_NUDGE] ?? Number.NaN), belowDy];
      if (k >= NUDGE) return [nudges[k - NUDGE] ?? Number.NaN, 0];
      const [sx, sy] = SLOTS[k] as [number, number];
      return [sx * w, sy * h];
    };
    const at = (k: number): Placed => {
      const [dx, dy] = shift(k);
      return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
    };
    // Whether a spot would sit on another token: over more than `limit` of it, or with its centre on it (a plate on a
    // token reads as that token's, however large the token).
    const covers = (q: Placed, limit: number) =>
      bodies.some((o) => {
        if (o.id === it.id) return false;
        const ix = Math.min(q.x1, o.r.x1) - Math.max(q.x0, o.r.x0);
        const iy = Math.min(q.y1, o.r.y1) - Math.max(q.y0, o.r.y0);
        if (ix <= 0 || iy <= 0) return false;
        const cx = (q.x0 + q.x1) / 2;
        const cy = (q.y0 + q.y1) / 2;
        if (cx > o.r.x0 && cx < o.r.x1 && cy > o.r.y0 && cy < o.r.y1) return true;
        const area = Math.max(1, (o.r.x1 - o.r.x0) * (o.r.y1 - o.r.y0));
        return (ix * iy) / area > limit;
      });
    const ok = (k: number) =>
      (k !== SLID || (slide !== 0 && Math.abs(slide) <= w)) &&
      !Number.isNaN(shift(k)[0]) &&
      free(at(k)) &&
      (!clearOfTokens || !covers(at(k), k === 0 || k === SLID || k === CLAMPED ? BURIED : ASIDE));
    // Its own spot, a small shift, under its base; brought down onto its own token only when under the base isn't
    // free (brought down under a HUD piece, a plate lies over its own token's face — critic P7 r1).
    const order = [
      0,
      SLID,
      ...nudges.map((_, i) => NUDGE + i),
      BELOW,
      ...belowNudges.map((_, i) => BELOW_NUDGE + i),
      CLAMPED,
      ...TRY_ORDER.slice(2),
    ];
    let slot = -1;
    // The spot it had, if still free (no hopping) — a nudge or a clamp is worked out afresh each time.
    if (it.e.slot > 0 && it.e.slot < NUDGE && it.e.slot !== CLAMPED && ok(it.e.slot) && !ok(0))
      slot = it.e.slot;
    else for (const k of order) if (slot < 0 && ok(k)) slot = k;
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
/** Whether a screen point (px, y down) is under the HUD over the board (a leader ending there is hidden). */
export const underCover = (x: number, y: number): boolean =>
  lastCovered.some((c) => x > c.x0 && x < c.x1 && y > c.y0 && y < c.y1);

/** The screen rectangles (canvas pixels) of the overlays showing now — for HUD labels that must not cover them. */
export function shownOverlayRects(): Placed[] {
  const out: Placed[] = [];
  for (const e of entries.values()) if (e.clear === 1 && e.rect && e.group.parent) out.push(e.rect);
  return out;
}

/** Where a token's plate is on screen now (canvas px), when it shows one — what floating numbers rise above. */
export function plateRectOf(id: string): Placed | null {
  const e = entries.get(id);
  return e && e.clear === 1 && e.rect && e.group.parent ? e.rect : null;
}

/** Where a token's body is on screen now (canvas px), when known. */
export const bodyRectOf = (id: string): Placed | null => entries.get(id)?.body ?? null;

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
