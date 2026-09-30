import { describe, expect, it } from "vitest";
import type { P } from "../geometry/index.ts";
import { rangeAt, rangeDisplay, rangeField, rangeLimit } from "./range.ts";
import { MoveWorld } from "./world.ts";

const bounds = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
const o = { x: 0, y: 0 };
const RC = 2;

/** The worst gap between the field's limit line and the true limit, over every limit point (ft). */
function worst(points: P[], trueCost: (p: P) => number, budget: number): number {
  let w = 0;
  for (const p of points) w = Math.max(w, Math.abs(trueCost(p) - budget));
  return w;
}

describe("movement range field (§16.6, AC-MOV-10: the limit within 1 ft of the true geodesic limit)", () => {
  it("open ground: a circle of the budget's radius (0.5-ft cells to 30 ft, 1-ft beyond)", () => {
    const world = new MoveWorld({ walls: [], bounds });
    for (const budget of [30, 60]) {
      const f = rangeField(world, o, { rc: RC, budget });
      const pts = rangeLimit(f);
      expect(pts.length).toBeGreaterThan(100);
      expect(worst(pts, (p) => Math.hypot(p.x, p.y), budget)).toBeLessThan(1);
      expect(rangeAt(f, { x: budget / 2, y: 0 })).toBeCloseTo(budget / 2, 0);
    }
  });

  it("around a wall's end: the geodesic wraps the clearance circle at the corner", () => {
    // A wall along x = 10 from far below up to y = 5: behind it, only round its top end.
    const C = { x: 10, y: 5 };
    const world = new MoveWorld({ walls: [{ a: { x: 10, y: -90 }, b: C }], bounds });
    const budget = 40;
    const f = rangeField(world, o, { rc: RC, budget });
    const visible = (p: P) => {
      // The straight line keeps clear of the wall (distance ≥ rc from segment C–(10, −90)).
      const steps = 200;
      for (let i = 0; i <= steps; i++) {
        const q = { x: (p.x * i) / steps, y: (p.y * i) / steps };
        const dy = q.y > C.y ? q.y - C.y : q.y < -90 ? q.y + 90 : 0;
        if (Math.hypot(q.x - 10, dy) < RC - 1e-6) return false;
      }
      return true;
    };
    const around = (p: P) => {
      const d = (a: P) => Math.hypot(a.x - C.x, a.y - C.y);
      const dO = d(o);
      const dP = d(p);
      const tO = Math.sqrt(dO * dO - RC * RC);
      const tP = Math.sqrt(dP * dP - RC * RC);
      // The wrap goes round the side away from the wall (which runs straight down from C): of the two arcs between
      // the directions to o and to p, the one that doesn't pass through "down".
      const ang = (a: P) => {
        const v = Math.atan2(a.y - C.y, a.x - C.x);
        return v < 0 ? v + 2 * Math.PI : v;
      };
      const a1 = ang(o);
      const a2 = ang(p);
      const down = (3 * Math.PI) / 2;
      const lo = Math.min(a1, a2);
      const hi = Math.max(a1, a2);
      const theta = down > lo && down < hi ? 2 * Math.PI - (hi - lo) : hi - lo;
      const arc = Math.max(0, theta - Math.acos(RC / dO) - Math.acos(RC / dP));
      return tO + tP + RC * arc;
    };
    const truth = (p: P) => (visible(p) ? Math.hypot(p.x, p.y) : around(p));
    const behind = rangeLimit(f).filter((p) => p.x > 10 + RC + 0.5 && p.y < C.y);
    expect(behind.length).toBeGreaterThan(10);
    expect(worst(rangeLimit(f), truth, budget)).toBeLessThan(1);
  });

  it("as drawn (rangeDisplay): the limit within 1 ft, no rougher than the field along the seam where the straight front meets the one round a wall's end, and the cost carried on past the reachable ground (no false limit at its edge)", () => {
    const C = { x: 10, y: 5 };
    const world = new MoveWorld({ walls: [{ a: { x: 10, y: -90 }, b: C }], bounds });
    const budget = 30;
    const f = rangeField(world, o, { rc: RC, budget });
    const d = rangeDisplay(world, f, RC);
    const cell = (p: P) => Math.floor((p.y - f.y0) / f.h) * f.cols + Math.floor((p.x - f.x0) / f.h);
    // The drawn limit: where the drawn cost crosses the budget on ground a creature's centre can reach (the band the
    // display paints flush to the wall's face has no geodesic to compare with).
    const drawn = rangeLimit({ ...f, cost: d.cost }).filter(
      (p) => (d.reach[cell(p)] as number) > 0.5 && Number.isFinite(f.cost[cell(p)] as number),
    );
    const raw = rangeLimit(f);
    // Truth: straight where the creature sees past the wall's clearance, else round its end (tangent, arc, tangent).
    const truth = (p: P) => {
      const steps = 200;
      let clear = true;
      for (let i = 0; i <= steps && clear; i++) {
        const q = { x: (p.x * i) / steps, y: (p.y * i) / steps };
        const dy = q.y > C.y ? q.y - C.y : q.y < -90 ? q.y + 90 : 0;
        if (Math.hypot(q.x - 10, dy) < RC - 1e-6) clear = false;
      }
      if (clear) return Math.hypot(p.x, p.y);
      const dO = Math.hypot(C.x, C.y);
      const dP = Math.hypot(p.x - C.x, p.y - C.y);
      const ang = (a: P) => {
        const v = Math.atan2(a.y - C.y, a.x - C.x);
        return v < 0 ? v + 2 * Math.PI : v;
      };
      const a1 = ang(o);
      const a2 = ang(p);
      const down = (3 * Math.PI) / 2;
      const lo = Math.min(a1, a2);
      const hi = Math.max(a1, a2);
      const theta = down > lo && down < hi ? 2 * Math.PI - (hi - lo) : hi - lo;
      const arc = Math.max(0, theta - Math.acos(RC / dO) - Math.acos(RC / dP));
      return Math.sqrt(dO * dO - RC * RC) + Math.sqrt(dP * dP - RC * RC) + RC * arc;
    };
    expect(drawn.length).toBeGreaterThan(100);
    expect(worst(drawn, truth, budget)).toBeLessThan(1);
    // The seam: the shadow line from the creature past the corner's clearance circle, out to the limit.
    const along = { x: C.x / Math.hypot(C.x, C.y), y: C.y / Math.hypot(C.x, C.y) };
    const nearSeam = (p: P) =>
      Math.abs(p.x * along.y - p.y * along.x) < 4 && p.x * along.x + p.y * along.y > 12;
    const rms = (pts: P[]) =>
      Math.sqrt(pts.reduce((sum, p) => sum + (truth(p) - budget) ** 2, 0) / Math.max(1, pts.length));
    const seamDrawn = drawn.filter(nearSeam);
    expect(seamDrawn.length).toBeGreaterThan(3);
    expect(rms(seamDrawn)).toBeLessThanOrEqual(rms(raw.filter(nearSeam)) + 0.02);
    // Every cell beside reachable ground carries a cost on (the texture never climbs to "unreachable" there).
    for (let r = 1; r < f.rows - 1; r++)
      for (let c = 1; c < f.cols - 1; c++) {
        const k = r * f.cols + c;
        if (Number.isFinite(f.cost[k] as number)) continue;
        let beside = false;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++)
            if (Number.isFinite(f.cost[(r + dr) * f.cols + c + dc] as number)) beside = true;
        if (beside) expect(Number.isFinite(d.cost[k] as number)).toBe(true);
      }
  });

  it("into ground that halves Speed (Spirit Guardians): reached there only while what it has spent is within half its budget (rules audit Q1)", () => {
    // A ring round (20, 0), 10 ft across its middle from x 10 to 30.
    const world = new MoveWorld({
      walls: [],
      bounds,
      regions: [{ circle: { c: { x: 20, y: 0 }, r: 10 }, kind: "halved" }],
    });
    const f = rangeField(world, o, { rc: RC, budget: 30, halvedBudget: 15 });
    // Outside the ring, as far as 30 ft; inside, only where it has spent 15 or less (x ≤ 15) — its limit line there.
    expect(rangeAt(f, { x: 0, y: 25 })).toBeLessThan(30);
    expect(rangeAt(f, { x: 13, y: 0 })).toBeLessThan(30);
    expect(rangeAt(f, { x: 18, y: 0 })).toBeGreaterThan(30);
    // Past the ring, straight on, it's out of reach (it would have to cross where it can't be).
    expect(rangeAt(f, { x: 32, y: 0 }) > 30 || !Number.isFinite(rangeAt(f, { x: 32, y: 0 }))).toBe(true);
    // The limit inside the ring falls within a foot of x = 15.
    const inside = rangeLimit(f).filter((p) => Math.hypot(p.x - 20, p.y) < 9 && Math.abs(p.y) < 3);
    expect(inside.length).toBeGreaterThan(0);
    for (const p of inside) expect(Math.abs(p.x - 15)).toBeLessThan(1);
  });

  it("into difficult terrain: twice the cost there, the cheapest path bending where it enters", () => {
    const world = new MoveWorld({
      walls: [],
      bounds,
      regions: [
        {
          poly: [
            { x: 10, y: -100 },
            { x: 100, y: -100 },
            { x: 100, y: 100 },
            { x: 10, y: 100 },
          ],
          kind: "difficult",
        },
      ],
    });
    const budget = 30;
    const f = rangeField(world, o, { rc: RC, budget });
    // A point in the difficult ground: the cheapest crossing of x = 10 (golden-section search over its y).
    const truth = (p: P) => {
      if (p.x <= 10) return Math.hypot(p.x, p.y);
      const cost = (y: number) => Math.hypot(10, y) + 2 * Math.hypot(p.x - 10, p.y - y);
      let lo = Math.min(0, p.y) - 1;
      let hi = Math.max(0, p.y) + 1;
      for (let i = 0; i < 80; i++) {
        const a = lo + (hi - lo) / 3;
        const b = hi - (hi - lo) / 3;
        if (cost(a) < cost(b)) hi = b;
        else lo = a;
      }
      return cost((lo + hi) / 2);
    };
    const inside = rangeLimit(f).filter((p) => p.x > 10.5);
    expect(inside.length).toBeGreaterThan(10);
    // The limit inside the difficult ground reaches x = 10 + 20 / 2 = 20 straight ahead.
    expect(Math.max(...inside.map((p) => p.x))).toBeCloseTo(20, 0);
    expect(worst(rangeLimit(f), truth, budget)).toBeLessThan(1);
  });

  it("fast enough for a 60-ft budget among a few hundred walls (§16.6: well within a frame budget in a worker)", () => {
    const walls = Array.from({ length: 300 }, (_, i) => {
      const x = -90 + (i % 30) * 6;
      const y = -90 + Math.floor(i / 30) * 18;
      return { a: { x, y }, b: { x: x + 3, y: y + 2 } };
    });
    const world = new MoveWorld({ walls, bounds });
    const t0 = Date.now();
    rangeField(world, { x: 1, y: 1 }, { rc: RC, budget: 60 });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(400);
  });
});
