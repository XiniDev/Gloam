import type { P } from "@gloam/shared/geometry";

/** The largest closed loop filled solid (ft²): pillars and columns; a bigger loop is a room. */
export const PILLAR_MAX_AREA = 36;

/**
 * Pillars among the solid walls: groups of segments joined end to end in a single closed loop (every corner shared by
 * exactly two), enclosing at most PILLAR_MAX_AREA — the loop's corners, in order.
 */
export function pillarLoops(segs: readonly { a: P; b: P }[]): P[][] {
  const key = (p: P) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  const at = new Map<string, P>();
  const adj = new Map<string, string[]>();
  for (const s of segs) {
    const ka = key(s.a);
    const kb = key(s.b);
    if (ka === kb) continue;
    at.set(ka, s.a);
    at.set(kb, s.b);
    adj.set(ka, [...(adj.get(ka) ?? []), kb]);
    adj.set(kb, [...(adj.get(kb) ?? []), ka]);
  }
  const seen = new Set<string>();
  const out: P[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // The connected group, and whether every corner in it has exactly two walls.
    const group: string[] = [];
    const stack = [start];
    seen.add(start);
    let ring = true;
    while (stack.length) {
      const k = stack.pop() as string;
      group.push(k);
      const n = adj.get(k) as string[];
      if (n.length !== 2) ring = false;
      for (const m of n)
        if (!seen.has(m)) {
          seen.add(m);
          stack.push(m);
        }
    }
    if (!ring || group.length < 3) continue;
    // Walk it in order.
    const order = [start];
    let prev = start;
    let cur = (adj.get(start) as string[])[0] as string;
    while (cur !== start && order.length <= group.length) {
      order.push(cur);
      const n = adj.get(cur) as string[];
      const next = n[0] === prev ? (n[1] as string) : (n[0] as string);
      prev = cur;
      cur = next;
    }
    if (order.length !== group.length) continue;
    const poly = order.map((k) => at.get(k) as P);
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as P;
      const q = poly[(i + 1) % poly.length] as P;
      area += p.x * q.y - q.x * p.y;
    }
    if (Math.abs(area) / 2 <= PILLAR_MAX_AREA) out.push(poly);
  }
  return out;
}

/** A pillar: its loop of corners, and which of the given segments are its walls. */
export interface Pillar {
  loop: P[];
  members: number[];
}

/** As `pillarLoops`, also naming each pillar's walls (indices into `segs`) — they are drawn as the pillar, not as walls. */
export function findPillars(segs: readonly { a: P; b: P }[]): Pillar[] {
  const key = (p: P) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  const edge = (p: P, q: P) => {
    const [m, n] = [key(p), key(q)];
    return m < n ? `${m}|${n}` : `${n}|${m}`;
  };
  const bySide = new Map<string, number>();
  segs.forEach((s, i) => {
    bySide.set(edge(s.a, s.b), i);
  });
  return pillarLoops(segs).map((loop) => ({
    loop,
    members: loop.map((p, i) => bySide.get(edge(p, loop[(i + 1) % loop.length] as P)) as number),
  }));
}

