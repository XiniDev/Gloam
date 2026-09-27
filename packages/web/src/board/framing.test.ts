import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { frameBounds, type ScreenRect } from "./framing.ts";

/** Where the framed camera puts the map's corners on screen. */
function cornersOnScreen(
  f: ReturnType<typeof frameBounds>,
  W: number,
  H: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
) {
  const cam = new PerspectiveCamera(40, W / H, 0.5, 4000);
  cam.position.set(...f.position);
  cam.lookAt(...f.target);
  cam.updateMatrixWorld();
  return [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.minX, bounds.maxY],
    [bounds.maxX, bounds.maxY],
  ].map(([x, z]) => {
    const p = new Vector3(x, 0, z).project(cam);
    return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H };
  });
}

describe("framing a scene into the part of the screen the HUD leaves visible (SPEC §8.4)", () => {
  const bounds = { minX: 0, minY: 0, maxX: 60, maxY: 40 };
  const cases: [string, number, number, ScreenRect][] = [
    ["desktop, dock closed", 1440, 900, { left: 76, top: 56, right: 1440 - 76, bottom: 900 - 12 }],
    ["desktop, dock open", 1440, 900, { left: 76, top: 56, right: 1440 - 480, bottom: 900 - 12 }],
    ["tablet", 1024, 768, { left: 76, top: 56, right: 1024 - 76, bottom: 768 - 12 }],
    ["portrait phone", 390, 844, { left: 72, top: 56, right: 390 - 72, bottom: 844 - 12 }],
    ["with the prep banner", 1024, 768, { left: 76, top: 116, right: 1024 - 76, bottom: 768 - 12 }],
  ];
  for (const [name, W, H, visible] of cases)
    it(`${name}: every corner inside the visible area, the map centred in it`, () => {
      const f = frameBounds({
        bounds,
        width: W,
        height: H,
        fovDeg: 40,
        pitchDeg: 55,
        visible,
        maxDistance: 400,
      });
      const pts = cornersOnScreen(f, W, H, bounds);
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(visible.left);
        expect(p.x).toBeLessThanOrEqual(visible.right);
        expect(p.y).toBeGreaterThanOrEqual(visible.top);
        expect(p.y).toBeLessThanOrEqual(visible.bottom);
      }
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo((visible.left + visible.right) / 2, 0);
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo((visible.top + visible.bottom) / 2, 0);
      // As close as fits: 5 % nearer and it wouldn't.
      const nearer = frameBounds({
        bounds,
        width: W,
        height: H,
        fovDeg: 40,
        pitchDeg: 55,
        visible,
        minDistance: f.distance * 0.95,
        maxDistance: f.distance * 0.95,
      });
      const tight = cornersOnScreen(nearer, W, H, bounds);
      const outside = tight.some(
        (p) =>
          p.x < visible.left + 24 - 0.5 ||
          p.x > visible.right - 24 + 0.5 ||
          p.y < visible.top + 24 - 0.5 ||
          p.y > visible.bottom - 24 + 0.5,
      );
      expect(outside).toBe(true);
    });
});
