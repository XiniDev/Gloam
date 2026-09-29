import { Box3, type Camera, type Mesh, type Object3D, Vector3 } from "three";

/**
 * Overlay decluttering (SPEC §8.5 Overlay: "readable at any zoom"): name plates and HP bars of nearby tokens must
 * never sit on top of each other or on other creatures, and never simply vanish when there's room nearby. Each frame
 * the board draws, every overlay's screen rectangle (from its rendered bounds) is placed in priority order — hovered,
 * selected, the viewer's own, party, then everyone else, nearer the camera first — in the first free one of: its own
 * spot above its token; that spot slid sideways onto the screen or nudged off whatever takes its side; under its
 * token's base; beside it at mid-height, right then left; brought down onto the free board (its own spot off the top
 * or under the HUD); up to its width aside; stacked above. A plate away from its own spot draws a leader to the part
 * of its token that can be seen.
 *
 * "Free" comes in four strengths (critic P7 r2 #1):
 *  0. clear of every other token's footprint (base and standing card; a few px into its box's corner allowed), its
 *     leader crossing no other token, plate or leader, and — moved — nearer its own token than any other (a plate
 *     over another creature, or right above it, reads as that creature's);
 *  1. over no more than a neighbour's rim (in its own spot: under half of it, never with its centre on it; aside:
 *     under a quarter), its leader crossing no plate or leader;
 *  2. its leader and the others' whole (crossing no plate or leader), wherever the creatures are;
 *  3. anywhere clear of other plates and the HUD — a plate over a creature beats no plate at all.
 * Each plate tries the full plate strictly, then compact — its bar alone, above its token or low on its own face —
 * strictly and at tier 1, then the full plate at tiers 1, 2 and 3 (see STEPS). Only when every spot is taken does it
 * fade out; zooming in (or hovering) brings it back. A token none of whose body shows on the free board (under a
 * third of it, and too little to point at) shows no plate.
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
  /** How strictly that spot keeps clear of other tokens (0 strictest; see above). */
  tier: number;
  /** Shown compact: its bar alone, in its own spot (the last resort before a full plate on another creature). */
  compact: boolean;
  /**
   * Its own spot on screen (px), full and compact, as its token lays the plate out this frame — the layout reads
   * these rather than what's drawn (drawn compact, the full plate's spot is still known). Without them (tests), the
   * drawn plate less its offset.
   */
  spots?: { full: Placed; compact: Placed | null };
  /** Screen rectangle from the last layout (diagnostics). */
  rect?: Placed;
  /** Its leader from the last layout (screen px), when it draws one (diagnostics). */
  leader?: Segment;
  /** How many times its verdict changed (diagnostics: a stable layout stops changing). */
  flips: number;
  /** Its token's body on screen (px, y down), when known: other plates keep off it. */
  body?: Placed;
  /** …as its parts: round rims (ellipses — the corners of their box are air) and boxes (a card, a mini). */
  parts?: readonly BodyPart[];
  /**
   * Where on its body a leader may end — the part on the free board, less the tokens in front of it — as fractions of
   * the body's box (so the token can redraw it as the view moves between layouts).
   */
  end: Placed;
}

const entries = new Map<string, Entry>();
const box = new Box3();
const corner = new Vector3();
const PAD_PX = 3;
const WHOLE: Placed = { x0: 0, y0: 0, x1: 1, y1: 1 };

export function registerOverlay(id: string, group: Object3D, priority: () => number): () => void {
  entries.set(id, {
    group,
    priority,
    clear: 1,
    offset: { dx: 0, dy: 0 },
    slot: 0,
    tier: 0,
    compact: false,
    flips: 0,
    end: WHOLE,
  });
  return () => {
    if (entries.get(id)?.group === group) entries.delete(id);
  };
}

/** Where the overlay's token is on screen this frame (px, y down), or null when it isn't. */
export function setOverlayBody(id: string, body: Placed | null, parts?: readonly BodyPart[]): void {
  const e = entries.get(id);
  if (!e) return;
  if (body) {
    e.body = body;
    e.parts = parts?.length ? parts : [{ kind: "box", ...body }];
  } else {
    delete e.body;
    delete e.parts;
  }
}

