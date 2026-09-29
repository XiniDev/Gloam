import { describe, expect, it } from "vitest";
import { aimFrame, aimReach } from "./aimFrame.ts";

const scene = { minX: 0, minY: 0, maxX: 120, maxY: 80 };
const tok = (id: string, x: number, y: number, sizeFt = 5) => ({ id, pos: { x, y }, sizeFt });

describe("a phone frames what a spell can reach (critic P9 r1 #18)", () => {
  it("frames the caster and the creatures within reach, not the whole scene", () => {
    const f = aimFrame("mira", 30, [tok("mira", 20, 20), tok("g1", 40, 25), tok("far", 110, 70)], scene);
    // (Its 22.5-ft height grown to the 30-ft least about its middle.)
    expect(f).toEqual({ minX: 10, maxX: 47.5, minY: 6.25, maxY: 36.25 });
  });
  it("keeps at least 30 ft across, inside the scene", () => {
    const f = aimFrame("mira", 5, [tok("mira", 2, 40)], scene);
    // At the scene's edge: slid in, still 30 ft across.
    expect(f?.minX).toBe(0);
    expect(f?.maxX).toBe(30);
    expect((f?.maxY ?? 0) - (f?.minY ?? 0)).toBe(30);
    // A scene smaller than that: all of it.
    expect(aimFrame("mira", 5, [tok("mira", 10, 10)], { minX: 0, minY: 0, maxX: 20, maxY: 20 })).toEqual({
      minX: 0,
      maxX: 20,
      minY: 0,
      maxY: 20,
    });
    expect(aimFrame("nobody", 30, [tok("mira", 2, 40)], scene)).toBeNull();
  });
  it("reaches as far as the spell's range, a touch, or its own area", () => {
    expect(aimReach({ range: { kind: "ranged", ft: 120 } } as never)).toBe(120);
    expect(aimReach({ range: { kind: "touch" } } as never)).toBe(5);
    expect(aimReach({ range: { kind: "self" }, area: { shape: "cone", length: 15 } } as never)).toBe(15);
  });
});
