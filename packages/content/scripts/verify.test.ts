/**
 * Checks the committed SRD 5.2.1 spell pack (AC-SPL-01 and the §33.4 / §34.4 shapes the engine relies on).
 * Reads packs/srd-5.2.1/spells.json as committed; `pnpm content:build` regenerates it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Spell, SpellSchema } from "@gloam/shared/schemas";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const raw: unknown = JSON.parse(readFileSync(join(here, "..", "packs", "srd-5.2.1", "spells.json"), "utf8"));
const records = raw as unknown[];
const spells = records.map((r) => SpellSchema.parse(r));
const byId = new Map(spells.map((s) => [s.id, s]));

function spell(id: string): Spell {
  const s = byId.get(id);
  if (!s) throw new Error(`missing spell ${id}`);
  return s;
}

const NAMED_EFFECTS = [
  "fog-cloud",
  "darkness",
  "daylight",
  "light",
  "spirit-guardians",
  "moonbeam",
  "web",
  "spike-growth",
  "sleet-storm",
  "stinking-cloud",
  "cloudkill",
  "wall-of-fire",
  "silence",
  "faerie-fire",
  "flaming-sphere",
  "call-lightning",
];

describe("SRD 5.2.1 spell pack", () => {
  it("validates every record against the spell schema", () => {
    expect(Array.isArray(raw)).toBe(true);
    for (const r of records) {
      const result = SpellSchema.safeParse(r);
      expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
    }
  });

  it("has exactly 339 spells with the SRD per-level counts (AC-SPL-01)", () => {
    expect(spells).toHaveLength(339);
    const perLevel = Array.from({ length: 10 }, (_, l) => spells.filter((s) => s.level === l).length);
    expect(perLevel).toEqual([27, 57, 57, 42, 34, 38, 31, 20, 17, 16]);
  });

  it("has unique ids and names, sorted by level then name", () => {
    expect(new Set(spells.map((s) => s.id)).size).toBe(spells.length);
    expect(new Set(spells.map((s) => s.name)).size).toBe(spells.length);
    const sorted = [...spells].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "en"));
    expect(spells.map((s) => s.id)).toEqual(sorted.map((s) => s.id));
  });

  it("contains no non-SRD Foundry content", () => {
    expect(byId.has("arcane-vigor")).toBe(false);
  });

  it("cites the SRD pack and page on every record", () => {
    for (const s of spells) {
      expect(s.source.pack).toBe("srd-5.2.1");
      expect(s.source.page).toBeGreaterThanOrEqual(107);
      expect(s.source.page).toBeLessThanOrEqual(175);
    }
  });

  it("gives the 16 named persistent effects an effect template (SPEC §8.13)", () => {
    for (const id of NAMED_EFFECTS) {
      expect(spell(id).effect, id).toBeTruthy();
    }
  });

  it("Fireball: 20-ft Sphere, Dexterity save for half, 8d6 Fire +1d6 per slot", () => {
    const s = spell("fireball");
    expect(s.level).toBe(3);
    expect(s.area).toEqual({ shape: "sphere", radius: 20 });
    expect(s.save).toEqual({ ability: "dex", onSuccess: "half" });
    expect(s.damage).toEqual([{ formula: "8d6", type: "fire", scaling: { mode: "slot", perLevel: "1d6" } }]);
    expect(s.vfx).toBe("fire");
  });

  it("Fog Cloud: 20-ft radius growing 20 ft per slot, heavily obscured", () => {
    const s = spell("fog-cloud");
    expect(s.area).toEqual({ shape: "sphere", radius: 20, scaling: { perSlot: 20 } });
    expect(s.obscurement).toBe("heavy");
    expect(s.effect?.props.obscurement).toBe("heavy");
  });

  it("Darkness: magical darkness in a 15-ft radius (or an Emanation from an object)", () => {
    const s = spell("darkness");
    expect(s.area).toEqual({ shape: "sphere", radius: 15 });
    expect(s.obscurement).toBe("magicalDarkness");
    expect(s.effect?.props.magicalDarkness).toBe(true);
    expect(s.areaAlternatives?.[0]?.area).toEqual({ shape: "emanation", distance: 15 });
    expect(s.areaAlternatives?.[0]?.attach).toBe("object");
  });

  it("Moonbeam: Cylinder r5 h40 the caster can move 60 ft", () => {
    const s = spell("moonbeam");
    expect(s.area).toEqual({ shape: "cylinder", radius: 5, height: 40 });
    expect(s.effect?.movement).toMatchObject({ by: "caster", maxFt: 60 });
  });

  it("Spirit Guardians: 15-ft Emanation attached to the caster", () => {
    const s = spell("spirit-guardians");
    expect(s.area).toEqual({ shape: "emanation", distance: 15 });
    expect(s.effect?.attach).toBe("caster");
    expect(s.effect?.props.speedHalved).toBe(true);
  });

  it("Lightning Bolt: 100 × 5 Line; Burning Hands: 15-ft Cone; Cone of Cold: 60-ft Cone", () => {
    expect(spell("lightning-bolt").area).toEqual({ shape: "line", length: 100, width: 5 });
    expect(spell("burning-hands").area).toEqual({ shape: "cone", length: 15 });
    expect(spell("cone-of-cold").area).toEqual({ shape: "cone", length: 60 });
  });

  it("Wall of Fire: an opaque, passable wall 60 × 20 × 1 or a 20-ft ring, damaging on one side", () => {
    const a = spell("wall-of-fire").area;
    expect(a?.shape).toBe("wall");
    if (a?.shape !== "wall") throw new Error("not a wall");
    expect(a).toMatchObject({
      length: 60,
      height: 20,
      thickness: 1,
      ring: 20,
      opaque: true,
      blocksMove: false,
    });
    expect(a.damagingSide).toBeDefined();
  });

  it("keeps §33.4 cylinder heights", () => {
    const cylinders: Record<string, [number, number]> = {
      "call-lightning": [60, 10],
      "conjure-celestial": [10, 40],
      "flame-strike": [10, 40],
      "ice-storm": [20, 40],
      "magic-circle": [10, 20],
      moonbeam: [5, 40],
      "reverse-gravity": [50, 100],
      "sleet-storm": [20, 40],
    };
    for (const [id, [radius, height]] of Object.entries(cylinders)) {
      expect(spell(id).area, id).toEqual({ shape: "cylinder", radius, height });
    }
  });

  it("gives every spell a VFX preset and provenance", () => {
    for (const s of spells) {
      expect(s.vfx).toBeTruthy();
      expect(s.provenance?.text).toBe("pdf");
    }
  });
});
