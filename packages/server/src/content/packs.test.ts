import { LIGHT_PRESETS, SRD_521_ATTRIBUTION, SRD_521_SPELL_COUNTS } from "@gloam/shared";
import { describe, expect, it } from "vitest";
import { loadSrdPack } from "./packs.ts";

describe("SRD 5.2.1 content pack (AC-SPL-01)", () => {
  it("loads exactly 339 spells with per-level counts 27/57/57/42/34/38/31/20/17/16", () => {
    const pack = loadSrdPack();
    expect(pack.spells).toHaveLength(339);
    const perLevel = Array.from({ length: 10 }, (_, l) => pack.spells.filter((s) => s.level === l).length);
    expect(perLevel).toEqual([...SRD_521_SPELL_COUNTS]);
    expect(pack.spellById.get("fireball")?.level).toBe(3);
    expect(pack.conditions.map((c) => c.id)).toEqual([
      "blinded",
      "charmed",
      "deafened",
      "exhaustion",
      "frightened",
      "grappled",
      "incapacitated",
      "invisible",
      "paralyzed",
      "petrified",
      "poisoned",
      "prone",
      "restrained",
      "stunned",
      "unconscious",
    ]);
    expect(pack.attribution).toBe(SRD_521_ATTRIBUTION);
    expect(pack.lightSources.find((l) => l.id === "torch")).toMatchObject({ bright: 20, dim: 20 });
  });

  it("the light presets the client and commands use are the pack's §34.3 radii and cones, and the lowered hood is bright 0 / dim 5", () => {
    const pack = loadSrdPack();
    for (const p of LIGHT_PRESETS) {
      const src = pack.lightSources.find((l) => l.id === p.id);
      expect(src, p.id).toBeDefined();
      expect([p.bright, p.dim, p.coneDeg ?? undefined], p.id).toEqual([src?.bright, src?.dim, src?.cone]);
    }
    expect(pack.lightSources.find((l) => l.id === "hooded-lantern-lowered")).toMatchObject({
      bright: 0,
      dim: 5,
    });
  });
});
