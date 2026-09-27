import { describe, expect, it } from "vitest";
import { dist, type P, pathLength, pointSegDist } from "../geometry/index.ts";
import { blocksLight, blocksMove, blocksSight, clearanceRadius } from "./blocking.ts";
import { navFor } from "./nav.ts";
import { pathCost, pointClear, relaxFrom, route, segmentClear } from "./route.ts";
import { clampToBudget, maxReachPoint, truncateAtCollision, validateMove } from "./validate.ts";
import { MoveWorld } from "./world.ts";

const W = (a: [number, number], b: [number, number]) => ({
  a: { x: a[0], y: a[1] },
  b: { x: b[0], y: b[1] },
});
const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const medium = { rc: clearanceRadius(5) }; // 2 ft

/** A deterministic PRNG (xorshift) so the randomised scenarios are the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

describe("the wall blocking matrix (AC-WAL-01)", () => {
  it("matches §8.7 for every kind and door state", () => {
    const rows: [string, string | null, boolean, boolean][] = [
      // kind, door, move, sight (light follows sight)
      ["wall", null, true, true],
      ["door", "closed", true, true],
      ["door", "locked", true, true],
      ["door", "open", false, false],
      ["window", null, true, false],
      ["curtain", null, false, true],
      ["invisible", null, true, false],
      ["secret", "closed", true, true],
      ["occluder", null, false, true],
    ];
    for (const [kind, door, move, sight] of rows) {
      expect(blocksMove(kind, door as never), `${kind}/${door} move`).toBe(move);
      expect(blocksSight(kind, door as never), `${kind}/${door} sight`).toBe(sight);
      expect(blocksLight(kind, door as never), `${kind}/${door} light`).toBe(sight);
    }
  });

  it("clearance is squeeze × space (Tiny 1, Medium 2, Large 4, Huge 6, Gargantuan 8 ft)", () => {
    expect([2.5, 5, 10, 15, 20].map((s) => clearanceRadius(s))).toEqual([1, 2, 4, 6, 8]);
  });
});

describe("routing (§16.3)", () => {
  it("goes straight when nothing is in the way", () => {
    const r = route(new MoveWorld({ walls: [], bounds }), { x: 10, y: 10 }, { x: 40, y: 50 }, [], medium);
    expect(r?.points).toHaveLength(2);
    expect(r?.cost).toBeCloseTo(50, 9);
  });

  it("goes around a wall, keeping the creature's clearance from it", () => {
    const world = new MoveWorld({ walls: [W([50, 20], [50, 80])], bounds });
    const r = route(world, { x: 30, y: 50 }, { x: 70, y: 50 }, [], medium);
    expect(r).not.toBeNull();
    const pts = r?.points as P[];
    for (let i = 1; i < pts.length; i++)
      expect(segmentClear(world, pts[i - 1] as P, pts[i] as P, 2 - 1e-6)).toBe(true);
    // Optimal detour over an end of the wall (≈ 2 × hypot(20, 32)), not wildly longer.
    const ideal = 2 * Math.hypot(20, 30 + 2);
    expect(r?.cost).toBeGreaterThan(ideal - 0.5);
    expect(r?.cost).toBeLessThan(ideal + 1.5);
  });

  it("fits a Medium creature through a 5-ft corridor but not a Large one", () => {
    // A wall with a 5-ft gap at y 47.5–52.5.
    const world = new MoveWorld({ walls: [W([50, 0], [50, 47.5]), W([50, 52.5], [50, 100])], bounds });
    const through = route(world, { x: 30, y: 50 }, { x: 70, y: 50 }, [], medium);
    expect(through?.cost).toBeCloseTo(40, 6);
    expect(route(world, { x: 30, y: 50 }, { x: 70, y: 50 }, [], { rc: clearanceRadius(10) })).toBeNull();
  });

  it("returns no path when the goal is sealed off or inside a wall's clearance", () => {
    const box = [W([60, 40], [80, 40]), W([80, 40], [80, 60]), W([80, 60], [60, 60]), W([60, 60], [60, 40])];
    const world = new MoveWorld({ walls: box, bounds });
    expect(route(world, { x: 20, y: 20 }, { x: 70, y: 50 }, [], medium)).toBeNull();
    expect(route(world, { x: 20, y: 20 }, { x: 60.5, y: 30 }, [], medium)).not.toBeNull();
    expect(route(world, { x: 20, y: 20 }, { x: 60, y: 39 }, [], medium)).toBeNull();
  });

  it("goes through waypoints in order and the total includes every leg (AC-MOV-17)", () => {
    const world = new MoveWorld({ walls: [], bounds });
    const r = route(
      world,
      { x: 10, y: 10 },
      { x: 10, y: 90 },
      [
        { x: 50, y: 10 },
        { x: 50, y: 90 },
      ],
      medium,
    );
    expect(r?.points).toEqual([
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 90 },
      { x: 10, y: 90 },
    ]);
    expect(r?.cost).toBeCloseTo(40 + 80 + 40, 9);
  });

  it("bends through a 4.5-ft doorway for a Medium creature (both sides of the door need a turn)", () => {
    // A wall across the room with a 4.5-ft door, and the start and goal off to opposite sides of it.
    const world = new MoveWorld({ walls: [W([0, 50], [47.75, 50]), W([52.25, 50], [100, 50])], bounds });
    const r = route(world, { x: 20, y: 30 }, { x: 80, y: 70 }, [], medium);
    expect(r).not.toBeNull();
    const pts = r?.points as P[];
    // It really goes through the door, and never closer than the clearance to its jambs.
    expect(pts.some((p) => Math.abs(p.x - 50) < 2.25 && Math.abs(p.y - 50) < 5)).toBe(true);
    for (let i = 1; i < pts.length; i++)
      expect(segmentClear(world, pts[i - 1] as P, pts[i] as P, 2 - 1e-6)).toBe(true);
    expect(r?.cost).toBeLessThan(Math.hypot(60, 40) + 3);
  });

  it("a creature placed too close to a wall can still step away or along it, never through it, and the server agrees", () => {
    // Dropped 1 ft from a long wall (Medium clearance is 2 ft).
    const world = new MoveWorld({ walls: [W([10, 50], [90, 50])], bounds });
    const start = { x: 50, y: 49 };
    const away = route(world, start, { x: 50, y: 30 }, [], medium);
    expect(away?.cost).toBeCloseTo(19, 6);
    // To the far side it must go round an end, not through.
    const across = route(world, start, { x: 50, y: 70 }, [], medium);
    expect(across).not.toBeNull();
    expect(across?.cost).toBeGreaterThan(2 * Math.hypot(40, 20) - 1);
    for (const r of [away, across]) {
      const server = validateMove(world, r?.points as P[], medium, null);
      if ("error" in server) throw new Error("no budget");
      expect(server.bumped).toBe(false);
    }
    // Straight through the wall: the server stops it before it gets any closer (within its 0.01-ft graze tolerance).
    const cut = truncateAtCollision(world, [start, { x: 50, y: 70 }], medium);
    expect(cut.bumped).toBe(true);
    expect((cut.points[cut.points.length - 1] as P).y).toBeCloseTo(49.01, 6);
  });

  it("proves a sealed-off goal unreachable at once, without searching the whole scene", () => {
    // A 300 x 300 scene of about 500 walls and, in its middle, a sealed room.
    const r = rng(7);
    const big = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
    const walls = Array.from({ length: 496 }, () => {
      const x = r() * 300;
      const y = r() * 300;
      return r() < 0.5 ? W([x, y], [x + 6 + r() * 10, y]) : W([x, y], [x, y + 6 + r() * 10]);
    }).filter(
      (w) => Math.max(w.a.x, w.b.x) < 130 || Math.min(w.a.x, w.b.x) > 170 || w.a.y > 170 || w.b.y < 130,
    );
    walls.push(
      W([140, 140], [160, 140]),
      W([160, 140], [160, 160]),
      W([160, 160], [140, 160]),
      W([140, 160], [140, 140]),
    );
    const world = new MoveWorld({ walls, bounds: big });
    route(world, { x: 20, y: 20 }, { x: 22, y: 20 }, [], medium); // builds the search structures
    const t0 = Date.now();
    for (let i = 0; i < 20; i++)
      expect(route(world, { x: 10 + i, y: 250 }, { x: 150, y: 150 }, [], medium)).toBeNull();
    expect((Date.now() - t0) / 20).toBeLessThan(2);
  });

  it("with a movement budget, only searches within budget + 10 ft of the start (section 16.3)", () => {
    // The only way round is 80 ft north: a 30-ft budget cannot find it, an unlimited search does.
    const world = new MoveWorld({ walls: [W([50, 0], [50, 90])], bounds });
    const from = { x: 45, y: 10 };
    const to = { x: 55, y: 10 };
    expect(route(world, from, to, [], { ...medium, budgetFt: 30 })).toBeNull();
    expect(route(world, from, to, [], medium)?.cost).toBeGreaterThan(160);
  });

  it("finds the cheapest route of the whole visibility graph (brute force over every node, 120 random scenes)", () => {
    let compared = 0;
    for (let n = 0; n < 120; n++) {
      const r = rng(5000 + n);
      const walls = Array.from({ length: 6 + Math.floor(r() * 24) }, () => {
        const x = 5 + r() * 90;
        const y = 5 + r() * 90;
        const ang = r() * Math.PI;
        const len = 5 + r() * 30;
        return W([x, y], [x + Math.cos(ang) * len, y + Math.sin(ang) * len]);
      });
      const regions = Array.from({ length: Math.floor(r() * 3) }, () => {
        const x = r() * 80;
        const y = r() * 80;
        const s = 5 + r() * 20;
        return {
          poly: [
            { x, y },
            { x: x + s, y },
            { x: x + s, y: y + s },
            { x, y: y + s },
          ],
        };
      });
      const rc = [1, 2, 4][Math.floor(r() * 3)] as number;
      const world = new MoveWorld({ walls, regions, bounds });
      const start = { x: 5 + r() * 90, y: 5 + r() * 90 };
      const goal = { x: 5 + r() * 90, y: 5 + r() * 90 };
      const fast = route(world, start, goal, [], { rc });
      const brute = bruteForce(world, start, goal, rc);
      expect(fast === null, `scene ${n}`).toBe(brute === null);
      if (!fast || brute === null) continue;
      compared++;
      expect(fast.cost, `scene ${n}`).toBeCloseTo(brute, 6);
    }
    expect(compared).toBeGreaterThan(60);
  });

  it("walks around solid creatures (circles)", () => {
    const world = new MoveWorld({ walls: [], solids: [{ c: { x: 50, y: 50 }, r: 2.5 }], bounds });
    const r = route(world, { x: 30, y: 50 }, { x: 70, y: 50 }, [], medium);
    expect(r?.points.length).toBeGreaterThan(2);
    for (const p of r?.points ?? []) expect(dist(p, { x: 50, y: 50 })).toBeGreaterThanOrEqual(4.5 - 1e-6);
  });
});

describe("cost (§16.4, AC-MOV-03)", () => {
  const swamp = {
    poly: [
      { x: 40, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 100 },
      { x: 40, y: 100 },
    ],
  };

  it("difficult terrain doubles the part of the path inside it, and never stacks", () => {
    const world = new MoveWorld({ walls: [], regions: [swamp, swamp], bounds });
    const c = pathCost(
      world,
      [
        { x: 20, y: 50 },
        { x: 80, y: 50 },
      ],
      {},
    );
    expect(c.difficultFt).toBeCloseTo(20, 9);
    expect(c.cost).toBeCloseTo(40 + 2 * 20, 9);
  });

  it("crawling adds 1 everywhere: 2 on open ground, 3 through difficult terrain", () => {
    const world = new MoveWorld({ walls: [], regions: [swamp], bounds });
    expect(
      pathCost(
        world,
        [
          { x: 20, y: 50 },
          { x: 80, y: 50 },
        ],
        { crawl: true },
      ).cost,
    ).toBeCloseTo(40 * 2 + 20 * 3, 9);
  });

  it("the route prefers going around difficult terrain when that's cheaper", () => {
    const pond = {
      poly: [
        { x: 45, y: 45 },
        { x: 55, y: 45 },
        { x: 55, y: 55 },
        { x: 45, y: 55 },
      ],
    };
    const world = new MoveWorld({ walls: [], regions: [pond], bounds });
    const r = route(world, { x: 30, y: 50 }, { x: 70, y: 50 }, [], medium);
    expect(r?.difficultFt).toBeCloseTo(0, 6);
    expect(r?.cost).toBeLessThan(40 + 10);
  });
});

describe("server validation (§16.5, AC-MOV-08)", () => {
  it("truncates a path through a wall at the point where the creature touches it", () => {
    const world = new MoveWorld({ walls: [W([50, 0], [50, 100])], bounds });
    const cut = truncateAtCollision(
      world,
      [
        { x: 30, y: 50 },
        { x: 70, y: 50 },
      ],
      medium,
    );
    expect(cut.bumped).toBe(true);
    expect(cut.hitWall).toBe(0);
    const end = cut.points[cut.points.length - 1] as P;
    expect(end.x).toBeCloseTo(48, 1);
    expect(pointSegDist(end, { x: 50, y: 0 }, { x: 50, y: 100 })).toBeGreaterThan(1.9);
  });

  it("clamps an overlong move at the max-reach point by default, or rejects it", () => {
    const world = new MoveWorld({ walls: [], bounds });
    const path = [
      { x: 10, y: 50 },
      { x: 70, y: 50 },
    ];
    const v = validateMove(world, path, medium, 30, "clamp");
    expect("error" in v).toBe(false);
    if (!("error" in v)) {
      expect(v.clamped).toBe(true);
      expect(v.cost).toBeCloseTo(30, 3);
      expect((v.points[v.points.length - 1] as P).x).toBeCloseTo(40, 3);
    }
    expect(validateMove(world, path, medium, 30, "reject")).toMatchObject({ error: "OVER_BUDGET" });
    expect(maxReachPoint(world, path, medium, 30)?.x).toBeCloseTo(40, 3);
    expect(maxReachPoint(world, path, medium, 90)).toBeNull();
  });

  it("clamping through difficult terrain stops where the cost, not the length, runs out", () => {
    const swamp = {
      poly: [
        { x: 20, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 20, y: 100 },
      ],
    };
    const world = new MoveWorld({ walls: [], regions: [swamp], bounds });
    const cut = clampToBudget(
      world,
      [
        { x: 10, y: 50 },
        { x: 90, y: 50 },
      ],
      {},
      30,
    );
    // 10 ft of open ground, then 20 ft of budget buys 10 ft of swamp.
    expect((cut[cut.length - 1] as P).x).toBeCloseTo(30, 3);
  });

  it("a 30.00001-ft move still fits a 30-ft budget (ε = 0.05 ft)", () => {
    const world = new MoveWorld({ walls: [], bounds });
    const v = validateMove(
      world,
      [
        { x: 10, y: 50 },
        { x: 40.00001, y: 50 },
      ],
      medium,
      30,
    );
    expect("error" in v ? v : v.clamped).toBe(false);
  });
});

describe("client preview = server authority (AC-MOV-02)", () => {
  it("costs agree within 0.05 ft over 200 randomised scenes, and valid previews are never truncated", () => {
    let compared = 0;
    for (let n = 0; n < 200; n++) {
      const r = rng(1000 + n);
      const walls = Array.from({ length: 6 + Math.floor(r() * 30) }, () => {
        const x = 5 + r() * 90;
        const y = 5 + r() * 90;
        const ang = r() * Math.PI;
        const len = 5 + r() * 30;
        return W([x, y], [x + Math.cos(ang) * len, y + Math.sin(ang) * len]);
      });
      const regions = Array.from({ length: Math.floor(r() * 4) }, () => {
        const x = r() * 80;
        const y = r() * 80;
        const s = 5 + r() * 20;
        return {
          poly: [
            { x, y },
            { x: x + s, y },
            { x: x + s, y: y + s },
            { x, y: y + s },
          ],
        };
      });
      const rc = [1, 2, 4][Math.floor(r() * 3)] as number;
      const world = new MoveWorld({ walls, regions, bounds });
      const start = { x: 5 + r() * 90, y: 5 + r() * 90 };
      const goal = { x: 5 + r() * 90, y: 5 + r() * 90 };
      const crawl = r() < 0.2;
      const preview = route(world, start, goal, [], { rc, crawl });
      if (!preview) continue;
      compared++;
      // The server, same obstacles (the player knew every wall), same path.
      const server = validateMove(world, preview.points, { rc, crawl }, null);
      if ("error" in server) throw new Error("no budget, no error expected");
      expect(server.bumped, `scene ${n}`).toBe(false);
      expect(Math.abs(server.cost - preview.cost), `scene ${n}`).toBeLessThanOrEqual(0.05);
      expect(pathLength(server.points)).toBeCloseTo(pathLength(preview.points), 6);
    }
    expect(compared).toBeGreaterThan(100);
  });
});

/** Dijkstra over the full visibility graph (every node, every clear edge, no pruning): the optimum to match. */
function bruteForce(world: MoveWorld, start: P, goal: P, rc: number): number | null {
  if (!pointClear(world, goal, rc)) return null;
  const nav = navFor(world, rc);
  const relax = pointClear(world, start, rc) ? undefined : relaxFrom(world, start, rc);
  const pts: P[] = [start, goal];
  for (let i = 0; i < nav.n; i++) pts.push({ x: nav.x[i] as number, y: nav.y[i] as number });
  const g = new Float64Array(pts.length).fill(Number.POSITIVE_INFINITY);
  const done = new Uint8Array(pts.length);
  g[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < pts.length; i++)
      if (!done[i] && (u < 0 || (g[i] as number) < (g[u] as number))) u = i;
    if (u < 0 || !Number.isFinite(g[u] as number) || u === 1) break;
    done[u] = 1;
    for (let v = 0; v < pts.length; v++) {
      if (done[v] || (g[u] as number) + dist(pts[u] as P, pts[v] as P) >= (g[v] as number)) continue;
      if (!segmentClear(world, pts[u] as P, pts[v] as P, rc, u === 0 ? relax : undefined)) continue;
      g[v] = Math.min(
        g[v] as number,
        (g[u] as number) + pathCost(world, [pts[u] as P, pts[v] as P], {}).cost,
      );
    }
  }
  return Number.isFinite(g[1] as number) ? (g[1] as number) : null;
}

