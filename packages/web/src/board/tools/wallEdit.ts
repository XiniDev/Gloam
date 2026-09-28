import type { P } from "@gloam/shared/geometry";

/**
 * The Walls tool's geometry (SPEC §8.7 Editor tools; AC-WAL-02, AC-WAL-07), free of React and three: snapping
 * (endpoints within 1 ft, onto a wall's line, Shift's 15° angles), joints, hit tests and box selection. Everything a
 * pointer move needs is O(1) or one pass over the walls, so a scene of 1 000 walls stays well inside a frame.
 */

export interface Seg {
  id: string;
  a: P;
  b: P;
}
export type End = "a" | "b";
export interface EndRef {
  id: string;
  end: End;
}
export type SnapKind = "end" | "wall" | "angle";
export interface Snapped {
  p: P;
  kind: SnapKind | null;
}

/** Endpoint snapping radius (SPEC §8.7: "endpoint snapping within 1 ft"). */
export const SNAP_FT = 1;
/** Snapping onto a wall's line (a T-junction), weaker than endpoints so it never steals them. */
export const ON_WALL_FT = 0.5;
/** Ends closer than this are one joint (the server's JOINT_EPS_FT). */
export const JOINT_EPS = 0.01;
/** Shift's angle step. */
export const ANGLE_STEP_DEG = 15;
/** Pieces shorter than this aren't walls (a double-click's second point, a slip of the mouse). */
export const MIN_WALL_FT = 0.1;

const dist = (p: P, q: P) => Math.hypot(p.x - q.x, p.y - q.y);

/** The point on segment ab nearest to p, and how far p is from it. */
export function footOn(p: P, a: P, b: P): { p: P; d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  const q = { x: a.x + dx * t, y: a.y + dy * t };
  return { p: q, d: dist(p, q), t };
}

/**
 * The walls' endpoints on a 1-ft grid: the nearest end to a point, or every end at a joint, without scanning every
 * wall. Built once per wall set (or per drag, leaving out what's being dragged).
 */
export class EndIndex {
  private readonly cells = new Map<number, { p: P; id: string; end: End }[]>();
  private static key(cx: number, cy: number): number {
    // Coordinates are within ±100 000 ft (the protocol's range): pack both cells into one safe integer.
    return (cx + 200_000) * 400_001 + (cy + 200_000);
  }
  constructor(segs: Iterable<Seg>, skip?: (id: string) => boolean) {
    for (const s of segs) {
      if (skip?.(s.id)) continue;
      this.add(s.a, s.id, "a");
      this.add(s.b, s.id, "b");
    }
  }
  private add(p: P, id: string, end: End): void {
    const k = EndIndex.key(Math.floor(p.x), Math.floor(p.y));
    const list = this.cells.get(k);
    if (list) list.push({ p, id, end });
    else this.cells.set(k, [{ p, id, end }]);
  }
  /** Every end within r (≤ 1 ft) of p. */
  within(p: P, r: number): { p: P; id: string; end: End; d: number }[] {
    const out: { p: P; id: string; end: End; d: number }[] = [];
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get(EndIndex.key(cx + dx, cy + dy));
        if (!list) continue;
        for (const e of list) {
          const d = dist(p, e.p);
          if (d <= r) out.push({ ...e, d });
        }
      }
    return out;
  }
  nearest(p: P, r: number): { p: P; id: string; end: End; d: number } | null {
    let best: { p: P; id: string; end: End; d: number } | null = null;
    for (const e of this.within(p, r)) if (!best || e.d < best.d) best = e;
    return best;
  }
  /** The ends forming the joint at p (within JOINT_EPS). */
  joint(p: P): EndRef[] {
    return this.within(p, JOINT_EPS).map(({ id, end }) => ({ id, end }));
  }
}

/** Shift: the direction from `from` rounded to 15°, keeping the pointer's distance along it. */
export function angleSnap(from: P, raw: P, stepDeg = ANGLE_STEP_DEG): P {
  const deg =
    (((Math.round((Math.atan2(raw.y - from.y, raw.x - from.x) * (180 / Math.PI)) / stepDeg) * stepDeg) %
      360) +
      360) %
    360;
  // Exact unit vectors on the axes, so horizontal and vertical walls are exactly that.
  const axis: Record<number, [number, number]> = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };
  const [ux, uy] = axis[deg] ?? [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  const len = Math.max(0, (raw.x - from.x) * ux + (raw.y - from.y) * uy);
  return { x: from.x + ux * len, y: from.y + uy * len };
}