/**
 * Where the overlay's plate would stand in its own spot this frame (screen px, y down): full, and compact (its bar
 * alone, the same bottom edge) when it has a compact form.
 */
export function setOverlaySpots(id: string, full: Placed | null, compact: Placed | null): void {
  const e = entries.get(id);
  if (!e) return;
  if (full) e.spots = { full, compact };
  else delete e.spots;
}

/** The overlay's target visibility (1 shown, 0 hidden by clutter). */
export const overlayClear = (id: string): number => entries.get(id)?.clear ?? 1;

/**
 * Plates a planned move's path runs under (critic P8 r1 #15): they fade back while the drag lasts, so the line and its
 * marks read through them (moving them away mid-drag would be worse — the board jumping under the pointer).
 */
let crossed: ReadonlySet<string> = new Set();
export function setPathCrossed(ids: ReadonlySet<string>): void {
  crossed = ids;
}
export const overlayCrossed = (id: string): boolean => crossed.has(id);

/** Tests: every plate off (a measurement of the tokens' own geometry, whatever the plates' layout would show). */
let off = false;
export function setOverlaysOff(on: boolean): void {
  off = on;
}
export const overlaysOff = (): boolean => off;

/** Whether the overlay shows compact (its bar alone). */
export const overlayCompact = (id: string): boolean => entries.get(id)?.compact ?? false;

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
/** "Beside its token at mid-height", right and left. */
const SIDE_R = SLOTS.length + 3;
const SIDE_L = SLOTS.length + 4;
/** "On its own token, low on the part of it that shows" — for the compact bar only: over its own art, never another's. */
const ON = SLOTS.length + 5;
/** The gap between a token's base and a plate under it (px). */
const BELOW_GAP_PX = 6;
/** The gap between a token's side and a plate beside it (px). */
const SIDE_GAP_PX = 8;
/** Slot numbers from here on are nudges (a few pixels sideways off whatever takes its spot's side). */
const NUDGE = 100;
/** …and from here, nudges of the spot under its base. */
const BELOW_NUDGE = 200;
/** In tier 1, a plate in its own spot gives way when it would cover more than this share of another token… */
const BURIED = 0.5;
/** …and a spot aside is taken only when it covers no more than this share of one. */
const ASIDE = 0.25;
/** How far into another token's box a plate may reach and still be clear of it (its box's corner is air) (px). */
const RIM_PX = 4;
/** How close to the screen's edge a slid plate comes (px). */
const EDGE_PX = 4;
/** A token shows a plate while this share of its body is on the free board, or at least SEEN_PX of it each way. */
const SEEN_SHARE = 1 / 3;
const SEEN_PX = 40;
/** Shorter than this, a leader isn't drawn (px) — the token's own. */
const LEADER_MIN_PX = 4;

export interface Placed {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A part of a token's body on screen: a round rim seen at a slant (the ellipse its box holds), or a box. */
export interface BodyPart extends Placed {
  kind: "ellipse" | "box";
}

/** A token's body for the layout: its box, and its parts for the strict measures. */
interface Body {
  id: string;
  r: Placed;
  parts: readonly BodyPart[];
}

/** A leader on screen (px, y down): from the plate's edge (s) to a dot on its token (e). */
export interface Segment {
  sx: number;
  sy: number;
  ex: number;
  ey: number;
}

const area = (r: Placed) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const meets = (a: Placed, b: Placed) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
/** How deep two boxes overlap: the smaller side of their intersection (0 when apart). */
const depth = (a: Placed, b: Placed) =>
  Math.max(
    0,
    Math.min(Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)),
  );
/** The distance between two boxes (0 when they touch or overlap). */
const gap = (a: Placed, b: Placed) =>
  Math.hypot(Math.max(0, b.x0 - a.x1, a.x0 - b.x1), Math.max(0, b.y0 - a.y1, a.y0 - b.y1));
