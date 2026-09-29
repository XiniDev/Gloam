import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { frameBounds, frameReadable, pxPerFoot, readableRegion, type ScreenRect } from "./framing.ts";

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

describe("a phone opens a scene too big to read at a readable scale, round the viewer's creatures (critic P11 r1 I8)", () => {
  const bounds = { minX: 0, minY: 0, maxX: 60, maxY: 40 };
  const [W, H] = [390, 844];
  const visible = { left: 12, top: 64, right: 378, bottom: 844 - 92 };
  const whole = frameBounds({ bounds, width: W, height: H, fovDeg: 40, pitchDeg: 55, visible });
  it("the whole 60×40 map on a portrait phone is too small to read (a 5-ft square under 40 px)", () => {
    expect(pxPerFoot(whole, W, H, 40) * 5).toBeLessThan(40);
  });
  it("the region round a creature near the west wall: inside the map, the creature in it, squares ≥ 40 px", () => {
    const focus = { x: 6, y: 20 };
    const region = readableRegion({ bounds, visible, pitchDeg: 55, focus, pxPerFt: 8 });
    expect(region.minX).toBe(0);
    expect(region.maxX).toBeLessThan(60);
    expect(region.minY).toBeGreaterThanOrEqual(0);
    expect(region.maxY).toBeLessThanOrEqual(40);
    expect(focus.x).toBeGreaterThanOrEqual(region.minX);
    expect(focus.x).toBeLessThanOrEqual(region.maxX);
    // Framed (narrowed until the middle reads — perspective makes the near edge bind first): squares ≥ 40 px there,
    // the creature on screen inside the visible area.
    const f = frameReadable({
      bounds,
      width: W,
      height: H,
      fovDeg: 40,
      pitchDeg: 55,
      visible,
      focus,
      pxPerFt: 8,
    });
    expect(pxPerFoot(f, W, H, 40) * 5).toBeGreaterThanOrEqual(39.5);
    const [c] = cornersOnScreen(f, W, H, { minX: focus.x, minY: focus.y, maxX: focus.x, maxY: focus.y });
    expect(c?.x).toBeGreaterThanOrEqual(visible.left);
    expect(c?.x).toBeLessThanOrEqual(visible.right);
    expect(c?.y).toBeGreaterThanOrEqual(visible.top);
    expect(c?.y).toBeLessThanOrEqual(visible.bottom);
  });
  it("a side the map already fits is kept whole", () => {
    const tall = { minX: 0, minY: 0, maxX: 30, maxY: 200 };
    const region = readableRegion({
      bounds: tall,
      visible,
      pitchDeg: 55,
      focus: { x: 15, y: 100 },
      pxPerFt: 8,
    });
    expect([region.minX, region.maxX]).toEqual([0, 30]);
    expect(region.maxY - region.minY).toBeLessThan(200);
  });
});
