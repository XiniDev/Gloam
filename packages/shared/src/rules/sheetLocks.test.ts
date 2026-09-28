import { describe, expect, it } from "vitest";
import { Sheet } from "../schemas/sheet.ts";
import { applyChanges, diffSheet, lockedChanges, pathLabel } from "./sheetLocks.ts";

const base = () =>
  Sheet.parse({
    core: {
      name: "Thorin",
      classes: [{ name: "Fighter", level: 5 }],
      abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 13, cha: 8 },
      hp: { max: 44, current: 44, temp: 0 },
      hitDice: [{ die: "d10", total: 5, used: 0 }],
      features: [{ name: "Second Wind", text: "", uses: { max: 1, used: 0, recharge: "short" } }],
      inventory: [{ name: "Torch", qty: 5, weight: 1 }],
      spellcasting: { ability: "wis", slots: [{ level: 1, max: 2 }], spells: [{ name: "Bless", level: 1 }] },
      ac: { value: 18 },
    },
    custom: [
      { id: "b1", type: "counter", title: "Sanity", value: 8, max: 10 },
      { id: "b2", type: "number", title: "Renown", value: 3 },
    ],
  });
type S = ReturnType<typeof base>;
const edit = (f: (s: S) => void) => {
  const s = base();
  f(s);
  return s;
};

const sc = (s: S) => s.core.spellcasting as NonNullable<S["core"]["spellcasting"]>;
const at = <T>(xs: T[], i: number) => xs[i] as T;

/** Every play-state edit §8.10 lists. */
const PLAY: [string, (s: S) => void][] = [
  [
    "current HP",
    (s) => {
      s.core.hp.current = 30;
    },
  ],
  [
    "temp HP",
    (s) => {
      s.core.hp.temp = 5;
    },
  ],
  [
    "slots used",
    (s) => {
      at(sc(s).slots, 0).used = 1;
    },
  ],
  [
    "prepared",
    (s) => {
      at(sc(s).spells, 0).prepared = true;
    },
  ],
  [
    "uses",
    (s) => {
      (at(s.core.features, 0).uses as { used: number }).used = 1;
    },
  ],
  [
    "hit dice used",
    (s) => {
      at(s.core.hitDice, 0).used = 2;
    },
  ],
  [
    "death saves",
    (s) => {
      s.core.deathSaves.failures = 1;
    },
  ],
  [
    "conditions",
    (s) => {
      s.core.conditions = ["prone"];
    },
  ],
  [
    "exhaustion",
    (s) => {
      s.core.exhaustion = 1;
    },
  ],
  [
    "inspiration",
    (s) => {
      s.core.inspiration = true;
    },
  ],
  [
    "inventory quantity",
    (s) => {
      at(s.core.inventory, 0).qty = 3;
    },
  ],
  [
    "currency",
    (s) => {
      s.core.currency.gp = 12;
    },
  ],
  [
    "notes",
    (s) => {
      s.core.notes = "owes the ferryman";
    },
  ],
  [
    "custom counter value",
    (s) => {
      (at(s.custom, 0) as { value: number }).value = 7;
    },
  ],
];
/** Edits that change the character (locked under "core"). */
const CORE: [string, (s: S) => void][] = [
  [
    "max HP",
    (s) => {
      s.core.hp.max = 50;
    },
  ],
  [
    "an ability score",
    (s) => {
      s.core.abilities.str = 18;
    },
  ],
  [
    "a proficiency",
    (s) => {
      s.core.skills = { athletics: { prof: "proficient" } };
    },
  ],
  [
    "AC",
    (s) => {
      s.core.ac.value = 20;
    },
  ],
  [
    "a speed",
    (s) => {
      s.core.speeds.walk = 35;
    },
  ],
  [
    "a feature",
    (s) => {
      s.core.features = [];
    },
  ],
  ["spells known", (s) => void sc(s).spells.push({ name: "Shield", level: 1, prepared: false })],
  [
    "an inventory item added",
    (s) => s.core.inventory.push({ name: "Rope", qty: 1, weight: 10, equipped: false, attuned: false }),
  ],
  ["a counter's max", (s) => ((s.custom[0] as { max: number }).max = 12)],
  ["a number block", (s) => ((s.custom[1] as { value: number }).value = 4)],
  [
    "an override",
    (s) => {
      s.core.overrides = { proficiencyBonus: 4 };
    },
  ],
];

describe("sheet locks (SPEC §8.10, AC-SHEET-05)", () => {
  it("unlocked: a player changes anything", () => {
    for (const [, f] of [...PLAY, ...CORE])
      expect(lockedChanges("unlocked", base(), edit(f), false)).toEqual([]);
  });
  it("core locked: exactly the play-state goes through; everything else is locked", () => {
    for (const [what, f] of PLAY) expect(lockedChanges("core", base(), edit(f), false), what).toEqual([]);
    for (const [what, f] of CORE)
      expect(lockedChanges("core", base(), edit(f), false).length, what).toBeGreaterThan(0);
  });
  it("fully locked: nothing, not even HP", () => {
    for (const [what, f] of [...PLAY, ...CORE])
      expect(lockedChanges("full", base(), edit(f), false).length, what).toBeGreaterThan(0);
  });
  it("DMs are never locked", () => {
    for (const [, f] of [...PLAY, ...CORE]) expect(lockedChanges("full", base(), edit(f), true)).toEqual([]);
  });
  it("a mixed edit reports only its locked part, with readable paths", () => {
    const after = edit((s) => {
      s.core.hp.current = 20;
      s.core.abilities.str = 18;
    });
    const locked = lockedChanges("core", base(), after, false);
    expect(locked.map((c) => pathLabel(c.path))).toEqual(["core.abilities.str"]);
    expect(locked[0]).toMatchObject({ before: 16, after: 18 });
  });
});

describe("proposals", () => {
  it("apply only their own changes onto the sheet as it is now", () => {
    const proposal = diffSheet(
      base(),
      edit((s) => (s.core.abilities.str = 18)),
    );
    // Meanwhile the sheet moved on (HP spent).
    const now = edit((s) => (s.core.hp.current = 12));
    const applied = applyChanges(now, proposal);
    expect(applied.core.abilities.str).toBe(18);
    expect(applied.core.hp.current).toBe(12);
    // The original is untouched.
    expect(now.core.abilities.str).toBe(16);
  });
  it("an added or removed list entry is one change of the whole list", () => {
    const d = diffSheet(
      base(),
      edit((s) =>
        s.core.inventory.push({ name: "Rope", qty: 1, weight: 10, equipped: false, attuned: false }),
      ),
    );
    expect(d.map((c) => pathLabel(c.path))).toEqual(["core.inventory"]);
  });
});
