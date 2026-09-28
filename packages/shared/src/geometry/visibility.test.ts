import { describe, expect, it } from "vitest";
import type { P, Seg } from "./index.ts";
import {
  BOUND_SIDES,
  inCone,
  SegmentSet,
  type VisPoly,
  visContains,
  visibilityPolygon,
  visNear,
  visOverlap,
  visRing,
  type Wedge,
} from "./visibility.ts";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seg = (ax: number, ay: number, bx: number, by: number): Seg => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});

/** Closed segments pq and ab meet (touching counts). */
function meets(p: P, q: P, a: P, b: P): boolean {
  const o = (u: P, v: P, w: P) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const d1 = o(a, b, p);
  const d2 = o(a, b, q);
  const d3 = o(p, q, a);
  const d4 = o(p, q, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (u: P, v: P, w: P) =>
    Math.min(u.x, v.x) <= w.x &&
    w.x <= Math.max(u.x, v.x) &&
    Math.min(u.y, v.y) <= w.y &&
    w.y <= Math.max(u.y, v.y);
  return (
    (d1 === 0 && on(a, b, p)) ||
    (d2 === 0 && on(a, b, q)) ||
    (d3 === 0 && on(p, q, a)) ||
    (d4 === 0 && on(p, q, b))
  );
}
function segDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}
/** Distance from p to the ray starting at s in direction d (unit). */
function rayDist(p: P, s: P, d: P): number {
  const t = Math.max(0, (p.x - s.x) * d.x + (p.y - s.y) * d.y);
  return Math.hypot(s.x + t * d.x - p.x, s.y + t * d.y - p.y);
}
function bound(eye: P, R: number): P[] {
  return Array.from({ length: BOUND_SIDES }, (_, k) => {
    const a = -Math.PI + (k * 2 * Math.PI) / BOUND_SIDES;
    return { x: eye.x + R * Math.cos(a), y: eye.y + R * Math.sin(a) };
  });
}

/**
 * The brute-force answer and whether p is in the tolerance band — within 0.01 ft of the true region's boundary,
 * which is made of walls, the bound's edges and shadow rays out of wall endpoints (independent of the result).
 * Prepared once per scene.
 */
function oracle(eye: P, R: number, walls: Seg[]) {
  const B = bound(eye, R);
  const rays = walls.flatMap((w) =>
    [w.a, w.b].flatMap((e) => {
      const L = Math.hypot(e.x - eye.x, e.y - eye.y);
      return L > 1e-9 ? [{ s: e, d: { x: (e.x - eye.x) / L, y: (e.y - eye.y) / L } }] : [];
    }),
  );
  const sector = (2 * Math.PI) / BOUND_SIDES;
  return (p: P): { visible: boolean; band: boolean } => {
    // The bound: p's sector's edge decides inside; the band looks at it and its neighbours.
    const a = Math.atan2(p.y - eye.y, p.x - eye.x);
    const k = Math.min(BOUND_SIDES - 1, Math.floor((a + Math.PI) / sector));
    const e0 = B[k] as P;
    const e1 = B[(k + 1) % BOUND_SIDES] as P;
    const inside = (e1.x - e0.x) * (p.y - e0.y) - (e1.y - e0.y) * (p.x - e0.x) >= 0;
    let band = false;
    for (const j of [k - 1, k, k + 1]) {
      const u = B[(j + BOUND_SIDES) % BOUND_SIDES] as P;
      const v = B[(j + 1 + BOUND_SIDES) % BOUND_SIDES] as P;
      if (segDist(p, u, v) < 0.01) band = true;
    }
    let blocked = false;
    for (const w of walls) {
      if (!band && segDist(p, w.a, w.b) < 0.01) band = true;
      if (!blocked && meets(eye, p, w.a, w.b)) blocked = true;
    }
    if (!band) for (const r of rays) if (rayDist(p, r.s, r.d) < 0.01) band = true;
    return { visible: inside && !blocked, band };
  };
}

type Scene = { walls: Seg[]; eye: P; R: number };

