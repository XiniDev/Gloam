import { describe, expect, it } from "vitest";
import { visibleTabs } from "./tabsLayout.ts";

// Nine tabs 60 px wide (62 with the gap), a More button of 40.
const W = Array.from({ length: 9 }, () => 60);

describe("the sheet's tab row (§29.7; critic P6 r2 #11)", () => {
  it("shows every tab when they fit", () => {
    expect(visibleTabs(W, 40, 9 * 62, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("otherwise the first ones in order beside the More button", () => {
    // 400 − 40 − 2 = 358 → five tabs (310), a sixth would need 372.
    expect(visibleTabs(W, 40, 400, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(visibleTabs(W, 40, 400, 3)).toEqual([0, 1, 2, 3, 4]);
  });
  it("an active tab among the rest takes only the last place — the others never move", () => {
    expect(visibleTabs(W, 40, 400, 7)).toEqual([0, 1, 2, 3, 7]);
    // A wider active tab takes as many of the last places as it needs.
    const wide = [...W];
    wide[7] = 150;
    expect(visibleTabs(wide, 40, 400, 7)).toEqual([0, 1, 2, 7]);
  });
});
