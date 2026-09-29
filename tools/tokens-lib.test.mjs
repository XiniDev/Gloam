import { describe, expect, it } from "vitest";
import { exempt, scan } from "./tokens-lib.mjs";

describe("design-token lint (AC-DS-01)", () => {
  it("flags raw colours, fonts, radii, type sizes, durations and off-grid spacing", () => {
    const bad = [
      '<div className="bg-[#123456]" />',
      "const c = 'rgb(1, 2, 3)';",
      'style={{ fontFamily: "Arial" }} font-family: Arial;',
      '<span className="rounded-[5px]" />',
      '<p className="text-[15px]" />',
      '<i className="duration-[250ms]" />',
      '<b className="px-[13px]" />',
      '<em className="text-15 sm:text-32" />',
    ].join("\n");
    const found = scan(bad, "hud/Bad.tsx");
    expect(found.some((p) => p.includes("raw colour #123456"))).toBe(true);
    expect(found.some((p) => p.includes("raw colour rgb("))).toBe(true);
    expect(found.some((p) => p.includes("inline font-family"))).toBe(true);
    expect(found.some((p) => p.includes("raw radius rounded-[5px]"))).toBe(true);
    expect(found.some((p) => p.includes("raw type size text-[15px]"))).toBe(true);
    expect(found.some((p) => p.includes("raw duration duration-[250ms]"))).toBe(true);
    expect(found.some((p) => p.includes("off-grid spacing px-[13px]"))).toBe(true);
    expect(found.some((p) => p.includes("text-15 isn't on the type scale"))).toBe(true);
    expect(found.some((p) => p.includes("text-32 isn't on the type scale"))).toBe(true);
    expect(found.every((p) => p.startsWith("hud/Bad.tsx:"))).toBe(true);
  });

  it("accepts token usage", () => {
    const good = [
      '<div className="rounded-chip bg-[var(--ink-900)] text-14 duration-[var(--dur-fast)] px-[12px] gap-2" />',
      '<div className="rounded-[var(--radius-control)] rounded-full" />',
      "&#x27; is an entity, not a colour",
    ].join("\n");
    expect(scan(good, "hud/Good.tsx")).toEqual([]);
  });

  it("exempts only the token file and the 3D board", () => {
    expect(exempt("styles/tokens.css")).toBe(true);
    expect(exempt("board/floors.ts")).toBe(true);
    expect(exempt("board\\tokens\\hpBar.ts".replaceAll("\\\\", "\\"))).toBe(true);
    expect(exempt("hud/Dock.tsx")).toBe(false);
    expect(exempt("styles/globals.css")).toBe(false);
  });
});