/** Scenes of every flavour: random crossings, grid rooms with T-junctions and doors, collinear overlaps, eyes on walls. */
function scene(i: number): Scene {
  const r = rng(1000 + i);
  const walls: Seg[] = [];
  const kind = i % 5;
  const R = 10 + r() * 140;
  let eye: P = { x: 20 + r() * 60, y: 20 + r() * 60 };
  if (kind === 0) {
    // Random segments, crossing freely.
    const n = 1 + Math.floor(r() * 30);
    for (let k = 0; k < n; k++) {
      const x = r() * 100;
      const y = r() * 100;
      const a = r() * Math.PI * 2;
      const L = r() < 0.1 ? r() * 0.001 : 1 + r() * 40;
      walls.push(seg(x, y, x + Math.cos(a) * L, y + Math.sin(a) * L));
    }
  } else if (kind === 1) {
    // Rooms on a 10-ft grid: shared corners, T-junctions, door gaps.
    for (let x = 0; x <= 60; x += 10)
      for (let y = 0; y <= 60; y += 10) {
        if (r() < 0.45) walls.push(seg(x, y, x + 10, y));
        else if (r() < 0.2) walls.push(seg(x, y, x + 4, y), seg(x + 7, y, x + 10, y));
        if (r() < 0.45) walls.push(seg(x, y, x, y + 10));
        if (r() < 0.1) walls.push(seg(x, y, x + 5, y + 5)); // a diagonal ending on nothing
        if (r() < 0.08) walls.push(seg(x + 5, y, x + 5, y + 10)); // T onto the room's walls
      }
    eye = { x: Math.floor(r() * 6) * 10 + 1 + r() * 8, y: Math.floor(r() * 6) * 10 + 1 + r() * 8 };
  } else if (kind === 2) {
    // Collinear overlapping and chained segments on a few lines, plus duplicates.
    for (let k = 0; k < 6; k++) {
      const y = 10 + r() * 80;
      const x0 = r() * 50;
      walls.push(seg(x0, y, x0 + 20, y), seg(x0 + 10, y, x0 + 35, y), seg(x0 + 35, y, x0 + 50, y));
      walls.push(seg(x0 + 10, y, x0 + 35, y));
      const x = 10 + r() * 80;
      walls.push(seg(x, 0, x, 40), seg(x, 20, x, 70));
    }
  } else if (kind === 3) {
    // The eye on a wall (it's moved off), walls through the eye's row and column, corners at the eye's angles.
    const n = 3 + Math.floor(r() * 12);
    for (let k = 0; k < n; k++) {
      const x = r() * 100;
      const y = r() * 100;
      walls.push(seg(x, y, x + (r() - 0.5) * 60, y + (r() - 0.5) * 60));
    }
    const w = walls[0] as Seg;
    const t = 0.2 + r() * 0.6;
    eye = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
    walls.push(seg(eye.x - 30, eye.y + 5, eye.x - 5, eye.y + 5)); // a wall with an end on the eye's −x side
    walls.push(seg(eye.x - 20, eye.y, eye.x - 10, eye.y)); // edge-on, on the −x ray itself
    walls.push(seg(eye.x - 25, eye.y - 8, eye.x - 25, eye.y + 8)); // across the −x ray
  } else {
    // Closed polygons (pillars and rooms), the eye inside or outside.
    const n = 1 + Math.floor(r() * 6);
    for (let k = 0; k < n; k++) {
      const cx = r() * 100;
      const cy = r() * 100;
      const m = 3 + Math.floor(r() * 7);
      const rad = 2 + r() * 25;
      const pts = Array.from({ length: m }, (_, j) => {
        const a = (j / m) * Math.PI * 2 + r() * 0.3;
        return { x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad };
      });
      for (let j = 0; j < m; j++) walls.push({ a: pts[j] as P, b: pts[(j + 1) % m] as P });
    }
  }
  return { walls, eye, R };
}

