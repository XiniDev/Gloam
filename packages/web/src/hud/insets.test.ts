import { describe, expect, it } from "vitest";
import { largestClear, type ScreenArea } from "./insets.ts";

const area: ScreenArea = { left: 72, top: 56, right: 1370, bottom: 830 };
const overlaps = (a: ScreenArea, b: ScreenArea) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("the clear part of the board (dice come to rest clear of the HUD)", () => {
  it("is the whole area when nothing is in the way, or the obstacle lies outside it", () => {
    expect(largestClear(area, [], 1)).toEqual(area);
    expect(largestClear(area, [{ left: 0, top: 0, right: 60, bottom: 900 }], 1)).toEqual(area);
  });

  it("the roll feed at the bottom-left: square content goes beside it, a wide strip above it", () => {
    const feed = { left: 64, top: 640, right: 352, bottom: 900 };
    const square = largestClear(area, [feed], 1);
    expect(overlaps(square, feed)).toBe(false);
    // Beside the feed: the full height.
    expect(square).toEqual({ left: 352, top: 56, right: 1370, bottom: 830 });
    const wide = largestClear(area, [feed], 4);
    expect(overlaps(wide, feed)).toBe(false);
    // Above the feed: the full width.
    expect(wide).toEqual({ left: 72, top: 56, right: 1370, bottom: 640 });
  });

  it("the feed and an open tray together: the result overlaps neither and is the best fit", () => {
    const feed = { left: 64, top: 640, right: 352, bottom: 900 };
    const tray = { left: 452, top: 380, right: 988, bottom: 832 };
    const r = largestClear(area, [feed, tray], 1);
    expect(overlaps(r, feed)).toBe(false);
    expect(overlaps(r, tray)).toBe(false);
    // Brute force over every rectangle on a coarse grid: none clear of both holds square content larger.
    const fit = (a: ScreenArea) => Math.min(a.right - a.left, a.bottom - a.top);
    for (let x0 = area.left; x0 < area.right; x0 += 40)
      for (let x1 = x0 + 40; x1 <= area.right; x1 += 40)
        for (let y0 = area.top; y0 < area.bottom; y0 += 40)
          for (let y1 = y0 + 40; y1 <= area.bottom; y1 += 40) {
            const c = { left: x0, top: y0, right: x1, bottom: y1 };
            if (overlaps(c, feed) || overlaps(c, tray)) continue;
            expect(fit(c)).toBeLessThanOrEqual(fit(r));
          }
  });

  it("a phone: the feed's card above the action bar leaves the board above it", () => {
    const phone = { left: 12, top: 130, right: 378, bottom: 768 };
    const card = { left: 4, top: 610, right: 292, bottom: 776 };
    const r = largestClear(phone, [card], 0.7);
    expect(r).toEqual({ left: 12, top: 130, right: 378, bottom: 610 });
  });
});