const shrink = (r: Placed, by: number): Placed => ({
  x0: r.x0 + by,
  y0: r.y0 + by,
  x1: r.x1 - by,
  y1: r.y1 - by,
});

/** How deep a box reaches into an ellipse (its box `e`): how far inside the rim its nearest point to the centre is. */
function ellipseDepth(q: Placed, e: Placed): number {
  const cx = (e.x0 + e.x1) / 2;
  const cy = (e.y0 + e.y1) / 2;
  const rx = Math.max(1e-6, (e.x1 - e.x0) / 2);
  const ry = Math.max(1e-6, (e.y1 - e.y0) / 2);
  const px = Math.min(q.x1, Math.max(q.x0, cx));
  const py = Math.min(q.y1, Math.max(q.y0, cy));
  const d = Math.hypot((px - cx) / rx, (py - cy) / ry);
  return d >= 1 ? 0 : (1 - d) * Math.min(rx, ry);
}

/** Whether a segment passes more than `rim` px inside an ellipse (its box `e`). */
function crossesEllipse(s: Segment, e: Placed, rim: number): boolean {
  const cx = (e.x0 + e.x1) / 2;
  const cy = (e.y0 + e.y1) / 2;
  const rx = (e.x1 - e.x0) / 2 - rim;
  const ry = (e.y1 - e.y0) / 2 - rim;
  if (rx <= 0 || ry <= 0) return false;
  // In the ellipse's unit circle: the segment's nearest point to the centre.
  const ax = (s.sx - cx) / rx;
  const ay = (s.sy - cy) / ry;
  const bx = (s.ex - cx) / rx;
  const by = (s.ey - cy) / ry;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) < 1;
}

/** How deep a box reaches into a token's body, part by part. */
export function bodyDepth(q: Placed, parts: readonly BodyPart[]): number {
  let d = 0;
  for (const p of parts) d = Math.max(d, p.kind === "ellipse" ? ellipseDepth(q, p) : depth(q, p));
  return d;
}

/** Whether a leader runs over a token's body, more than `rim` px into any part. */
export function crossesBody(s: Segment, parts: readonly BodyPart[], rim: number): boolean {
  return parts.some((p) => (p.kind === "ellipse" ? crossesEllipse(s, p, rim) : crosses(s, shrink(p, rim))));
}

/** The largest part of `r` left beside `cut` (of the strips left, right, above and below it), `r` when apart. */
export function without(r: Placed, cut: Placed): Placed {
  if (!meets(r, cut)) return r;
  let best: Placed = { x0: r.x0, y0: r.y0, x1: r.x0, y1: r.y0 };
  for (const p of [
    { x0: r.x0, y0: r.y0, x1: Math.min(r.x1, cut.x0), y1: r.y1 },
    { x0: Math.max(r.x0, cut.x1), y0: r.y0, x1: r.x1, y1: r.y1 },
    { x0: r.x0, y0: r.y0, x1: r.x1, y1: Math.min(r.y1, cut.y0) },
    { x0: r.x0, y0: Math.max(r.y0, cut.y1), x1: r.x1, y1: r.y1 },
  ])
    if (area(p) > area(best)) best = p;
  return best;
}

/** The part of a token's body on the free board: on the screen, less the HUD over it (the largest clear piece). */
export function seenPart(body: Placed, covered: readonly Placed[], width: number, height: number): Placed {
  let v: Placed = {
    x0: Math.max(0, body.x0),
    y0: Math.max(0, body.y0),
    x1: Math.min(width, body.x1),
    y1: Math.min(height, body.y1),
  };
  if (v.x0 >= v.x1 || v.y0 >= v.y1) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  for (const c of covered) v = without(v, c);
  return v;
}

/**
 * A plate's leader: from the point of the plate's edge nearest its end to a dot well inside `end` (the part of its
 * token that shows) — never along the plate's edge like a gauge, never on a rim or the seam with a neighbour.
 */
