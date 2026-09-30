import { describe, expect, it } from "vitest";
import { EMPTY_STATUS, type TokenStatusT } from "../schemas/entities.ts";
import { Sheet } from "../schemas/sheet.ts";
import { diffSheet } from "./sheetLocks.ts";
import { applyPatch, patchOf, pointer, tokens } from "./sheetPatch.ts";
import { projectSheet, statusFromSheet, storedSheet } from "./sheetStatus.ts";
import { statsFromSheet } from "./tokenStats.ts";

const thorin = () =>
  Sheet.parse({
    core: {
      name: "Thorin",
      classes: [{ name: "Fighter", level: 5 }],
      abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 13, cha: 8 },
      saves: { con: { proficient: true } },
      hp: { max: 44, current: 44, temp: 0 },
      inventory: [{ name: "Torch", qty: 5, weight: 1 }],
      speeds: { walk: 25 },
      senses: { darkvision: 60 },
    },
    custom: [{ id: "b1", type: "counter", title: "Sanity", value: 8, max: 10 }],
  });

describe("sheet patches (SPEC §14.3 sheet ops)", () => {
  it("pointers escape ~ and / and read back", () => {
    const p = pointer(["core", "overrides", "save.str", "a/b~c", 3]);
    expect(p).toBe("/core/overrides/save.str/a~1b~0c/3");
    expect(tokens(p)).toEqual(["core", "overrides", "save.str", "a/b~c", "3"]);
  });

  it("a diff's patch turns the old sheet into the new one, and its inverse turns it back — adds, removes, replaces", () => {
    const before = thorin();
    const after = Sheet.parse({
      ...before,
      core: {
        ...before.core,
        abilities: { ...before.core.abilities, str: 18 },
        inventory: [...before.core.inventory, { name: "Rope", qty: 1, weight: 10 }],
        species: "Dwarf",
        overrides: { proficiencyBonus: 4 },
      },
      custom: [],
    });
    const { patch, inverse } = patchOf(diffSheet(before, after));
    expect(patch.map((p) => p.op).sort()).toEqual(["add", "add", "replace", "replace", "replace"].sort());
    expect(applyPatch(before, patch)).toEqual(after);
    expect(applyPatch(after, inverse)).toEqual(before);
    // The documents given are untouched.
    expect(before.core.abilities.str).toBe(16);
  });

  it("follows RFC 6902 for arrays and refuses paths that aren't there", () => {
    const doc = { a: [1, 2, 3], o: { k: 1 } };
    expect(applyPatch(doc, [{ op: "add", path: "/a/1", value: 9 }]).a).toEqual([1, 9, 2, 3]);
    expect(applyPatch(doc, [{ op: "add", path: "/a/-", value: 9 }]).a).toEqual([1, 2, 3, 9]);
    expect(applyPatch(doc, [{ op: "remove", path: "/a/0" }]).a).toEqual([2, 3]);
    expect(applyPatch(doc, [{ op: "replace", path: "/o/k", value: 2 }]).o).toEqual({ k: 2 });
    expect(() => applyPatch(doc, [{ op: "replace", path: "/o/missing", value: 1 }])).toThrow();
    expect(() => applyPatch(doc, [{ op: "add", path: "/x/y", value: 1 }])).toThrow();
    expect(() => applyPatch(doc, [{ op: "remove", path: "/a/7" }])).toThrow();
  });
});

describe("a character's status has one home (the actor's status; the sheet shows it)", () => {
  const status: TokenStatusT = {
    ...EMPTY_STATUS,
    conditions: [{ id: "poisoned", source: "Giant spider", untilRound: 4 }],
    exhaustion: 2,
    deathSaves: { successes: 1, failures: 2, stable: false, dead: false },
    concentration: { effectId: "eff1", spellName: "Bless" },
  };

  it("the sheet read by players carries the status; the stored sheet doesn't", () => {
    const shown = projectSheet(thorin(), status);
    expect(shown.core.conditions).toEqual(["poisoned"]);
    expect(shown.core.exhaustion).toBe(2);
    expect(shown.core.deathSaves).toEqual({ successes: 1, failures: 2 });
    expect(shown.core.concentration).toBe("Bless");
    const stored = storedSheet(shown);
    expect(stored.core.conditions).toEqual([]);
    expect(stored.core.exhaustion).toBe(0);
    expect(stored.core.concentration).toBeUndefined();
    expect(Sheet.safeParse(stored).success).toBe(true);
  });

  it("a sheet edit becomes status, keeping what the status knew (a condition's source, concentration's effect)", () => {
    const shown = projectSheet(thorin(), status);
    shown.core.conditions = ["poisoned", "prone"];
    shown.core.exhaustion = 1;
    const next = statusFromSheet(shown, status);
    expect(next.conditions).toEqual([
      { id: "poisoned", source: "Giant spider", untilRound: 4 },
      { id: "prone" },
    ]);
    expect(next.exhaustion).toBe(1);
    expect(next.concentration).toEqual({ effectId: "eff1", spellName: "Bless" });
    // Dropping them.
    shown.core.conditions = [];
    delete shown.core.concentration;
    const cleared = statusFromSheet(shown, status);
    expect(cleared.conditions).toEqual([]);
    expect(cleared.concentration).toBeUndefined();
    // Round trip: projecting the new status gives the edited sheet's fields back.
    expect(projectSheet(storedSheet(shown), cleared).core).toEqual(shown.core);
  });
});

describe("a linked token's numbers come from the sheet (SPEC §8.5, AC-SHEET-09)", () => {
  it("HP, AC, speeds, senses and size from the sheet; saves and initiative from its derived values, overrides and all", () => {
    const s = thorin();
    const st = statsFromSheet(s as unknown as Record<string, unknown>);
    // Initiative: the Dex modifier, and apart from it any bonus (none here) — every reader adds the two (SRD 5.2.1 p. 13).
    expect(st).toMatchObject({ hp: 44, hpMax: 44, ac: 10, size: "medium", initBonus: 0, dexMod: 1 });
    expect(st.speeds.walk).toBe(25);
    expect(st.senses.darkvision).toBe(60);
    expect(st.saves.con).toBe(3 + 3);
    // A changed sheet is a new document (the model never edits one in place).
    const changed = { ...s, core: { ...s.core, overrides: { "save.con": 9, initiative: 5 } } };
    const o = statsFromSheet(changed as unknown as Record<string, unknown>);
    expect(o.saves.con).toBe(9);
    // An initiative of +5 set on the sheet: +1 of it is Dex, the rest the bonus.
    expect(o.initBonus).toBe(4);
  });
});
