import { describe, expect, it } from "vitest";
import { CONDITION_IDS, MARKER_IDS } from "../constants.ts";
import {
  attackHints,
  CONDITIONS,
  dodgeHolds,
  effectiveSpeed,
  expandConditions,
  hintedMode,
  immuneToCondition,
  incapacitates,
  MARKERS,
  rollHints,
  statusName,
  statusSummary,
} from "./conditions.ts";

describe("conditions and markers (SPEC §8.11, §19.3, §34.1)", () => {
  it("every one of the 15 conditions and every marker has a name and a one-line summary; conditions a page", () => {
    for (const id of CONDITION_IDS) {
      expect(CONDITIONS[id].name, id).toMatch(/^[A-Z]/);
      expect(CONDITIONS[id].summary.length, id).toBeGreaterThan(20);
      expect(CONDITIONS[id].summary, id).not.toMatch(/\n/);
      expect(CONDITIONS[id].page, id).toMatch(/^\d/);
    }
    for (const id of MARKER_IDS) {
      expect(MARKERS[id].name, id).toMatch(/^[A-Z]/);
      expect(MARKERS[id].summary.length, id).toBeGreaterThan(3);
    }
    // Names are unique across both lists (a picker is searchable by name).
    const names = [
      ...CONDITION_IDS.map((i) => CONDITIONS[i].name),
      ...MARKER_IDS.map((i) => MARKERS[i].name),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(statusName("poisoned")).toBe("Poisoned");
    expect(statusName("inspiration")).toBe("Heroic Inspiration");
    expect(statusSummary("prone")).toMatch(/half its Speed/);
  });

  it("the §19.3 table: speed 0, incapacitated, no sight, automatic Str/Dex save failures", () => {
    const flags = (k: "speedZero" | "incapacitated" | "noSight" | "autoFailStrDex") =>
      CONDITION_IDS.filter((id) => CONDITIONS[id][k]).sort();
    expect(flags("speedZero")).toEqual(["grappled", "paralyzed", "petrified", "restrained", "unconscious"]);
    expect(flags("incapacitated")).toEqual([
      "incapacitated",
      "paralyzed",
      "petrified",
      "stunned",
      "unconscious",
    ]);
    expect(flags("noSight")).toEqual(["blinded", "unconscious"]);
    expect(flags("autoFailStrDex")).toEqual(["paralyzed", "petrified", "stunned", "unconscious"]);
    expect(incapacitates(["prone", "stunned"])).toBe(true);
    expect(incapacitates(["prone", "poisoned"])).toBe(false);
  });

  it("roll hints (AC-DICE-11): the roller's own conditions, each with its source", () => {
    expect(rollHints(["poisoned"], 0, "attack").dis.map((h) => h.from)).toEqual(["Poisoned"]);
    expect(rollHints(["poisoned"], 0, "check").dis.map((h) => h.from)).toEqual(["Poisoned"]);
    expect(rollHints(["poisoned"], 0, "save").dis).toEqual([]);
    expect(rollHints(["invisible"], 0, "attack").adv.map((h) => h.from)).toEqual(["Invisible"]);
    expect(rollHints(["invisible"], 0, "initiative").adv.map((h) => h.from)).toEqual(["Invisible"]);
    expect(rollHints(["incapacitated"], 0, "initiative").dis.map((h) => h.from)).toEqual(["Incapacitated"]);
    expect(rollHints(["frightened"], 0, "check").dis[0]).toEqual({
      from: "Frightened",
      note: "while the source is in sight",
    });
    expect(rollHints(["restrained"], 0, "save", "dex").dis.map((h) => h.from)).toEqual(["Restrained"]);
    expect(rollHints(["restrained"], 0, "save", "wis").dis).toEqual([]);
    expect(rollHints(["paralyzed"], 0, "save", "str").autoFail).toEqual(["Paralyzed"]);
    expect(rollHints(["paralyzed"], 0, "save", "con").autoFail).toEqual([]);
    expect(rollHints(["blinded", "prone"], 0, "attack").dis.map((h) => h.from)).toEqual(["Blinded", "Prone"]);
    // Exhaustion (5.2.1): −2 per level on every D20 Test.
    expect(rollHints([], 3, "save").penalty).toBe(-6);
    expect(rollHints([], 0, "attack").penalty).toBe(0);
    expect(rollHints([], 9, "check").penalty).toBe(-12);
  });

  it("advantage and disadvantage cancel, whatever their numbers", () => {
    expect(hintedMode({ adv: [{ from: "a" }], dis: [] })).toBe("adv");
    expect(hintedMode({ adv: [], dis: [{ from: "a" }, { from: "b" }] })).toBe("dis");
    expect(hintedMode({ adv: [{ from: "a" }, { from: "c" }], dis: [{ from: "b" }] })).toBe("normal");
    expect(hintedMode({ adv: [], dis: [] })).toBe("normal");
    expect(hintedMode(rollHints(["invisible", "poisoned"], 0, "attack"))).toBe("normal");
  });

  it("speed (§19.4): 0 with a speed-0 condition unless ignored; −5 ft per exhaustion level; never negative", () => {
    expect(effectiveSpeed(30, [], 0)).toBe(30);
    expect(effectiveSpeed(30, ["grappled"], 0)).toBe(0);
    expect(effectiveSpeed(30, ["grappled"], 0, true)).toBe(30);
    expect(effectiveSpeed(30, ["prone"], 0)).toBe(30);
    expect(effectiveSpeed(30, [], 2)).toBe(20);
    expect(effectiveSpeed(25, [], 6)).toBe(0);
    expect(effectiveSpeed(30, ["restrained"], 1, true)).toBe(25);
  });
});

describe("immunities conditions grant (rules audit A12)", () => {
  it("Petrified: immune to Poisoned — a Poisoned it had does nothing, one more can't be given; a stat block's own immunity", () => {
    expect(expandConditions(["poisoned", "petrified"]).sort()).toEqual(["incapacitated", "petrified"]);
    // A Petrified creature's own checks: no Poisoned disadvantage.
    expect(rollHints(["poisoned", "petrified"], 0, "check", "str").dis).toEqual([]);
    expect(immuneToCondition([], ["petrified"], "poisoned")).toBe("Petrified");
    expect(immuneToCondition(["poisoned"], [], "poisoned")).toBe("own");
    expect(immuneToCondition([], ["paralyzed"], "poisoned")).toBeNull();
    expect(immuneToCondition([], ["petrified"], "blinded")).toBeNull();
  });
});

describe("attackHints (the card's attack rolls, SRD 5.2.1 §19.3)", () => {
  const me = { conditions: [] as string[], exhaustion: 0 };
  const them = (conditions: string[], markers: string[] = [], outlined = false) => ({
    conditions,
    markers,
    outlined,
  });
  it("the target's conditions: Restrained, Stunned — advantage; Prone — advantage within 5 ft, disadvantage beyond", () => {
    expect(hintedMode(attackHints(me, them(["restrained"]), { withinFt: 30, melee: false }))).toBe("adv");
    expect(hintedMode(attackHints(me, them(["stunned"]), { withinFt: 30, melee: false }))).toBe("adv");
    expect(hintedMode(attackHints(me, them(["prone"]), { withinFt: 5, melee: true }))).toBe("adv");
    expect(hintedMode(attackHints(me, them(["prone"]), { withinFt: 30, melee: false }))).toBe("dis");
  });
  it("Invisible: disadvantage against it — none once it's outlined (Faerie Fire), which gives advantage; Dodging: disadvantage", () => {
    expect(hintedMode(attackHints(me, them(["invisible"]), { withinFt: 10, melee: false }))).toBe("dis");
    expect(hintedMode(attackHints(me, them(["invisible"], [], true), { withinFt: 10, melee: false }))).toBe(
      "adv",
    );
    expect(hintedMode(attackHints(me, them([], ["dodging"]), { withinFt: 10, melee: false }))).toBe("dis");
  });
  it("the attacker's own: Poisoned — disadvantage; with the target Restrained, they cancel; Exhaustion 2 — −4", () => {
    const h = attackHints({ conditions: ["poisoned"], exhaustion: 2 }, them(["restrained"]), {
      withinFt: 5,
      melee: true,
    });
    expect(hintedMode(h)).toBe("normal");
    expect(h.penalty).toBe(-4);
  });
  it("any hit from within 5 ft on a Paralyzed or Unconscious creature is a critical hit — melee or ranged; from farther, not", () => {
    expect(attackHints(me, them(["paralyzed"]), { withinFt: 5, melee: true }).critOnHit).toBe("Paralyzed");
    expect(attackHints(me, them(["unconscious"]), { withinFt: 5, melee: true }).critOnHit).toBe(
      "Unconscious",
    );
    // SRD 5.2.1 pp. 186, 191: "Any attack roll that hits you is a Critical Hit if the attacker is within 5 feet" — a
    // Fire Bolt or a crossbow from 5 ft too (rules audit A6; this once asserted the opposite).
    expect(attackHints(me, them(["paralyzed"]), { withinFt: 5, melee: false }).critOnHit).toBe("Paralyzed");
    expect(attackHints(me, them(["paralyzed"]), { withinFt: 10, melee: true }).critOnHit).toBeNull();
  });
  it("an Unconscious creature is Prone too: from 30 ft a shot at it is a plain roll; from 5 ft, advantage (rules audit A5)", () => {
    expect(hintedMode(attackHints(me, them(["unconscious"]), { withinFt: 30, melee: false }))).toBe("normal");
    expect(hintedMode(attackHints(me, them(["unconscious"]), { withinFt: 5, melee: true }))).toBe("adv");
    expect(expandConditions(["unconscious"]).sort()).toEqual(["incapacitated", "prone", "unconscious"]);
    // Its own initiative: disadvantage once (Incapacitated), not twice.
    expect(rollHints(["unconscious"], 0, "initiative").dis).toHaveLength(1);
  });
  it("Dodging: attacks at disadvantage and Dex saves at advantage — lost while Incapacitated or at Speed 0 (SRD 5.2.1 p. 181; rules audit A10)", () => {
    const shot = (conditions: string[], speedFt?: number) =>
      attackHints(
        me,
        { ...them(conditions, ["dodging"]), ...(speedFt !== undefined ? { speedFt } : {}) },
        { withinFt: 30, melee: false },
      ).dis.map((x) => x.from);
    expect(shot([])).toEqual(["target Dodging"]);
    // Incapacitated — or a condition that includes it (Stunned) — ends it; so do Grappled's Speed 0 and a Speed of 0.
    expect(shot(["incapacitated"])).toEqual([]);
    expect(shot(["grappled"])).toEqual([]);
    expect(shot([], 0)).toEqual([]);
    expect(shot([], 30)).toEqual(["target Dodging"]);
    expect(attackHints(me, them(["stunned"], ["dodging"]), { withinFt: 30, melee: false }).dis).toEqual([]);
    // Its Dexterity saves: advantage while it holds; none on another save, none once it lapses.
    const save = (ability: string, conditions: string[] = [], speedFt?: number) =>
      rollHints(conditions, 0, "save", ability, {
        markers: ["dodging"],
        ...(speedFt !== undefined ? { speedFt } : {}),
      }).adv.map((x) => x.from);
    expect(save("dex")).toEqual(["Dodging"]);
    expect(save("wis")).toEqual([]);
    expect(save("dex", ["restrained"])).toEqual([]);
    expect(save("dex", [], 0)).toEqual([]);
    expect(save("dex", ["incapacitated"])).toEqual([]);
    // Without the marker, nothing; the check itself.
    expect(rollHints([], 0, "save", "dex", { markers: [] }).adv).toEqual([]);
    expect(dodgeHolds({ conditions: ["unconscious"], markers: ["dodging"] })).toBe(false);
    expect(dodgeHolds({ conditions: ["poisoned"], markers: ["dodging"], speedFt: 5 })).toBe(true);
  });
});
