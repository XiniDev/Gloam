import { describe, expect, it } from "vitest";
import { spawnSpots } from "./spawn.ts";

const room = { minX: 0, minY: 0, maxX: 60, maxY: 40 };
const overlap = (a: { x: number; y: number; s: number }, b: { x: number; y: number; s: number }) =>
  Math.abs(a.x - b.x) < (a.s + b.s) / 2 - 1e-6 && Math.abs(a.y - b.y) < (a.s + b.s) / 2 - 1e-6;

describe("characters placed round the party spawn (SPEC §8.3, AC-SCN-06)", () => {
  it("six characters: nearest spots first, all inside the scene, none overlapping", () => {
    const spots = spawnSpots({
      spawn: { x: 30, y: 20 },
      bounds: room,
      walls: [],
      occupied: [],
      sizes: [5, 5, 5, 5, 5, 5],
    });
    expect(spots[0]).toEqual({ x: 30, y: 20 });
    for (const [i, p] of spots.entries()) {
      expect(p.x - 2.5).toBeGreaterThanOrEqual(0);
      expect(p.y + 2.5).toBeLessThanOrEqual(40);
      expect(Math.hypot(p.x - 30, p.y - 20)).toBeLessThanOrEqual(5 * Math.SQRT2 + 1e-9);
      for (const q of spots.slice(0, i)) expect(overlap({ ...p, s: 5 }, { ...q, s: 5 })).toBe(false);
    }
  });

  it("round the tokens already there, and a large creature's whole footprint clear", () => {
    const occupied = [
      { x: 30, y: 20, size: 5 },
      { x: 35, y: 20, size: 10 },
    ];
    const spots = spawnSpots({ spawn: { x: 30, y: 20 }, bounds: room, walls: [], occupied, sizes: [5, 10] });
    for (const o of occupied)
      for (const [i, p] of spots.entries())
        expect(overlap({ ...p, s: [5, 10][i] as number }, { x: o.x, y: o.y, s: o.size })).toBe(false);
    expect(
      overlap(
        { ...(spots[0] as { x: number; y: number }), s: 5 },
        { ...(spots[1] as { x: number; y: number }), s: 10 },
      ),
    ).toBe(false);
  });

  it("never on a wall, never through one into the next room (an open door lets them through)", () => {
    // A wall 7.5 ft east of the spawn, the full height of the room.
    const wall = { a: { x: 37.5, y: 0 }, b: { x: 37.5, y: 40 }, kind: "wall" };
    const spots = spawnSpots({
      spawn: { x: 30, y: 20 },
      bounds: room,
      walls: [wall],
      occupied: [],
      sizes: Array(12).fill(5),
    });
    for (const p of spots) {
      expect(p.x + 2.5, "west of the wall").toBeLessThanOrEqual(37.5);
    }
    // A shut door blocks as a wall does; an open one doesn't.
    const door = { ...wall, kind: "door", doorState: "open" as const };
    const through = spawnSpots({
      spawn: { x: 30, y: 20 },
      bounds: room,
      walls: [door],
      occupied: [],
      sizes: Array(12).fill(5),
    });
    expect(through.some((p) => p.x > 37.5)).toBe(true);
  });
});
