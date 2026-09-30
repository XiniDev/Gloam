import { describe, expect, it } from "vitest";
import { placeSettings } from "./settingsPlace.ts";

/** The dock's rail and an open panel beside it, as the screen has them (a 12-px gutter; the rail 50 px wide). */
const railAt = (w: number) => ({ left: w - 62, right: w - 12, top: 68, bottom: 268 });
const panelAt = (w: number, width = 380, h = 900) => ({
  left: w - 70 - width,
  right: w - 70,
  top: 68,
  bottom: h - 12,
});

describe("the settings popover's place (critic RSP-01 r1–r2)", () => {
  it("sits under its gear, right edges in line, inside the screen — two columns from 1024 px", () => {
    const p = placeSettings({ right: 1300 }, { rail: railAt(1440), tools: 76 }, { w: 1440, h: 900 });
    expect(p).toMatchObject({ left: 1300 - 680, width: 680, columns: 2, top: 64, maxHeight: 900 - 64 - 12 });
    const narrow = placeSettings({ right: 630 }, { rail: railAt(768), tools: 76 }, { w: 768, h: 1024 });
    expect(narrow).toMatchObject({ left: 290, width: 340, columns: 1, inPanel: false });
  });

  it("never runs off the left edge (it did at 768 px beside a wide dock panel), nor past the right", () => {
    const p = placeSettings({ right: 200 }, {}, { w: 768, h: 1024 });
    expect(p.left).toBe(12);
    const q = placeSettings({ right: 900 }, {}, { w: 844, h: 390 });
    expect(q.left + q.width).toBe(844 - 12);
    expect(q.maxHeight).toBe(390 - 64 - 12);
  });

  it("never half over the dock's rail: clear to its left", () => {
    const p = placeSettings({ right: 1410 }, { rail: railAt(1440), tools: 76 }, { w: 1440, h: 900 });
    expect(p.left + p.width).toBeLessThanOrEqual(1440 - 62);
  });

  it("never half over an open panel: clear to its left, in two columns or one — or in its place, exactly over it", () => {
    // 1440: room for both columns left of the panel.
    const wide = placeSettings(
      { right: 1300 },
      { rail: railAt(1440), panel: panelAt(1440), tools: 76 },
      { w: 1440, h: 900 },
    );
    expect(wide).toMatchObject({ columns: 2, inPanel: false });
    expect(wide.left + wide.width).toBeLessThanOrEqual(1440 - 70 - 380);
    // 1024: one column fits left of it, clear of the tool column.
    const mid = placeSettings(
      { right: 890 },
      { rail: railAt(1024), panel: panelAt(1024, 380, 768), tools: 76 },
      { w: 1024, h: 768 },
    );
    expect(mid).toMatchObject({ columns: 1, inPanel: false });
    expect(mid.left).toBeGreaterThanOrEqual(76);
    expect(mid.left + mid.width).toBeLessThanOrEqual(1024 - 70 - 380);
    // 844 × 390 and 768: no room clear of both the panel and the tool column — the panel's place, exactly.
    for (const [w, h] of [
      [844, 390],
      [768, 1024],
    ] as const) {
      const panel = panelAt(w, 380, h);
      const p = placeSettings({ right: w - 140 }, { rail: railAt(w), panel, tools: 76 }, { w, h });
      expect(p).toMatchObject({
        inPanel: true,
        left: panel.left,
        width: 380,
        top: panel.top,
        maxHeight: panel.bottom - panel.top,
      });
    }
  });
});
