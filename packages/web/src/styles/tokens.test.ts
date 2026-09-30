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

/** WCAG 2 relative luminance and contrast ratio. */
const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("text is legible on every surface it's set on (AC-A11Y-04: at least 4.5:1)", () => {
  const css = cssColours();
  const hex = (name: string) => {
    const v = css.get(name);
    expect(v, `--${name}`).toBeDefined();
    return v as string;
  };
  it("chrome: body, muted and faint text, links and the state colours on the ink surfaces", () => {
    const surfaces = ["ink-950", "ink-900", "ink-850", "ink-800"]; // bg, surface, panel, raised
    const texts = [
      "bone-100",
      "fog-300",
      "fog-400",
      "brass-300",
      "brass-400",
      "danger-text",
      "verdigris-400",
      "arcane-400",
      "ember-400",
      "hex-400",
    ];
    const low: string[] = [];
    for (const t of texts)
      for (const s of surfaces) {
        const r = contrast(hex(t), hex(s));
        if (r < 4.5) low.push(`${t} on ${s}: ${r.toFixed(2)}`);
      }
    expect(low).toEqual([]);
  });
  it("documents: the parchment's ink and its muted ink on the parchment", () => {
    const low: string[] = [];
    for (const t of ["parchment-ink", "parchment-ink-muted", "wax-500"])
      for (const s of ["parchment-100", "parchment-200"]) {
        const r = contrast(hex(t), hex(s));
        if (r < 4.5) low.push(`${t} on ${s}: ${r.toFixed(2)}`);
      }
    expect(low).toEqual([]);
  });
});