describe("visibilityPolygon (SPEC §15.2)", () => {
  it("agrees with a brute-force ray caster on 2 000 random scenes × 500 points, outside a 0.01-ft band", {
    timeout: 120_000,
  }, () => {
    let disagreements = 0;
    let tested = 0;
    const examples: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const s = scene(i);
      const set = new SegmentSet(s.walls);
      const v = visibilityPolygon(s.eye, set, s.R);
      const brute = oracle(v.eye, s.R, s.walls);
      const r = rng(9000 + i);
      for (let k = 0; k < 500; k++) {
        let p: P;
        if (k % 3 === 0 && s.walls.length) {
          // Near a wall's end (where leaks would be).
          const w = s.walls[Math.floor(r() * s.walls.length)] as Seg;
          const e = r() < 0.5 ? w.a : w.b;
          p = { x: e.x + (r() - 0.5) * 3, y: e.y + (r() - 0.5) * 3 };
        } else {
          const a = r() * Math.PI * 2;
          const d = Math.sqrt(r()) * s.R * 1.05;
          p = { x: v.eye.x + Math.cos(a) * d, y: v.eye.y + Math.sin(a) * d };
        }
        const o = brute(p);
        if (o.band) continue;
        tested++;
        if (visContains(v, p.x, p.y) !== o.visible) {
          disagreements++;
          if (examples.length < 5)
            examples.push(`scene ${i} p=(${p.x.toFixed(4)}, ${p.y.toFixed(4)}) brute=${o.visible}`);
        }
      }
    }
    expect(examples).toEqual([]);
    expect(disagreements).toBe(0);
    expect(tested).toBeGreaterThan(700_000);
  });

  it("a closed room holds the view exactly; a T-junction's corner doesn't leak", () => {
    // Room 0..20 × 0..20, split by a wall x = 10 from y = 0 to 20 that meets the south wall in a T (y = 20 wall runs
    // on to 30).
    const walls = [
      seg(0, 0, 20, 0),
      seg(20, 0, 20, 20),
      seg(0, 20, 30, 20),
      seg(0, 0, 0, 20),
      seg(10, 0, 10, 20),
    ];
    const v = visibilityPolygon({ x: 5, y: 10 }, new SegmentSet(walls), 100);
    expect(visContains(v, 9.99, 19.99)).toBe(true);
    expect(visContains(v, 10.01, 19.99)).toBe(false);
    // Just past the T's point on the ray from the eye through it.
    const dx = 10 - 5;
    const dy = 20 - 10;
    const L = Math.hypot(dx, dy);
    expect(visContains(v, 10 + (dx / L) * 0.001, 20 + (dy / L) * 0.001)).toBe(false);
    expect(visContains(v, -0.01, 10)).toBe(false);
    expect(visContains(v, 5, 20.01)).toBe(false);
  });

  it("moves an eye on a wall 0.01 ft toward the token centre, and off the wall's side without one", () => {
    const walls = [seg(0, 10, 20, 10)];
    const set = new SegmentSet(walls);
    const v = visibilityPolygon({ x: 5, y: 10 }, set, 50, { x: 5, y: 12 });
    expect(v.eye.x).toBeCloseTo(5, 9);
    expect(v.eye.y).toBeCloseTo(10.01, 9);
    // South of the wall now: it sees the south, not the north.
    expect(visContains(v, 5, 15)).toBe(true);
    expect(visContains(v, 5, 5)).toBe(false);
    const w = visibilityPolygon({ x: 5, y: 10 }, set, 50);
    expect(Math.abs(w.eye.y - 10)).toBeCloseTo(0.01, 9);
  });

  it("ignores zero-length segments and keeps the radius bound", () => {
    const v = visibilityPolygon({ x: 0, y: 0 }, new SegmentSet([seg(3, 3, 3, 3)]), 10);
    expect(visContains(v, 3, 3)).toBe(true);
    expect(visContains(v, 9.9, 0)).toBe(true);
    expect(visContains(v, 10.1, 0)).toBe(false);
    // The ring is closed around the eye: 64 corners for an empty scene.
    expect(visRing(v).length / 2).toBe(BOUND_SIDES);
  });

  it("is quick: 500 walls, sight to the scene's diagonal, well under a millisecond per eye on average", () => {
    const r = rng(7);
    const walls: Seg[] = [];
    for (let k = 0; k < 500; k++) {
      const x = r() * 200;
      const y = r() * 200;
      walls.push(seg(x, y, x + (r() - 0.5) * 20, y + (r() - 0.5) * 20));
    }
    const set = new SegmentSet(walls);
    const t0 = Date.now();
    for (let k = 0; k < 200; k++) visibilityPolygon({ x: r() * 200, y: r() * 200 }, set, 283);
    const per = (Date.now() - t0) / 200;
    expect(per).toBeLessThan(5);
  });
});

