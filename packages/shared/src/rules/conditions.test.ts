import { describe, expect, it } from "vitest";
import { CONDITION_IDS, MARKER_IDS } from "../constants.ts";
import {
  acWithMarkers,
  attackHints,
  CONDITIONS,
  conditionInfo,
  conditionsBearing,
  dodgeHolds,
  effectiveSpeed,
  exhaustedHpMax,
  expandConditions,
  heldAtZero,
  hintedMode,
  immuneToCondition,
  incapacitates,
  MARKERS,
  reactionsBarredBy,
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

describe("SRD 5.1's variants (SPEC §19.3, §34.8; rules audit C2)", () => {
  const P51 = "srd-5.1";
  it("Stunned can't move; Grappled gives no Disadvantage on attacks; Incapacitated and Invisible nothing on initiative", () => {
    expect(conditionInfo("stunned", P51)?.speedZero).toBe(true);
    expect(conditionInfo("stunned")?.speedZero).toBe(false);
    expect(effectiveSpeed(30, ["stunned"], 0, false, P51)).toBe(0);
    expect(effectiveSpeed(30, ["stunned"], 0)).toBe(30);
    expect(rollHints(["grappled"], 0, "attack", undefined, undefined, P51).dis).toEqual([]);
    expect(rollHints(["grappled"], 0, "attack").dis).toHaveLength(1);
    expect(rollHints(["incapacitated"], 0, "initiative", undefined, undefined, P51).dis).toEqual([]);
    expect(rollHints(["invisible"], 0, "initiative", undefined, undefined, P51).adv).toEqual([]);
    expect(rollHints(["invisible"], 0, "attack", undefined, undefined, P51).adv).toHaveLength(1);
  });
  it("Exhaustion by its table: checks at a Disadvantage from 1, attacks and saves from 3; Speed halved from 2, 0 from 5; HP maximum halved from 4 — no −2 a level", () => {
    expect(rollHints([], 1, "check", "wis", undefined, P51)).toMatchObject({
      penalty: 0,
      dis: [{ from: "Exhaustion 1" }],
    });
    expect(rollHints([], 2, "save", "con", undefined, P51).dis).toEqual([]);
    expect(rollHints([], 3, "save", "con", undefined, P51).dis).toEqual([{ from: "Exhaustion 3" }]);
    expect(rollHints([], 3, "attack", undefined, undefined, P51).dis).toEqual([{ from: "Exhaustion 3" }]);
    expect(rollHints([], 2, "save", "con").penalty).toBe(-4);
    expect([1, 2, 4, 5].map((l) => effectiveSpeed(30, [], l, false, P51))).toEqual([30, 15, 15, 0]);
    expect(effectiveSpeed(30, [], 2)).toBe(20);
    expect(exhaustedHpMax(40, 4, P51)).toBe(20);
    expect(exhaustedHpMax(40, 3, P51)).toBe(40);
    expect(exhaustedHpMax(40, 4)).toBe(40);
  });
});

describe("conditions as they bear on the moment (rules audit C7)", () => {
  it("Grappled: nothing against its grappler; Frightened: nothing with the fear out of sight; no source known — as it is", () => {
    const grappled = [{ id: "grappled", sourceTokenId: "ogre" }];
    expect(conditionsBearing(grappled, { targetId: "ogre" })).toEqual([]);
    expect(conditionsBearing(grappled, { targetId: "goblin" })).toEqual(["grappled"]);
    // Held by two: the other's grip still counts against the first.
    expect(
      conditionsBearing([...grappled, { id: "grappled", sourceTokenId: "wolf" }], { targetId: "ogre" }),
    ).toEqual(["grappled"]);
    const afraid = [{ id: "frightened", sourceTokenId: "dragon" }, { id: "poisoned" }];
    expect(conditionsBearing(afraid, { sees: () => false })).toEqual(["poisoned"]);
    expect(conditionsBearing(afraid, { sees: () => true })).toEqual(["frightened", "poisoned"]);
    // Not known (a scene not in play), or no source recorded: it stands.
    expect(conditionsBearing(afraid, { sees: () => null })).toEqual(["frightened", "poisoned"]);
    expect(conditionsBearing([{ id: "frightened" }], { sees: () => false })).toEqual(["frightened"]);
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
  it("a ranged attack: Disadvantage with a hostile within 5 ft who sees it, and past the weapon's normal range (rules audit C6)", () => {
    const shot = (at: { closeHostiles?: string[]; beyondNormalRange?: boolean }, melee = false) =>
      attackHints(me, them([]), { withinFt: 30, melee, ...at }).dis.map((x) => x.from);
    expect(shot({ closeHostiles: ["Goblin"] })).toEqual(["Goblin within 5 ft"]);
    expect(shot({ beyondNormalRange: true })).toEqual(["long range"]);
    expect(shot({})).toEqual([]);
    // A melee attack: neither applies.
    expect(shot({ closeHostiles: ["Goblin"], beyondNormalRange: true }, true)).toEqual([]);
  });

  it("an outline that gives no Advantage (Starry Wisp): Invisible's Disadvantage gone, nothing added (rules audit 12)", () => {
    const wisp = { ...them(["invisible"], [], true), advantage: false };
    expect(attackHints(me, wisp, { withinFt: 10, melee: false })).toMatchObject({ adv: [], dis: [] });
    // Faerie Fire's (or the DM's mark): Advantage as well.
    expect(
      hintedMode(attackHints(me, { ...them([], [], true), advantage: true }, { withinFt: 10, melee: false })),
    ).toBe("adv");
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

describe("spell markers (rules audit Q6; SRD 5.2.1 pp. 112, 113, 139, 163)", () => {
  it("Blessed adds 1d4 to attack rolls and saving throws, Baned takes 1d4 off them — never checks or initiative", () => {
    const b = (kind: "attack" | "save" | "check" | "initiative", markers: string[]) =>
      rollHints([], 0, kind, kind === "save" ? "wis" : "str", { markers }).extra;
    expect(b("attack", ["blessed"])).toEqual([{ term: "+1d4", from: "Blessed" }]);
    expect(b("save", ["blessed"])).toEqual([{ term: "+1d4", from: "Blessed" }]);
    expect(b("save", ["baned"])).toEqual([{ term: "-1d4", from: "Baned" }]);
    expect(b("attack", ["blessed", "baned"]).map((x) => x.term)).toEqual(["+1d4", "-1d4"]);
    expect(b("check", ["blessed", "baned"])).toEqual([]);
    expect(b("initiative", ["blessed"])).toEqual([]);
    // No creature known: nothing added.
    expect(rollHints([], 0, "attack").extra).toEqual([]);
  });
  it("Hasted: Advantage on Dexterity saves; Slowed: −2 on them — other saves untouched", () => {
    const dex = rollHints([], 0, "save", "dex", { markers: ["hasted"] });
    expect(dex.adv).toEqual([{ from: "Hasted" }]);
    expect(dex.extra).toEqual([]);
    expect(rollHints([], 0, "save", "wis", { markers: ["hasted"] }).adv).toEqual([]);
    expect(rollHints([], 0, "save", "dex", { markers: ["slowed"] }).extra).toEqual([
      { term: "-2", from: "Slowed" },
    ]);
    expect(rollHints([], 0, "save", "con", { markers: ["slowed"] }).extra).toEqual([]);
    // Both: Advantage and −2, as each says.
    const both = rollHints([], 0, "save", "dex", { markers: ["hasted", "slowed"] });
    expect(hintedMode(both)).toBe("adv");
    expect(both.extra.map((x) => x.term)).toEqual(["-2"]);
  });
  it("an attacker's markers ride on its attack hints", () => {
    const h = attackHints(
      { conditions: [], exhaustion: 0, markers: ["blessed"] },
      { conditions: [], markers: [], outlined: false },
      { withinFt: 5, melee: true },
    );
    expect(h.extra).toEqual([{ term: "+1d4", from: "Blessed" }]);
  });
  it("AC: Hasted +2, Slowed −2 (both: as it was); reactions: none while Slowed", () => {
    expect(acWithMarkers(15, ["hasted"])).toBe(17);
    expect(acWithMarkers(15, ["slowed"])).toBe(13);
    expect(acWithMarkers(15, ["hasted", "slowed"])).toBe(15);
    expect(acWithMarkers(15, ["blessed"])).toBe(15);
    expect(reactionsBarredBy(["slowed"])).toBe("Slowed");
    expect(reactionsBarredBy(["hasted"])).toBeNull();
  });
  it("Speed: Hasted doubles it, Slowed halves it (rounded down), after Exhaustion; Haste's lethargy holds it at 0", () => {
    expect(effectiveSpeed(30, [], 0, false, undefined, ["hasted"])).toBe(60);
    expect(effectiveSpeed(30, [], 0, false, undefined, ["slowed"])).toBe(15);
    expect(effectiveSpeed(25, [], 0, false, undefined, ["slowed"])).toBe(12);
    expect(effectiveSpeed(30, [], 0, false, undefined, ["hasted", "slowed"])).toBe(30);
    // Exhaustion 2 (−10 ft) first, then doubled.
    expect(effectiveSpeed(30, [], 2, false, undefined, ["hasted"])).toBe(40);
    // A Speed-0 condition: still 0.
    expect(effectiveSpeed(30, ["grappled"], 0, false, undefined, ["hasted"])).toBe(0);
    // Haste's lethargy: Incapacitated (which alone leaves Speed) held at 0 while it lasts.
    const lethargy = [{ id: "incapacitated", speed0: true }];
    expect(heldAtZero(lethargy)).toBe(true);
    expect(effectiveSpeed(30, lethargy, 0)).toBe(0);
    expect(effectiveSpeed(30, ["incapacitated"], 0)).toBe(30);
    // The DM's "ignore condition speed" lets it move.
    expect(effectiveSpeed(30, lethargy, 0, true)).toBe(30);
  });
});
