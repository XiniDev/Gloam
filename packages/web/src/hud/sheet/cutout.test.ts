import { describe, expect, it } from "vitest";
import { CUTOUT_DEFAULTS, cutout, fitWithin, paperColour, type Rgba, toLab } from "./cutout.ts";

/**
 * A phone photo of a drawing on paper, made up: off-white paper lit unevenly (brighter top-left, a shade darker
 * bottom-right) with sensor noise, a red disc with a black ink rim and a paper-white "eye" inside it, and dust specks.
 */
function photo(): Rgba {
  const W = 240;
  const H = 180;
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return ((seed >>> 8) / 0x1000000) * 2 - 1;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const t = (x / W + y / H) / 2;
      let r = 244 - 26 * t + rnd() * 4;
      let g = 238 - 27 * t + rnd() * 4;
      let b = 224 - 28 * t + rnd() * 4;
      const d = Math.hypot(x - 120, y - 90);
      if (d <= 30) {
        [r, g, b] = [196, 40, 36];
        if (d >= 28) [r, g, b] = [22, 18, 16];
        if (Math.hypot(x - 128, y - 84) <= 5) [r, g, b] = [240, 234, 220];
      }
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  // Dust.
  for (const [x, y] of [
    [20, 20],
    [220, 30],
    [30, 160],
    [210, 150],
  ] as const)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const o = ((y + dy) * W + x + dx) * 4;
        data[o] = 30;
        data[o + 1] = 28;
        data[o + 2] = 26;
      }
  return { data, width: W, height: H };
}

const px = (img: Rgba, x: number, y: number) => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]] as number[];
};

describe("paper cutout (SPEC §8.10 Character art, AC-SHEET-11)", () => {
  it("finds the paper's colour from the border, in Lab", () => {
    const [l] = paperColour(photo());
    expect(l).toBeGreaterThan(88);
    expect(toLab(255, 255, 255)[0]).toBeCloseTo(100, 0);
  });

  it("turns the photo into a clean sticker: paper gone, drawing and its inner white kept, dust removed, a white outline and a soft shadow, trimmed", () => {
    const out = cutout(photo(), CUTOUT_DEFAULTS);
    const pad = CUTOUT_DEFAULTS.outline + 8;
    // Trimmed to the disc (61 px across) and its padding — the dust in the corners didn't count.
    expect(out.width).toBe(61 + 2 * pad);
    expect(out.height).toBe(61 + 2 * pad);
    // The disc's origin in the output: (120 − 30) − pad.
    const at = (sx: number, sy: number) => px(out, sx - (90 - pad), sy - (60 - pad));
    // The drawing, opaque and its colours kept.
    expect(at(110, 95)).toEqual([196, 40, 36, 255]);
    expect(at(120, 61)[3]).toBe(255);
    // The paper-white eye inside the drawing stays (only paper reached from the edge goes).
    expect(at(128, 84)[3]).toBe(255);
    expect(at(128, 84)[0]).toBeGreaterThan(220);
    // The outline: white, 10 px out from the rim.
    expect(at(120 + 30 + 5, 90)).toEqual([255, 255, 255, 255]);
    expect(at(120, 90 - 30 - 8)[3]).toBe(255);
    // Past the outline: the soft shadow below-right, and nothing at the top-left corner.
    const shadow = at(120 + 30 + 12, 90 + 2)[3] as number;
    expect(shadow).toBeGreaterThan(0);
    expect(shadow).toBeLessThan(255 * 0.4);
    expect(px(out, 0, 0)[3]).toBe(0);
  });

  it("tolerance and outline adjust it: too tight a tolerance keeps shaded paper; no outline, no white ring", () => {
    const loose = cutout(photo(), { ...CUTOUT_DEFAULTS });
    const tight = cutout(photo(), { tolerance: 3, outline: 10 });
    expect(tight.width * tight.height).toBeGreaterThan(loose.width * loose.height);
    const bare = cutout(photo(), { tolerance: 18, outline: 0 });
    const pad = 8;
    const at = (sx: number, sy: number) => px(bare, sx - (90 - pad), sy - (60 - pad));
    // Just outside the rim: no white — at most the shadow.
    const p = at(120 + 30 + 3, 90);
    expect(p[3] as number).toBeLessThan(255 * 0.4);
  });

  it("a big phone photo is fitted within 2048 px before any of it", () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });
});
