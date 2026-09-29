import { BOARD_COLORS, PLAYER_COLORS } from "@gloam/shared";
import { describe, expect, it } from "vitest";
import { contrastRatio, glyphInk } from "./badgeInk.ts";

describe("a custom marker's glyph ink", () => {
  it("takes ink on a light badge and bone on a dark one", () => {
    expect(glyphInk("#F2E266")).toBe("ink"); // Citrine
    expect(glyphInk("#D9DEE6")).toBe("ink"); // Silver
    expect(glyphInk("#2B2140")).toBe("bone");
    expect(glyphInk("not a colour")).toBe("bone");
  });

  it("reads at 3:1 or better on every colour a DM can pick (SPEC §27.2)", () => {
    for (const c of PLAYER_COLORS) {
      const ink = glyphInk(c.hex) === "ink" ? BOARD_COLORS.ink950 : BOARD_COLORS.bone100;
      expect(contrastRatio(ink, c.hex), c.name).toBeGreaterThanOrEqual(3);
    }
  });
});
