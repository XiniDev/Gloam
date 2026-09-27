import { describe, expect, it } from "vitest";
import { EASE_MS, moveAnimAt, startMoveAnim, travelled } from "./anims.ts";

describe("committed-move animation (SPEC §16.7)", () => {
  it("covers the whole path in the given time, easing in and out over the first and last 120 ms", () => {
    const L = 30;
    const D = 1000; // 30 ft at 30 ft/s
    expect(travelled(L, D, 0)).toBe(0);
    expect(travelled(L, D, D)).toBe(L);
    // Monotonic, continuous at the ramp joins, and symmetric.
    let prev = 0;
    for (let t = 1; t <= D; t++) {
      const s = travelled(L, D, t);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(s - prev).toBeLessThan(0.05);
      prev = s;
    }
    for (const t of [30, 120, 500, 700])
      expect(travelled(L, D, t) + travelled(L, D, D - t)).toBeCloseTo(L, 9);
    // Cruising speed in the middle; slower than it during the ramps.
    const v = L / (D - EASE_MS);
    expect(travelled(L, D, 501) - travelled(L, D, 500)).toBeCloseTo(v, 9);
    expect(travelled(L, D, 11) - travelled(L, D, 10)).toBeLessThan(v / 5);
    // Short moves (under 240 ms) still end exactly on time.
    expect(travelled(2, 250, 250)).toBe(2);
    expect(travelled(2, 250, 125)).toBeCloseTo(1, 9);
  });

  it("follows the path's corners, faces the way it goes, and steps every 5 ft", () => {
    // East 10 ft, then south 10 ft, over 1 s.
    startMoveAnim(
      "t1",
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      1000,
      0,
    );
    const mid = moveAnimAt("t1", 500) as NonNullable<ReturnType<typeof moveAnimAt>>;
    expect(mid.pos.x).toBeCloseTo(10, 6);
    expect(mid.pos.y).toBeCloseTo(0, 6);
    const later = moveAnimAt("t1", 800) as NonNullable<ReturnType<typeof moveAnimAt>>;
    expect(later.pos.x).toBeCloseTo(10, 9);
    expect(later.pos.y).toBeGreaterThan(0);
    // Heading south (+y): atan2(0, 1) = 0; east was π/2.
    expect(later.heading).toBeCloseTo(0, 9);
    let steps = 0;
    startMoveAnim(
      "t2",
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      1000,
      0,
    );
    for (let t = 0; t < 1000; t += 16) if (moveAnimAt("t2", t)?.step) steps++;
    expect(steps).toBe(3); // at 5, 10 and 15 ft (the 20th foot is the end)
    expect(moveAnimAt("t2", 1000)).toBeNull();
  });
});
