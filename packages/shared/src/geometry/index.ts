/**
 * 2D geometry on the table plane (SPEC §16): x = east, y = south, in feet. Shared by the client (previews, tools)
 * and the server (authority), so both compute the same numbers.
 */
export interface P {
  x: number;
  y: number;
}
export interface Seg {
  a: P;
  b: P;
}

export const EPS = 1e-9;

export const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: P, k: number): P => ({ x: a.x * k, y: a.y * k });
export const dot = (a: P, b: P): number => a.x * b.x + a.y * b.y;
export const cross = (a: P, b: P): number => a.x * b.y - a.y * b.x;
export const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Length of a polyline. */
export function pathLength(points: P[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += dist(points[i - 1] as P, points[i] as P);
  return n;
}

/** Parameter t ∈ [0, 1] of the point on segment ab closest to p. */
export function closestT(p: P, a: P, b: P): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return 0;
  return Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
}

export function pointSegDist(p: P, a: P, b: P): number {
  return dist(p, lerp(a, b, closestT(p, a, b)));
}

/**
 * Where segments pq and ab cross: { t, u } along pq and ab (both in [0, 1]), or null when they don't (parallel or
 * collinear segments return null; clearance tests catch collinear contact through distances).
 */
export function segIntersect(p: P, q: P, a: P, b: P): { t: number; u: number } | null {
  const r = sub(q, p);
  const s = sub(b, a);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  const ap = sub(a, p);
  const t = cross(ap, s) / den;
  const u = cross(ap, r) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) };
}

/** Shortest distance between segments pq and ab (0 when they cross). */
export function segSegDist(p: P, q: P, a: P, b: P): number {
  if (segIntersect(p, q, a, b)) return 0;
  return Math.min(pointSegDist(p, a, b), pointSegDist(q, a, b), pointSegDist(a, p, q), pointSegDist(b, p, q));
}

/** Squared distance from (px, py) to segment (ax, ay)–(bx, by). Scalar arguments: allocation-free for hot loops. */
export function pointSegDist2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-18 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}

/** Squared distance between segments (ax, ay)–(bx, by) and (cx, cy)–(dx, dy); 0 when they cross. */
export function segSegDist2(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  // Proper crossing: each segment's ends on opposite sides of the other's line.
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  // Otherwise the closest pair involves an endpoint (touching and collinear cases come out as 0 here).
  return Math.min(
    pointSegDist2(ax, ay, cx, cy, dx, dy),
    pointSegDist2(bx, by, cx, cy, dx, dy),
    pointSegDist2(cx, cy, ax, ay, bx, by),
    pointSegDist2(dx, dy, ax, ay, bx, by),
  );
}

/**
 * The first t ∈ [0, 1] along pq at which a circle of radius r moving from p to q touches segment ab (a "capsule"
 * sweep), or null if it never does. Used to truncate moves at the contact point (§16.5). The distance from a point
 * moving along a line to a segment is convex in t, so: find its minimum (ternary search), and if that's within r,
 * bisect the monotone stretch before it for the exact contact.
 */
export function sweepCircleSeg(p: P, q: P, r: number, a: P, b: P): number | null {
  const f = (t: number) => pointSegDist(lerp(p, q, t), a, b);
  if (f(0) <= r) return 0;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 80; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) <= f(m2)) hi = m2;
    else lo = m1;
  }
  const tMin = (lo + hi) / 2;
  if (f(tMin) > r) return null;
  lo = 0;
  hi = tMin;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) <= r) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** First t along pq where a circle of radius r (centre moving p→q) touches a circle (c, rc), or null. */
export function sweepCircleCircle(p: P, q: P, r: number, c: P, rc: number): number | null {
  const R = r + rc;
  const d = sub(q, p);
  const f = sub(p, c);
  const A = dot(d, d);
  const B = 2 * dot(f, d);
  const C = dot(f, f) - R * R;
  if (C < 0) return 0;
  if (A < EPS) return null;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : null;
}

/** Even–odd point-in-polygon. */
export function inPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as P;
    const b = poly[j] as P;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Every t ∈ (0, 1) where segment pq crosses the polygon's boundary, sorted. */
export function polygonCrossings(p: P, q: P, poly: P[]): number[] {
  const ts: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const hit = segIntersect(p, q, poly[j] as P, poly[i] as P);
    if (hit && hit.t > EPS && hit.t < 1 - EPS) ts.push(hit.t);
  }
  return ts.sort((a, b) => a - b);
}