/** A point inside both regions (and the cone) with room round it: a witness that they overlap in area. */
function robustlyInBoth(a: VisPoly, b: VisPoly, x: number, y: number, cone?: Wedge | null): boolean {
  for (const [dx, dy] of [
    [0, 0],
    [0.02, 0],
    [-0.02, 0],
    [0, 0.02],
    [0, -0.02],
  ] as const) {
    const px = x + dx;
    const py = y + dy;
    if (!visContains(a, px, py) || !visContains(b, px, py)) return false;
    if (cone && !inCone(px - a.eye.x, py - a.eye.y, cone.dir, cone.half - 0.01)) return false;
  }
  return true;
}

describe("regions overlapping (visOverlap: whose light reaches whose sight, SPEC §13.4)", () => {
  it("regions on the two sides of one wall touch along it but never overlap — straight or slanted, with clutter", () => {
    const r = rng(77);
    let touching = 0;
    for (let i = 0; i < 400; i++) {
      const mx = 20 + r() * 60;
      const my = 20 + r() * 60;
      const a = r() * Math.PI;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const walls: Seg[] = [seg(mx - ux * 400, my - uy * 400, mx + ux * 400, my + uy * 400)];
      for (let k = 0; k < 6; k++) {
        const x = r() * 100;
        const y = r() * 100;
        walls.push(seg(x, y, x + (r() - 0.5) * 20, y + (r() - 0.5) * 20));
      }
      const set = new SegmentSet(walls);
      // Eyes either side of the wall (the normal is (−uy, ux)).
      const d1 = 0.5 + r() * 30;
      const d2 = 0.5 + r() * 30;
      const t1 = (r() - 0.5) * 40;
      const t2 = (r() - 0.5) * 40;
      const A = visibilityPolygon(
        { x: mx + ux * t1 - uy * d1, y: my + uy * t1 + ux * d1 },
        set,
        5 + r() * 80,
      );
      const B = visibilityPolygon(
        { x: mx + ux * t2 + uy * d2, y: my + uy * t2 - ux * d2 },
        set,
        5 + r() * 80,
      );
      expect(visOverlap(A, B)).toBe(false);
      expect(visOverlap(B, A)).toBe(false);
      // (They do meet the wall from both sides, most of the time: the case is the real one.)
      if (visNear(A, mx - ux * 400, my - uy * 400, mx + ux * 400, my + uy * 400, 1e-3)) touching++;
    }
    expect(touching).toBeGreaterThan(300);
  });

  it("a glow seen only through a slit, on a far wall, overlaps — though no vertex of the lit area lies in the sight and the light itself is out of it", () => {
    // A far wall (y = 0); a wall at y = 40 with a 0.4-ft slit at x = 50; the viewer beyond it at (50, 60); a light
    // off to the side at (70, 5), lighting 29 ft.
    const walls = [seg(0, 0, 100, 0), seg(0, 40, 49.8, 40), seg(50.2, 40, 100, 40)];
    const set = new SegmentSet(walls);
    const sight = visibilityPolygon({ x: 50, y: 60 }, set, 200);
    const lit = visibilityPolygon({ x: 70, y: 5 }, set, 29);
    // What sampling the lit outline (pulled 5 % toward the light) would test — all of it outside the sight.
    const ring = visRing(lit);
    let sampled = visContains(sight, 70, 5);
    for (let k = 0; k < ring.length; k += 2) {
      const x = 70 + ((ring[k] as number) - 70) * 0.95;
      const y = 5 + ((ring[k + 1] as number) - 5) * 0.95;
      if (visContains(sight, x, y)) sampled = true;
    }
    expect(sampled).toBe(false);
    expect(robustlyInBoth(lit, sight, 50, 10)).toBe(true);
    expect(visOverlap(lit, sight)).toBe(true);
    expect(visOverlap(sight, lit)).toBe(true);
  });

  it("a cone light: only the part of its lit area in its cone counts, including cones wider than a half-turn", () => {
    const walls = [seg(0, 0, 100, 0), seg(0, 40, 49.8, 40), seg(50.2, 40, 100, 40)];
    const set = new SegmentSet(walls);
    const sight = visibilityPolygon({ x: 50, y: 60 }, set, 200);
    const lit = visibilityPolygon({ x: 70, y: 5 }, set, 29);
    const deg = Math.PI / 180;
    // Brute force over the slit's strip: a robust common point inside the cone.
    const brute = (cone: Wedge) => {
      for (let y = 0.05; y < 40; y += 0.1)
        for (let x = 49; x <= 51; x += 0.05) if (robustlyInBoth(lit, sight, x, y, cone)) return true;
      return false;
    };
    const cases: [Wedge, boolean][] = [
      [{ dir: Math.PI, half: 30 * deg }, true], // facing the slit's strip (west)
      [{ dir: 0, half: 30 * deg }, false], // facing away (east)
      [{ dir: Math.PI / 2, half: 30 * deg }, false], // facing south, past the strip
      [{ dir: 0, half: 166 * deg }, true], // 332° about east: reaches the strip's north-west part
      [{ dir: 0, half: 126 * deg }, false], // 252° about east: short of it
      [{ dir: -Math.PI + 0.1, half: 20 * deg }, true], // across the ±π seam
    ];
    for (const [cone, want] of cases) {
      expect([cone, brute(cone)]).toEqual([cone, want]);
      expect([cone, visOverlap(lit, sight, cone)]).toEqual([cone, want]);
    }
  });

  it("finds every overlap a sampled search finds, over 600 random pairs of regions (with and without cones)", () => {
    let witnessed = 0;
    let coneWitnessed = 0;
    let checked = 0;
    for (let i = 0; i < 600; i++) {
      const s = scene(i);
      const set = new SegmentSet(s.walls);
      const r = rng(4000 + i);
      const a = visibilityPolygon(s.eye, set, s.R);
      const b = visibilityPolygon(
        { x: s.eye.x + (r() - 0.5) * 80, y: s.eye.y + (r() - 0.5) * 80 },
        set,
        5 + r() * 100,
      );
      const cone: Wedge = { dir: (r() - 0.5) * 2 * Math.PI, half: 0.1 + r() * 3 };
      const got = visOverlap(a, b);
      const gotCone = visOverlap(a, b, cone);
      if (gotCone) expect(got).toBe(true); // a cut region overlaps no more than the whole
      let w = false;
      let wc = false;
      for (let k = 0; k < 3000 && !(w && wc); k++) {
        const x = b.eye.x + (r() - 0.5) * 2 * b.radius;
        const y = b.eye.y + (r() - 0.5) * 2 * b.radius;
        if (!w && robustlyInBoth(a, b, x, y)) w = true;
        if (!wc && robustlyInBoth(a, b, x, y, cone)) wc = true;
      }
      checked++;
      if (w) {
        witnessed++;
        expect([i, got]).toEqual([i, true]);
      }
      if (wc) {
        coneWitnessed++;
        expect([i, gotCone]).toEqual([i, true]);
      }
    }
    expect(checked).toBe(600);
    expect(witnessed).toBeGreaterThan(200);
    expect(coneWitnessed).toBeGreaterThan(100);
  });

  it("visNear: a segment crossing, touching or within the margin of a region is near it; one beyond is not", () => {
    const set = new SegmentSet([seg(0, 0, 100, 0)]);
    const v = visibilityPolygon({ x: 50, y: 10 }, set, 20);
    expect(visNear(v, 40, 5, 60, 5, 1e-3)).toBe(true); // inside
    expect(visNear(v, 50, -5, 50, 5, 1e-3)).toBe(true); // crossing the wall into it
    expect(visNear(v, 40, -0.0005, 60, -0.0005, 1e-3)).toBe(true); // within the margin, beyond the wall
    expect(visNear(v, 40, -1, 60, -1, 1e-3)).toBe(false); // behind the wall
    expect(visNear(v, 90, 10, 95, 10, 1e-3)).toBe(false); // beyond the radius
  });
});
