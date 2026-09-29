import { describe, expect, it } from "vitest";
import {
  affected,
  CONE_HALF_ANGLE,
  canPlace,
  contains,
  coverHint,
  footprint,
  overlaps,
  scaledDimension,
  verticalExtent,
} from "./index.ts";

const wall = (ax: number, ay: number, bx: number, by: number, sight = true) => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  blocksMove: true,
  blocksSight: sight,
});
/** Facing east (+x): a facing of 0° looks south (+y). */
const EAST = -90;
const creature = (id: string, x: number, y: number, r = 2.5, z = 0, height = 5) => ({
  id,
  pos: { x, y },
  r,
  z,
  height,
});

describe("areas of effect (§17)", () => {
  it("footprints: a cone widens as it goes (its width at x is x), a line and a cube are rectangles from their origin", () => {
    expect(Math.tan(CONE_HALF_ANGLE)).toBeCloseTo(0.5, 12);
    const cone = footprint({ kind: "cone", origin: { x: 0, y: 0 }, dirDeg: EAST, length: 15 });
    expect(cone.kind).toBe("poly");
    const pts = (cone as { points: { x: number; y: number }[] }).points;
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]?.x).toBeCloseTo(15, 9);
    expect(pts[1]?.y).toBeCloseTo(7.5, 9);
    expect(pts[2]?.y).toBeCloseTo(-7.5, 9);
    const line = footprint({ kind: "line", origin: { x: 0, y: 0 }, dirDeg: 0, length: 100, width: 5 });
    expect(contains(line, { x: 0, y: 99 })).toBe(true);
    expect(contains(line, { x: 3, y: 50 })).toBe(false);
    // A cube from its face (Thunderwave): the caster's edge the middle of its near face; placed at range, centred.
    const face = footprint({
      kind: "cube",
      origin: { x: 0, y: 0 },
      dirDeg: EAST,
      size: 15,
      originOnFace: true,
    });
    expect(contains(face, { x: 14, y: 7 })).toBe(true);
    expect(contains(face, { x: -1, y: 0 })).toBe(false);
    const centred = footprint({
      kind: "cube",
      origin: { x: 0, y: 0 },
      dirDeg: EAST,
      size: 10,
      originOnFace: false,
    });
    expect(contains(centred, { x: -4.9, y: 4.9 })).toBe(true);
    // An emanation reaches its distance past the source's base.
    expect(footprint({ kind: "emanation", source: { x: 0, y: 0 }, sourceRadius: 2.5, distance: 15 })).toEqual(
      {
        kind: "circle",
        c: { x: 0, y: 0 },
        r: 17.5,
      },
    );
  });

  it("who's affected: any overlap by default, the centre inside by house rule; the height it reaches", () => {
    const fireball = { kind: "sphere" as const, origin: { x: 0, y: 0 }, radius: 20 };
    const edge = creature("edge", 22, 0);
    const high = creature("high", 5, 0, 2.5, 30);
    expect(affected(fireball, [edge, high], [])).toEqual([
      { id: "edge", affected: true },
      { id: "high", affected: false, blocked: false },
    ]);
    expect(affected(fireball, [edge], [], { coverage: "centre" })[0]?.affected).toBe(false);
    // A cone's height grows with its width: 20 ft out, one flying 8 ft up is inside; 12 ft up isn't.
    const cone = { kind: "cone" as const, origin: { x: 0, y: 0 }, dirDeg: EAST, length: 30 };
    expect(verticalExtent(cone, { x: 20, y: 0 })).toEqual([-10, 10]);
    expect(affected(cone, [creature("low", 20, 0, 2.5, 8, 5)], [])[0]?.affected).toBe(true);
    expect(affected(cone, [creature("up", 20, 0, 2.5, 12, 5)], [])[0]?.affected).toBe(false);
    // A sphere is round (rules audit m4): a flier 18 ft out and 15 ft up is 18−2.5 = 15.5 out, 15 up — 21.6 ft from
    // the centre, outside a 20-ft Fireball (a box would have caught it); 10 ft up, 18.4 ft away, inside.
    expect(affected(fireball, [creature("corner", 18, 0, 2.5, 15, 5)], [])[0]?.affected).toBe(false);
    expect(affected(fireball, [creature("lower", 18, 0, 2.5, 10, 5)], [])[0]?.affected).toBe(true);
    // An emanation from a creature's space: its distance every way — up from its head too.
    const guardians = {
      kind: "emanation" as const,
      source: { x: 0, y: 0 },
      sourceRadius: 2.5,
      z: 0,
      sourceHeight: 5,
      distance: 15,
    };
    expect(affected(guardians, [creature("above", 0, 0, 2.5, 19, 5)], [])[0]?.affected).toBe(true);
    expect(affected(guardians, [creature("diag", 16, 0, 2.5, 18, 5)], [])[0]?.affected).toBe(false);
  });

  it("line of effect: a wall giving total cover between the origin and every sample point leaves a creature out, marked blocked; one sample in the open is enough", () => {
    const blast = { kind: "sphere" as const, origin: { x: 0, y: 0 }, radius: 20 };
    const behind = creature("behind", 12, 0);
    // A long wall between: every line crosses it.
    expect(affected(blast, [behind], [wall(8, -10, 8, 10)])).toEqual([
      { id: "behind", affected: false, blocked: true },
    ]);
    // A short one covering only the centre and one side: the other side's points are in the open.
    expect(affected(blast, [behind], [wall(8, -3, 8, 0.5)])[0]?.affected).toBe(true);
    // A curtain (it blocks sight, not movement) doesn’t stop an area; glass does (a window blocks movement).
    expect(affected(blast, [behind], [{ ...wall(8, -10, 8, 10), blocksMove: false }])[0]?.affected).toBe(
      true,
    );
  });

  it("the creature an area comes from is left out unless asked (Include myself)", () => {
    const guardians = { kind: "emanation" as const, source: { x: 0, y: 0 }, sourceRadius: 2.5, distance: 15 };
    const cleric = creature("cleric", 0, 0);
    const orc = creature("orc", 10, 0);
    expect(affected(guardians, [cleric, orc], [], { sourceId: "cleric" }).map((x) => x.affected)).toEqual([
      false,
      true,
    ]);
    expect(affected(guardians, [cleric], [], { sourceId: "cleric", includeSource: true })[0]?.affected).toBe(
      true,
    );
  });

  it("placing an origin: range from the caster's base edge, Touch its reach, and a line of effect to it", () => {
    const caster = { pos: { x: 0, y: 0 }, r: 2.5 };
    expect(canPlace(caster, { x: 152, y: 0 }, { kind: "ft", ft: 150 }, [])).toEqual({ ok: true });
    expect(canPlace(caster, { x: 153, y: 0 }, { kind: "ft", ft: 150 }, [])).toEqual({
      ok: false,
      why: "range",
    });
    expect(canPlace(caster, { x: 7, y: 0 }, { kind: "touch" }, [])).toEqual({ ok: true });
    expect(canPlace(caster, { x: 60, y: 0 }, { kind: "ft", ft: 150 }, [wall(30, -5, 30, 5)])).toEqual({
      ok: false,
      why: "line",
    });
    expect(canPlace(caster, { x: 999, y: 0 }, { kind: "self" }, [])).toEqual({ ok: true });
  });

  it("areas grow with the slot: Fog Cloud's 20-ft radius, +20 per level above 1st", () => {
    expect(scaledDimension(20, 20, 1, 1)).toBe(20);
    expect(scaledDimension(20, 20, 1, 3)).toBe(60);
    expect(scaledDimension(15, undefined, 1, 5)).toBe(15);
  });

  it("the cover hint (§17.5): five rays — none, half, three-quarters, total; a creature in the way gives half", () => {
    const from = { x: 0, y: 0 };
    const target = { pos: { x: 20, y: 0 }, r: 2.5 };
    expect(coverHint(from, target, [])).toEqual({ cover: "none", blocked: 0 });
    // A low wall covering one side of the target: the ray to that side's point only.
    expect(coverHint(from, target, [wall(15, 1, 15, 4)]).cover).toBe("half");
    // Covering the centre line and one side: the centre, near, far and that side's rays — three-quarters.
    expect(coverHint(from, target, [wall(15, -0.5, 15, 4)]).cover).toBe("threeQuarters");
    // All of it.
    expect(coverHint(from, target, [wall(15, -10, 15, 10)])).toEqual({ cover: "total", blocked: 5 });
    // Another creature's base across the centre ray.
    expect(coverHint(from, target, [], [{ pos: { x: 10, y: 0.5 }, r: 2.5 }]).cover).toBe("half");
    // Overlap stays consistent with footprints.
    expect(overlaps(footprint({ kind: "sphere", origin: from, radius: 5 }), { x: 7.4, y: 0 }, 2.5)).toBe(
      true,
    );
  });
});