/** Every t ∈ (0, 1) where segment pq crosses a circle's rim, sorted. */
export function circleCrossings(p: P, q: P, c: P, r: number): number[] {
  const d = sub(q, p);
  const f = sub(p, c);
  const A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => t > EPS && t < 1 - EPS).sort((a, b) => a - b);
}

/** A rectangle or circle zone as a polygon (circles as 48-gons) — for tools that need edges. */
export function rectPolygon(x: number, y: number, w: number, h: number): P[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/**
 * A circle as an n-gon. `outside` puts the edges on the circle (the polygon contains it — for anything that must
 * block at least the whole circle); otherwise the vertices are on it.
 */
export function circlePolygon(c: P, r: number, n = 48, outside = false): P[] {
  const R = outside ? r / Math.cos(Math.PI / n) : r;
  return Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return { x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R };
  });
}

/** Ramer–Douglas–Peucker simplification of an open polyline: every dropped point lies within `tol` of the result. */
export function simplifyPath(points: P[], tol: number): P[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() as [number, number];
    let far = -1;
    let best = tol;
    const a = points[i] as P;
    const b = points[j] as P;
    for (let k = i + 1; k < j; k++) {
      const d = pointSegDist(points[k] as P, a, b);
      if (d > best) {
        best = d;
        far = k;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([i, far], [far, j]);
  }
  return points.filter((_, k) => keep[k]);
}

/** The point at arc length s along a polyline (clamped to its ends). */
export function pointAtLength(points: P[], s: number): { point: P; index: number } {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as P;
    const b = points[i] as P;
    const l = dist(a, b);
    if (acc + l >= s) return { point: l < EPS ? b : lerp(a, b, (s - acc) / l), index: i };
    acc += l;
  }
  return { point: points[points.length - 1] as P, index: points.length - 1 };
}

/** n + 1 points evenly spaced along a path (by length), start and end included — one walk along it. */
export function samplePath(points: P[], n: number): P[] {
  const out: P[] = [];
  const L = pathLength(points);
  if (points.length === 0) return out;
  if (n < 1 || L < EPS) return [points[0] as P];
  let i = 1;
  let acc = 0;
  for (let k = 0; k <= n; k++) {
    const s = k === n ? L : (k * L) / n;
    while (i < points.length - 1 && acc + dist(points[i - 1] as P, points[i] as P) < s) {
      acc += dist(points[i - 1] as P, points[i] as P);
      i++;
    }
    const a = points[i - 1] as P;
    const b = points[i] as P;
    const l = dist(a, b);
    out.push(l < EPS ? b : lerp(a, b, Math.min(1, Math.max(0, (s - acc) / l))));
  }
  return out;
}

/** An axis-aligned rectangle (feet). */
export interface Rect2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A polygon cut to a rectangle (Sutherland–Hodgman): the part of it inside — empty when none is. */
export function clipPolygonToRect(poly: readonly P[], r: Rect2): P[] {
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p.x >= r.minX, (a, b) => lerp(a, b, (r.minX - a.x) / (b.x - a.x))],
    [(p) => p.x <= r.maxX, (a, b) => lerp(a, b, (r.maxX - a.x) / (b.x - a.x))],
    [(p) => p.y >= r.minY, (a, b) => lerp(a, b, (r.minY - a.y) / (b.y - a.y))],
    [(p) => p.y <= r.maxY, (a, b) => lerp(a, b, (r.maxY - a.y) / (b.y - a.y))],
  ];
  let out: P[] = [...poly];
  for (const [inside, cut] of edges) {
    if (!out.length) break;
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[(i + src.length - 1) % src.length] as P;
      const b = src[i] as P;
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
  }
  return out;
}

/**
 * A closed outline's edges, each cut to a rectangle (Liang–Barsky): the parts inside, as segments — an effect's edge
 * drawn only on the map, never across the table round it.
 */
export function clipOutlineToRect(poly: readonly P[], r: Rect2): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as P;
    const b = poly[(i + 1) % poly.length] as P;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [pp, q] of [
      [-dx, a.x - r.minX],
      [dx, r.maxX - a.x],
      [-dy, a.y - r.minY],
      [dy, r.maxY - a.y],
    ] as const) {
      if (pp === 0) {
        if (q < 0) ok = false;
        continue;
      }
      const t = q / pp;
      if (pp < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (ok && t1 - t0 > EPS) out.push({ a: lerp(a, b, t0), b: lerp(a, b, t1) });
  }
  return out;
}

export * from "./visibility.ts";