export interface SnapContext {
  ends: EndIndex;
  segs: Iterable<Seg>;
  /** More points to snap to (the chain being drawn). */
  extra?: P[];
  /** The previous point, for Shift's angles. */
  from?: P | null;
  /** Shift held. */
  angle?: boolean;
  /** Ctrl/Cmd held: no snapping at all. */
  off?: boolean;
  /** Walls not to snap onto (the ones being dragged). */
  skip?: (id: string) => boolean;
}

/**
 * Where a pointer at `raw` puts a point: Ctrl/Cmd → exactly there; Shift → on the nearest 15° ray from the previous
 * point; else the nearest wall end (or chain point) within 1 ft; else the nearest point on a wall within ½ ft.
 */
export function snapPoint(raw: P, ctx: SnapContext): Snapped {
  if (ctx.off) return { p: raw, kind: null };
  if (ctx.angle && ctx.from) return { p: angleSnap(ctx.from, raw), kind: "angle" };
  let best: P | null = null;
  let bestD = SNAP_FT;
  const e = ctx.ends.nearest(raw, SNAP_FT);
  if (e) {
    best = e.p;
    bestD = e.d;
  }
  for (const q of ctx.extra ?? []) {
    const d = dist(raw, q);
    if (d <= bestD) {
      best = q;
      bestD = d;
    }
  }
  if (best) return { p: { x: best.x, y: best.y }, kind: "end" };
  let on: P | null = null;
  let onD = ON_WALL_FT;
  for (const s of ctx.segs) {
    if (ctx.skip?.(s.id)) continue;
    // Cheap reject on the bounding box before the projection.
    if (
      raw.x < Math.min(s.a.x, s.b.x) - onD ||
      raw.x > Math.max(s.a.x, s.b.x) + onD ||
      raw.y < Math.min(s.a.y, s.b.y) - onD ||
      raw.y > Math.max(s.a.y, s.b.y) + onD
    )
      continue;
    const f = footOn(raw, s.a, s.b);
    if (f.d <= onD) {
      on = f.p;
      onD = f.d;
    }
  }
  return on ? { p: on, kind: "wall" } : { p: raw, kind: null };
}

/** The wall nearest to p within `tol` ft, or null. */
export function wallAt(p: P, segs: Iterable<Seg>, tol: number): string | null {
  let best: string | null = null;
  let bestD = tol;
  for (const s of segs) {
    if (
      p.x < Math.min(s.a.x, s.b.x) - tol ||
      p.x > Math.max(s.a.x, s.b.x) + tol ||
      p.y < Math.min(s.a.y, s.b.y) - tol ||
      p.y > Math.max(s.a.y, s.b.y) + tol
    )
      continue;
    const d = footOn(p, s.a, s.b).d;
    if (d <= bestD) {
      best = s.id;
      bestD = d;
    }
  }
  return best;
}

/** Does segment ab cross (or lie in) the axis-aligned rectangle? */
export function segHitsRect(a: P, b: P, r: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const minX = Math.min(r.x0, r.x1);
  const maxX = Math.max(r.x0, r.x1);
  const minY = Math.min(r.y0, r.y1);
  const maxY = Math.max(r.y0, r.y1);
  // Liang–Barsky clipping: the segment survives clipping iff it touches the rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, a.x - minX) && clip(dx, maxX - a.x) && clip(-dy, a.y - minY) && clip(dy, maxY - a.y) && t0 <= t1
  );
}

/** A chain of points as wall segments (closed: back to the first), dropping pieces shorter than MIN_WALL_FT. */
export function chainSegments(points: P[], closed = false): { a: P; b: P }[] {
  const out: { a: P; b: P }[] = [];
  const n = points.length;
  for (let i = 0; i + 1 < n + (closed ? 1 : 0); i++) {
    const a = points[i] as P;
    const b = points[(i + 1) % n] as P;
    if (dist(a, b) >= MIN_WALL_FT) out.push({ a, b });
  }
  return out;
}

/** The Room tool's rectangle: its four corners, clockwise from the press. */
export function rectCorners(a: P, b: P): P[] {
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
}

/**
 * Moving ends: every end of `refs` goes to where its joint's grab point went. For a joint drag all ends share one
 * point; for a move-by-offset each end keeps its own place plus the offset.
 */
export function movedWalls(
  segs: ReadonlyMap<string, Seg>,
  refs: EndRef[],
  place: (from: P) => P,
): Map<string, { a: P; b: P }> {
  const out = new Map<string, { a: P; b: P }>();
  for (const r of refs) {
    const s = segs.get(r.id);
    if (!s) continue;
    const cur = out.get(r.id) ?? { a: s.a, b: s.b };
    out.set(r.id, r.end === "a" ? { a: place(s.a), b: cur.b } : { a: cur.a, b: place(s.b) });
  }
  return out;
}

export const samePoint = (p: P, q: P) => dist(p, q) < JOINT_EPS;
