import { describe, expect, it } from "vitest";
import { SOUND_GROUPS } from "./catalogue.ts";
import { RECIPES } from "./recipes.ts";
import { SOUND_VISUALS } from "./visuals.ts";

describe("every sound has something to see (AC-A11Y-05)", () => {
  it("each sound the table can play names its visual counterpart — a toast, badge, card, banner or animation", () => {
    const sounds = Object.keys(RECIPES).sort();
    expect(Object.keys(SOUND_VISUALS).sort()).toEqual(sounds);
    // The catalogue (/dev/sounds) lists no sound the table has no picture for.
    for (const g of SOUND_GROUPS)
      for (const s of g.sounds) expect(SOUND_VISUALS[s.name], s.name).toBeDefined();
    for (const [name, v] of Object.entries(SOUND_VISUALS)) {
      expect(["toast", "badge", "animation", "card", "banner"], name).toContain(v.kind);
      expect(v.shows.length, name).toBeGreaterThan(10);
    }
  });
});