/** Signed area of a loop (positive: counter-clockwise with y up). */
export function loopArea(loop: readonly P[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i] as P;
    const q = loop[(i + 1) % loop.length] as P;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * The loop grown outward by `d` (inward for a negative `d`), corner by corner along the bisector (mitred; a very
 * sharp corner's mitre is capped at 4·d).
 */
export function offsetLoop(loop: readonly P[], d: number): P[] {
  const ccw = loopArea(loop) > 0;
  const n = loop.length;
  const normal = (p: P, q: P) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    // Outward: to the right of the direction of travel on a counter-clockwise loop.
    return ccw ? { x: dy / l, y: -dx / l } : { x: -dy / l, y: dx / l };
  };
  return loop.map((p, i) => {
    const n0 = normal(loop[(i + n - 1) % n] as P, p);
    const n1 = normal(p, loop[(i + 1) % n] as P);
    const k = 1 + n0.x * n1.x + n0.y * n1.y;
    let mx = ((n0.x + n1.x) / Math.max(k, 1e-6)) * d;
    let my = ((n0.y + n1.y) / Math.max(k, 1e-6)) * d;
    const m = Math.hypot(mx, my);
    const cap = 4 * Math.abs(d);
    if (m > cap) {
      mx *= cap / m;
      my *= cap / m;
    }
    return { x: p.x + mx, y: p.y + my };
  });
}

/** A pillar's solid body as triangles (table x, y → world x, z; floor at 0). */
export interface PrismData {
  position: Float32Array;
  normal: Float32Array;
  /** Distance round the outline (ft): the masonry's courses run on round the corners. 0 on the top. */
  along: Float32Array;
  /** The top's rim: 1 at the outer edge, 0 from `RIM_FT` inside it (the capstone's bevel and ink edge). */
  edge: Float32Array;
}

export const RIM_FT = 0.14;

/**
 * One closed prism for a pillar (its sides and top; the floor closes it): the loop grown by half the walls' thickness,
 * `height` tall — no member walls meeting at corners, so no coplanar faces to fight and nothing inside to show.
 */
export function pillarPrism(
  loop: readonly P[],
  thick: number,
  height: number,
  triangulate: (contour: P[]) => number[][],
): PrismData {
  const outer = offsetLoop(loop, thick / 2);
  const inner = offsetLoop(outer, -RIM_FT);
  const pos: number[] = [];
  const nor: number[] = [];
  const along: number[] = [];
  const edge: number[] = [];
  const ccw = loopArea(outer) > 0;
  const vert = (x: number, y: number, z: number, n: [number, number, number], a: number, e: number) => {
    pos.push(x, y, z);
    nor.push(...n);
    along.push(a);
    edge.push(e);
  };
  // Sides: one quad per outline edge, facing out, wound counter-clockwise seen from outside.
  let run = 0;
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i] as P;
    const q = outer[(i + 1) % outer.length] as P;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const nx = ccw ? (q.y - p.y) / len : (p.y - q.y) / len;
    const nz = ccw ? (p.x - q.x) / len : (q.x - p.x) / len;
    const n: [number, number, number] = [nx, 0, nz];
    // Seen from outside (world x, z with y up), p → q runs one way or the other; wind so the normal faces out.
    const [s, t, sa, ta] = ccw ? [q, p, run + len, run] : [p, q, run, run + len];
    vert(s.x, 0, s.y, n, sa, 0);
    vert(t.x, 0, t.y, n, ta, 0);
    vert(t.x, height, t.y, n, ta, 0);
    vert(s.x, 0, s.y, n, sa, 0);
    vert(t.x, height, t.y, n, ta, 0);
    vert(s.x, height, s.y, n, sa, 0);
    run += len;
  }
  const up: [number, number, number] = [0, 1, 0];
  // The top: a rim band between the outline and the inset, then the inside.
  const topTri = (a: P, ea: number, b: P, eb: number, c: P, ec: number) => {
    // Facing up in world space: (x, z) counter-clockwise seen from above is clockwise in table x, y (z = y).
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (cross > 0) {
      vert(a.x, height, a.y, up, 0, ea);
      vert(c.x, height, c.y, up, 0, ec);
      vert(b.x, height, b.y, up, 0, eb);
    } else {
      vert(a.x, height, a.y, up, 0, ea);
      vert(b.x, height, b.y, up, 0, eb);
      vert(c.x, height, c.y, up, 0, ec);
    }
  };
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    const o0 = outer[i] as P;
    const o1 = outer[j] as P;
    const i0 = inner[i] as P;
    const i1 = inner[j] as P;
    topTri(o0, 1, o1, 1, i1, 0);
    topTri(o0, 1, i1, 0, i0, 0);
  }
  for (const [a, b, c] of triangulate(inner))
    topTri(inner[a as number] as P, 0, inner[b as number] as P, 0, inner[c as number] as P, 0);
  return {
    position: Float32Array.from(pos),
    normal: Float32Array.from(nor),
    along: Float32Array.from(along),
    edge: Float32Array.from(edge),
  };
}
