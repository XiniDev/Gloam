import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_COLORS } from "@gloam/shared";
import { ICON_CATEGORIES } from "@gloam/shared/icons";
import { describe, expect, it } from "vitest";

/** The :root custom properties of tokens.css that are plain hex colours. */
function cssColours(): Map<string, string> {
  const css = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const out = new Map<string, string>();
  for (const m of root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g))
    out.set(m[1] as string, (m[2] as string).toLowerCase());
  return out;
}

/** bone100 → bone-100, hpGhost → hp-ghost. */
const kebab = (k: string) => k.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase();

describe("the WebGL palette mirrors the CSS tokens (SPEC §27.2)", () => {
  const css = cssColours();
  it("every board colour with a token of the same name has its value", () => {
    let compared = 0;
    for (const [k, v] of Object.entries(BOARD_COLORS)) {
      const token = css.get(kebab(k));
      if (!token) continue;
      expect(v.toLowerCase(), k).toBe(token);
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("the icon badges (Appendix G) have their tokens", () => {
    for (const [cat, hex] of Object.entries(ICON_CATEGORIES))
      expect(css.get(`badge-${cat}`), cat).toBe(hex.toLowerCase());
  });
});
