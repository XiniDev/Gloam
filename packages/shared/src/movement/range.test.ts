import { describe, expect, it } from "vitest";
import type { P } from "../geometry/index.ts";
import { rangeAt, rangeField, rangeLimit } from "./range.ts";
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