export function leaderSegment(q: Placed, end: Placed): Segment {
  const w = end.x1 - end.x0;
  const h = end.y1 - end.y0;
  const inset = Math.max(0, Math.min(40, 0.35 * Math.min(w, h)));
  const into = (v: number, lo: number, hi: number) =>
    lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
  const ex = into((q.x0 + q.x1) / 2, end.x0 + inset, end.x1 - inset);
  const ey = into((q.y0 + q.y1) / 2, end.y0 + inset, end.y1 - inset);
  return { sx: Math.min(q.x1, Math.max(q.x0, ex)), sy: Math.min(q.y1, Math.max(q.y0, ey)), ex, ey };
}

/** Where a segment runs through a box's inside, as [enter, leave] along it (0–1), or null (Liang–Barsky). */
function clip(s: Segment, r: Placed): [number, number] | null {
  if (r.x0 >= r.x1 || r.y0 >= r.y1) return null;
  const dx = s.ex - s.sx;
  const dy = s.ey - s.sy;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, s.sx - r.x0],
    [dx, r.x1 - s.sx],
    [-dy, s.sy - r.y0],
    [dy, r.y1 - s.sy],
  ] as const) {
    if (p === 0) {
      if (q <= 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

/** Whether a segment passes through a box's inside. */
export const crosses = (s: Segment, r: Placed): boolean => clip(s, r) !== null;

/** The part of a segment before it enters a box (all of it when it never does). */
function before(s: Segment, r: Placed): Segment {
  const c = clip(s, r);
  if (!c) return s;
  const t = c[0];
  return { sx: s.sx, sy: s.sy, ex: s.sx + (s.ex - s.sx) * t, ey: s.sy + (s.ey - s.sy) * t };
}

/** Whether two segments cross (touching ends don't). */
function segmentsCross(a: Segment, b: Segment): boolean {
  const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  return (
    o(a.sx, a.sy, a.ex, a.ey, b.sx, b.sy) * o(a.sx, a.sy, a.ex, a.ey, b.ex, b.ey) < 0 &&
    o(b.sx, b.sy, b.ex, b.ey, a.sx, a.sy) * o(b.sx, b.sy, b.ex, b.ey, a.ex, a.ey) < 0
  );
}

const segLength = (s: Segment) => Math.hypot(s.ex - s.sx, s.ey - s.sy);

/**
 * Whether a plate still stands just over its token — its foot at most a few px above the token's top, across its
 * middle — as in its own spot nudged a little sideways: it needs no leader to say whose it is.
 */
function overIts(plate: Placed, body: Placed): boolean {
  const cx = (body.x0 + body.x1) / 2;
  return plate.x0 <= cx && plate.x1 >= cx && plate.y1 <= body.y0 + 1 && plate.y1 >= body.y0 - 12;
}

/**
 * The leader of a token's plate drawn at `plate`, its token's body at `body` (screen px, both fresh this frame): to
 * the part of the body the last layout found showing. Null when the plate sits on its token or too close to need one.
 */
export function leaderFor(id: string, plate: Placed, body: Placed): Segment | null {
  if (overIts(plate, body)) return null;
  const f = entries.get(id)?.end ?? WHOLE;
  const w = body.x1 - body.x0;
  const h = body.y1 - body.y0;
  const end = {
    x0: body.x0 + f.x0 * w,
    y0: body.y0 + f.y0 * h,
    x1: body.x0 + f.x1 * w,
    y1: body.y0 + f.y1 * h,
  };
  const s = leaderSegment(plate, end);
  return segLength(s) > LEADER_MIN_PX ? s : null;
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

interface Item {
  id: string;
  e: Entry;
  /** Its own spot (px), and its compact form's. */
  r: Placed;
  rc: Placed | null;
  p: number;
  d: number;
  /** Its token's body, the part of it showing, and where a leader to it may end (px). */
  body?: Placed;
  seen?: Placed;
  end?: Placed;
}

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
  const items: Item[] = [];
  const bodies: Body[] = [];
  for (const [id, e] of entries) {
    if (e.group.parent && e.body)
      bodies.push({ id, r: e.body, parts: e.parts ?? [{ kind: "box", ...e.body }] });
    if (!e.group.parent) continue;
    if (e.spots) {
      items.push({ id, e, r: e.spots.full, rc: e.spots.compact, p: e.priority(), d: -e.spots.full.y1 });
      continue;
    }
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
    items.push({ id, e, r, rc: null, p: e.priority(), d: -r.y1 });
  }
  // What of each token shows, and where its leader may end: the part on the free board, less the tokens standing in
  // front of it (lower on the screen) — unless that leaves too little to point at.
  for (const it of items) {
    const b = it.e.body;
    if (!b) continue;
    it.body = b;
    it.seen = seenPart(b, covered, width, height);
    let end = it.seen;
    for (const o of bodies) if (o.id !== it.id && o.r.y1 > b.y1 + 1) end = without(end, o.r);
    if (end.x1 - end.x0 < 12 || end.y1 - end.y0 < 12) end = it.seen;
    it.end = end;
    const w = Math.max(1e-6, b.x1 - b.x0);
    const h = Math.max(1e-6, b.y1 - b.y0);
    it.e.end = {
      x0: (end.x0 - b.x0) / w,
      y0: (end.y0 - b.y0) / h,
      x1: (end.x1 - b.x0) / w,
      y1: (end.y1 - b.y0) / h,
    };
  }
  // Nearer the camera first: lower on the screen, from the own spot (never where a plate was moved to — a plate moved
  // up or down would change its turn and the layout would never settle); the id breaks ties.
  items.sort((a, b) => b.p - a.p || a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Each plate at the strictest tier it has a spot at; when that leaves more plates hidden than placing them all
  // loosely would, loosely it is.
  let layout = place(items, bodies, covered, width, height, STEPS);
  const hidden = (l: Layout) => l.reduce((n, x) => n + (x.slot < 0 ? 1 : 0), 0);
  if (hidden(layout) > 0) {
    const loose = place(items, bodies, covered, width, height, LOOSE_STEPS);
    if (hidden(loose) < hidden(layout)) layout = loose;
  }
  let changed = false;
  for (const [n, it] of items.entries()) {
    const { slot, tier, compact, q, dx, dy, leader } = layout[n] as Layout[number];
    const clear = slot >= 0 ? 1 : 0;
    it.e.rect = q;
    if (leader) it.e.leader = leader;
    else delete it.e.leader;
    if (slot >= 0 && (Math.abs(dx - it.e.offset.dx) > 0.5 || Math.abs(dy - it.e.offset.dy) > 0.5)) {
      it.e.offset = { dx, dy };
      changed = true;
    }
    if (slot >= 0) {
      it.e.slot = slot;
      it.e.tier = tier;
      if (it.e.compact !== compact) {
        it.e.compact = compact;
        changed = true;
      }
    }
    if (it.e.clear !== clear) {
      it.e.clear = clear;
      it.e.flips++;
      changed = true;
    }
  }
  return changed;
}

type Layout = {
  slot: number;
  tier: number;
  compact: boolean;
  q: Placed;
  dx: number;
  dy: number;
  leader?: Segment;
}[];

/**
 * The order a plate tries its variants and tiers in: the full plate strictly; the compact one (its bar alone, above its
 * token or on its own face) strictly, then over no more than a neighbour's rim; the full plate over no more than a
 * rim, then anywhere its leader and the others' stay whole, then anywhere free (critic P7 r2 #1: "as a last resort, a
 * compact bar-only plate in the token's own spot" — before a full plate on another creature).
 */
const STEPS: readonly (readonly [compact: boolean, tier: number])[] = [
  [false, 0],
  [true, 0],
  [true, 1],
  [false, 1],
  [false, 2],
  [false, 3],
];
const LOOSE_STEPS: readonly (readonly [compact: boolean, tier: number])[] = [[false, 3]];

/**
 * One layout pass, in priority order: each plate in the spot it had (no hopping), else the first free candidate —
 * trying every candidate of a step before any of the next.
 */
function place(
  items: Item[],
  bodies: Body[],
  covered: readonly Placed[],
  width: number,
  height: number,
  steps: readonly (readonly [boolean, number])[],
): Layout {
  const placed: Placed[] = [];
  const leaders: Segment[] = [];
  const out: Layout = [];
  const free = (q: Placed) =>
    q.x0 >= 0 &&
    q.y0 >= 0 &&
    q.x1 <= width &&
    q.y1 <= height &&
    !covered.some((c) => meets(q, c)) &&
    !placed.some(
      (p) => q.x0 < p.x1 + PAD_PX && q.x1 > p.x0 - PAD_PX && q.y0 < p.y1 + PAD_PX && q.y1 > p.y0 - PAD_PX,
    );
  for (const it of items) {
    const b = it.body;
    const seen = it.seen;
    // A token none of which shows on the free board — off the screen, under the HUD (the dock, the feed), all but a
    // sliver — shows no plate: it would point at nothing to be seen. One mostly showing keeps it (critic P7 r2 #6).
    if (b && seen) {
      const sw = seen.x1 - seen.x0;
      const sh = seen.y1 - seen.y0;
      const share = area(seen) / Math.max(1, area(b));
      if (sw <= 0 || sh <= 0 || (share < SEEN_SHARE && (sw < SEEN_PX || sh < SEEN_PX))) {
        out.push({ slot: -1, tier: 0, compact: false, q: it.r, dx: 0, dy: 0 });
        continue;
      }
    }
    // Tier 1's measure of sitting on another token: over more than `limit` of it, or with its centre on it.
    const covers = (q: Placed, limit: number) =>
      bodies.some((o) => {
        if (o.id === it.id || !meets(q, o.r)) return false;
        const cx = (q.x0 + q.x1) / 2;
        const cy = (q.y0 + q.y1) / 2;
        if (cx > o.r.x0 && cx < o.r.x1 && cy > o.r.y0 && cy < o.r.y1) return true;
        const ix = Math.min(q.x1, o.r.x1) - Math.max(q.x0, o.r.x0);
        const iy = Math.min(q.y1, o.r.y1) - Math.max(q.y0, o.r.y0);
        return (ix * iy) / Math.max(1, area(o.r)) > limit;
      });
    const full = plan(it.r, false);
    const small = it.rc ? plan(it.rc, true) : null;
    let chosen: { slot: number; tier: number; compact: boolean; s: Spot } | null = null;
    for (const [compact, tier] of steps) {
      const p = compact ? small : full;
      if (!p) continue;
      // The spot it had, if still free at this step and its own isn't (no hopping) — a nudge or a clamp is worked
      // out afresh each time.
      const had = it.e.compact === compact ? it.e.slot : -1;
      const keep = had > 0 && had < NUDGE && had !== CLAMPED && p.order.includes(had) ? had : -1;
      let slot = -1;
      if (keep >= 0 && p.ok(keep, tier) && !p.ok(0, tier)) slot = keep;
      else for (const k of p.order) if (slot < 0 && p.ok(k, tier)) slot = k;
      const s = slot >= 0 ? p.spot(slot) : null;
      if (s) {
        chosen = { slot, tier, compact, s };
        break;
      }
    }
    if (chosen) {
      const { s } = chosen;
      placed.push(s.q);
      if (s.leader) leaders.push(s.leader);
      out.push({
        slot: chosen.slot,
        tier: chosen.tier,
        compact: chosen.compact,
        q: s.q,
        dx: s.dx,
        dy: s.dy,
        leader: s.leader,
      });
    } else out.push({ slot: -1, tier: 3, compact: false, q: it.r, dx: 0, dy: 0 });

    /** The candidate spots for a plate whose own spot is `r` (a compact one only tries its own spot). */
    function plan(r: Placed, compact: boolean) {
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0 + PAD_PX;
      // Sliding onto the screen: only sideways, and only as far as its own width (its token is at least partly on
      // it).
      const slide = r.x0 < EDGE_PX ? EDGE_PX - r.x0 : r.x1 > width - EDGE_PX ? width - EDGE_PX - r.x1 : 0;
      // Nudges: when only the side of its own spot is taken (a HUD piece, a plate), just far enough sideways to clear
      // it — as far as the spots beside it, or further while it still stands over the part of its token that shows
      // (a token half under a panel keeps its plate over its visible half) — nearest first.
      const nudges: number[] = [];
      const blockers = [
        ...covered,
        ...placed.map((p) => ({
          x0: p.x0 - PAD_PX,
          y0: p.y0 - PAD_PX,
          x1: p.x1 + PAD_PX,
          y1: p.y1 + PAD_PX,
        })),
      ];
      const overSeen = (dx: number) =>
        !!seen &&
        Math.min(r.x1 + dx, seen.x1) - Math.max(r.x0 + dx, seen.x0) >= Math.min(24, (seen.x1 - seen.x0) / 2);
      const nudgeable = (dx: number) => Math.abs(dx) <= 0.62 * w || overSeen(dx);
      for (const o of blockers) {
        if (!meets(r, o)) continue;
        for (const dx of [o.x0 - r.x1 - 0.5, o.x1 - r.x0 + 0.5]) if (nudgeable(dx)) nudges.push(dx);
      }
      nudges.sort((x, y) => Math.abs(x) - Math.abs(y));
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
          if (!meets(q, o)) continue;
          for (const dx of [o.x0 - q.x1 - 0.5, o.x1 - q.x0 + 0.5])
            if (nudgeable(slide + dx)) belowNudges.push(dx);
        }
        belowNudges.sort((x, y) => Math.abs(x) - Math.abs(y));
      }
      // Beside it, centred on the height of what shows of it (a tall standee's plate at its middle, not its feet).
      const sideDy = b && seen ? (seen.y0 + seen.y1) / 2 - (r.y0 + r.y1) / 2 : Number.NaN;
      const shift = (k: number): [number, number] => {
        if (k === SLID) return [slide !== 0 && Math.abs(slide) <= w ? slide : Number.NaN, 0];
        if (k === CLAMPED) return down;
        if (k === BELOW) return [Number.isNaN(belowDy) ? Number.NaN : slide, belowDy];
        if (k === SIDE_R) return b ? [b.x1 + SIDE_GAP_PX - r.x0, sideDy] : [Number.NaN, 0];
        if (k === SIDE_L) return b ? [b.x0 - SIDE_GAP_PX - r.x1, sideDy] : [Number.NaN, 0];
        if (k === ON) {
          const e = it.end;
          if (!e) return [Number.NaN, 0];
          return [(e.x0 + e.x1) / 2 - (r.x0 + r.x1) / 2, e.y0 + 0.65 * (e.y1 - e.y0) - (r.y0 + r.y1) / 2];
        }
        if (k >= BELOW_NUDGE) return [slide + (belowNudges[k - BELOW_NUDGE] ?? Number.NaN), belowDy];
        if (k >= NUDGE) return [nudges[k - NUDGE] ?? Number.NaN, 0];
        const [sx, sy] = SLOTS[k] as [number, number];
        return [sx * w, sy * h];
      };
      const spots = new Map<number, Spot | null>();
      const spot = (k: number): Spot | null => {
        let s = spots.get(k);
        if (s !== undefined) return s;
        const [dx, dy] = shift(k);
        if (Number.isNaN(dx) || Number.isNaN(dy)) s = null;
        else {
          const q = { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
          let leader: Segment | undefined;
          if ((Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) && it.end && !(b && overIts(q, b))) {
            const l = leaderSegment(q, it.end);
            if (segLength(l) > LEADER_MIN_PX) leader = l;
          }
          s = free(q) ? { q, dx, dy, leader } : null;
        }
        spots.set(k, s);
        return s;
      };
      const ok = (k: number, tier: number) => {
        const s = spot(k);
        if (!s) return false;
        if (tier >= 3) return true;
        const { q, leader } = s;
        // A leader through a plate hides its words; a plate over a leader cuts it; two leaders crossing tangle.
        if (leader && placed.some((p) => crosses(leader, p))) return false;
        if (leaders.some((l) => crosses(l, q))) return false;
        if (leader && leaders.some((l) => segmentsCross(l, leader))) return false;
        if (tier === 2) return true;
        // A full plate never lies across its own creature's art: only the compact bar may sit on its own face (the
        // "on" spot), and the compact steps come before a full plate's looser tiers (critic P8 r1 #16).
        if (!compact) {
          const own = bodies.find((o) => o.id === it.id);
          if (own && bodyDepth(q, own.parts) > RIM_PX) return false;
        }
        if (tier === 1) return !covers(q, ownish(k) ? BURIED : ASIDE);
        // Its leader over another creature points at that one — up to where it reaches its own token (over its own
        // art, a creature behind it is hidden by it), and all the way for one standing in front of it.
        const reach = leader && b ? before(leader, b) : leader;
        for (const o of bodies) {
          if (o.id === it.id) continue;
          if (bodyDepth(q, o.parts) > RIM_PX) return false;
          const inFront = b !== undefined && o.r.y1 > b.y1 + 1;
          const l = inFront ? leader : reach;
          if (l && crossesBody(l, o.parts, RIM_PX)) return false;
        }
        // Moved away from its own token, it must stay nearer it than any other (right above another, it reads as
        // that one's).
        if (!ownish(k) && b) {
          const mine = gap(q, b);
          if (bodies.some((o) => o.id !== it.id && gap(q, o.r) < mine)) return false;
        }
        return true;
      };
      const order = compact
        ? [0, SLID, ...nudges.map((_, i) => NUDGE + i), ON]
        : [
            0,
            SLID,
            ...nudges.map((_, i) => NUDGE + i),
            BELOW,
            ...belowNudges.map((_, i) => BELOW_NUDGE + i),
            SIDE_R,
            SIDE_L,
            CLAMPED,
            ...[...SLOTS.keys()].slice(1),
          ];
      return { order, spot, ok };
    }
  }
  return out;

  /** Its own spot in all but the shift: slid, nudged or brought down, it still stands over its own token. */
  function ownish(k: number) {
    return k === 0 || k === SLID || k === CLAMPED || k === ON || (k >= NUDGE && k < BELOW_NUDGE);
  }
}

interface Spot {
  q: Placed;
  dx: number;
  dy: number;
  leader?: Segment;
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

/** Where a token's plate is on screen now (canvas px), when it shows one — what floating numbers rise above. */
export function plateRectOf(id: string): Placed | null {
  const e = entries.get(id);
  return e && e.clear === 1 && e.rect && e.group.parent ? e.rect : null;
}

/** Where a token's body is on screen now (canvas px), when known. */
export const bodyRectOf = (id: string): Placed | null => entries.get(id)?.body ?? null;

/** Every token's body on screen now (canvas px): what HUD numbers and cards keep off. */
export function bodyRects(): { id: string; r: Placed }[] {
  const out: { id: string; r: Placed }[] = [];
  for (const [id, e] of entries) if (e.body && e.group.parent) out.push({ id, r: e.body });
  return out;
}

/** The overlays (plates) showing now, by token, in canvas px. */
export function plateRects(): { id: string; r: Placed }[] {
  const out: { id: string; r: Placed }[] = [];
  for (const [id, e] of entries) if (e.clear === 1 && e.rect && e.group.parent) out.push({ id, r: e.rect });
  return out;
}

/** The leaders drawn now (canvas px): HUD numbers keep off them too. */
export function leaderSegments(): Segment[] {
  const out: Segment[] = [];
  for (const e of entries.values()) if (e.clear === 1 && e.leader && e.group.parent) out.push(e.leader);
  return out;
}

/** Overlay priorities (higher wins a spot on screen). */
export const PRIORITY = { hovered: 5, selected: 4, own: 3, party: 2, other: 1 } as const;

/** Diagnostics for the test hooks: every overlay's verdict, rectangle, tier, leader and flip count. */
export function overlayDiagnostics() {
  return [...entries].map(([id, e]) => ({
    id,
    clear: e.clear,
    rect: e.rect,
    flips: e.flips,
    offset: e.offset,
    slot: e.slot,
    tier: e.tier,
    compact: e.compact,
    parts: e.parts ?? null,
    leaderLine: e.leader ?? null,
  }));
}