describe("performance (§16.3)", () => {
  it("routes across a 500-wall scene well within the 4 ms preview budget, once the scene's search structures exist", () => {
    const r = rng(42);
    const big = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
    const walls = Array.from({ length: 500 }, () => {
      const x = r() * 300;
      const y = r() * 300;
      return r() < 0.5 ? W([x, y], [x + 6 + r() * 10, y]) : W([x, y], [x, y + 6 + r() * 10]);
    });
    const world = new MoveWorld({ walls, bounds: big });
    // Typical previews: across ~40 ft of the room around the token. The first query builds the scene's nodes and
    // connectivity (once per scene version and creature size; the client does it ahead of a drag).
    const queries = Array.from({ length: 200 }, () => {
      const s = { x: 20 + r() * 260, y: 20 + r() * 260 };
      return [s, { x: s.x + (r() - 0.5) * 60, y: s.y + (r() - 0.5) * 60 }] as const;
    });
    route(world, { x: 150, y: 150 }, { x: 151, y: 150 }, [], medium);
    let found = 0;
    const t0 = Date.now();
    for (const [s, g] of queries) if (route(world, s, g, [], medium)) found++;
    const each = (Date.now() - t0) / queries.length;
    expect(found).toBeGreaterThan(80);
    // The spec's budget is 4 ms per query on a mid-range laptop (this machine: about 0.3 ms); CI machines vary.
    expect(each).toBeLessThan(4);
  });
});
