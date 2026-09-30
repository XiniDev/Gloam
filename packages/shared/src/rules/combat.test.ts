import { describe, expect, it } from "vitest";
import {
  bonusMoveActive,
  type CombatantEntry,
  durationExpired,
  fixedInitiative,
  groupIdentical,
  initiativeFormula,
  initiativeHints,
  moveAfter,
  orderCombatants,
  remainingFt,
  roundsFrom,
  standUpCost,
  stepTurn,
  togglePip,
  turnBudget,
} from "./combat.ts";

const e = (
  tokenId: string,
  initiative: number | null,
  dexMod = 0,
  pc = false,
  name = tokenId,
): CombatantEntry => ({
  tokenId,
  name,
  initiative,
  dexMod,
  pc,
});
const ids = (xs: CombatantEntry[]) => xs.map((x) => x.tokenId);

describe("initiative (§19.5, AC-CMB-02)", () => {
  it("hints: Invisible gives advantage; Incapacitated — or a condition that includes it — and Surprised disadvantage", () => {
    expect(initiativeHints(["invisible"], false)).toEqual({ mode: "adv", adv: ["Invisible"], dis: [] });
    expect(initiativeHints(["incapacitated"], false).mode).toBe("dis");
    expect(initiativeHints(["stunned"], false).dis).toEqual(["Stunned"]);
    // SRD 5.1 (rules audit C2): nothing from Invisible or Incapacitated; its Exhaustion table's Disadvantage on checks.
    expect(initiativeHints(["invisible", "incapacitated"], false, "srd-5.1")).toEqual({
      mode: "normal",
      adv: [],
      dis: [],
    });
    expect(initiativeHints([], false, "srd-5.1", 1)).toEqual({ mode: "dis", adv: [], dis: ["Exhaustion 1"] });
    expect(initiativeHints([], true)).toEqual({ mode: "dis", adv: [], dis: ["Surprised"] });
    // Both: they cancel.
    expect(initiativeHints(["invisible"], true).mode).toBe("normal");
    // Initiative is a Dexterity check (SRD 5.2.1 p. 13): Poisoned's disadvantage on ability checks applies (rules audit
    // A7 — this once said "normal"); Frightened's too, with its condition.
    expect(initiativeHints(["poisoned"], false)).toMatchObject({ mode: "dis", dis: ["Poisoned"] });
    expect(initiativeHints(["frightened"], false).dis[0]).toMatch(/^Frightened/);
    // Unconscious: disadvantage once (it includes Incapacitated), not twice.
    expect(initiativeHints(["unconscious"], false).dis).toEqual(["Unconscious"]);
  });

  it("the roll and the fixed score (10 + mod, ±5 for advantage or disadvantage)", () => {
    expect(initiativeFormula(3, "normal")).toBe("1d20 + 3");
    expect(initiativeFormula(-1, "dis")).toBe("1d20 - 1 dis");
    expect(initiativeFormula(0, "adv")).toBe("1d20 adv");
    expect(fixedInitiative(3, "normal")).toBe(13);
    expect(fixedInitiative(3, "adv")).toBe(18);
    expect(fixedInitiative(-1, "dis")).toBe(4);
  });

  it("identical NPCs share a roll: one actor spawned unlinked, or the same name before its number (AC-CMB-03)", () => {
    const g = groupIdentical([
      { tokenId: "g1", actorId: "orc", linked: false, name: "Orc", dexMod: 1, pc: false },
      { tokenId: "g2", actorId: "orc", linked: false, name: "Orc", dexMod: 1, pc: false },
      { tokenId: "q1", actorId: null, linked: false, name: "Goblin 1", dexMod: 2, pc: false },
      { tokenId: "q2", actorId: null, linked: false, name: "Goblin 2", dexMod: 2, pc: false },
      { tokenId: "q3", actorId: null, linked: false, name: "Goblin 3", dexMod: 3, pc: false },
      { tokenId: "boss", actorId: "ogre", linked: false, name: "Ogre", dexMod: -1, pc: false },
      { tokenId: "pc1", actorId: "thorin", linked: true, name: "Thorin", dexMod: 0, pc: true },
      { tokenId: "pc2", actorId: "thorin", linked: true, name: "Thorin", dexMod: 0, pc: true },
    ]);
    expect(g.get("g1")).toBe(g.get("g2"));
    expect(g.get("q1")).toBe(g.get("q2"));
    expect(g.get("q1")).not.toBe(g.get("g1"));
    // A different Dex modifier isn't the same creature; one of a kind and PCs don't group.
    expect(g.has("q3")).toBe(false);
    expect(g.has("boss")).toBe(false);
    expect(g.has("pc1")).toBe(false);
  });
});

describe("the order (§8.12, AC-CMB-10)", () => {
  it("initiative descending; ties by Dex modifier, then PCs before NPCs, then name; the unrolled last by Dex", () => {
    const order = orderCombatants(
      [
        e("slow", 10, 0),
        e("quick", 10, 3),
        e("npc", 15, 1, false, "Bandit"),
        e("pc", 15, 1, true, "Zed"),
        e("aa", 12, 2, false, "Aa"),
        e("ab", 12, 2, false, "Ab"),
        e("late1", null, 1),
        e("late2", null, 4),
      ],
      "dexThenPcs",
    );
    expect(ids(order)).toEqual(["pc", "npc", "aa", "ab", "quick", "slow", "late2", "late1"]);
  });

  it("with ties left to the DM, tied creatures keep the order the DM gave them", () => {
    const order = orderCombatants([e("b", 12, 0), e("a", 12, 5), e("c", 18, 0)], "dm");
    expect(ids(order)).toEqual(["c", "b", "a"]);
  });

  it("turns cycle: the round goes up after the last and back before the first (never below round 1)", () => {
    expect(stepTurn({ index: 1, round: 1 }, 3, 1)).toEqual({ index: 2, round: 1 });
    expect(stepTurn({ index: 2, round: 1 }, 3, 1)).toEqual({ index: 0, round: 2 });
    expect(stepTurn({ index: 0, round: 2 }, 3, -1)).toEqual({ index: 2, round: 1 });
    expect(stepTurn({ index: 0, round: 1 }, 3, -1)).toEqual({ index: 0, round: 1 });
  });

  it("Delay moves a combatant to just after another", () => {
    const order = [e("a", 20), e("b", 15), e("c", 10)];
    expect(ids(moveAfter(order, "a", "c"))).toEqual(["b", "c", "a"]);
    expect(ids(moveAfter(order, "a", "b"))).toEqual(["b", "a", "c"]);
    expect(ids(moveAfter(order, "a", "zz"))).toEqual(["a", "b", "c"]);
  });
});

describe("movement budget (§19.4)", () => {
  it("speed × (1 + dashes) + bonus movement, the bonus never doubled by Dash (AC-MOV-09, AC-MOV-18)", () => {
    expect(turnBudget(30, 0, 0)).toBe(30);
    expect(turnBudget(30, 1, 0)).toBe(60);
    expect(turnBudget(30, 1, 10)).toBe(70);
    expect(turnBudget(0, 1, 10)).toBe(10);
    expect(remainingFt(30, 35)).toBe(0);
    expect(standUpCost(30)).toBe(15);
    expect(standUpCost(25)).toBe(12);
  });

  it("DM bonus movement lasts as set: this turn, N rounds, or until removed", () => {
    expect(bonusMoveActive({ ft: 10, until: "turn", untilRound: 3 }, 3)).toBe(true);
    expect(bonusMoveActive({ ft: 10, until: "turn", untilRound: 3 }, 4)).toBe(false);
    expect(bonusMoveActive({ ft: 10, until: "rounds", rounds: 2, untilRound: 4 }, 4)).toBe(true);
    expect(bonusMoveActive({ ft: 10, until: "rounds", rounds: 2, untilRound: 4 }, 5)).toBe(false);
    expect(bonusMoveActive({ ft: 10, until: "removed" }, 99)).toBe(true);
    expect(bonusMoveActive(undefined, 1)).toBe(false);
  });

  it("pips toggle", () => {
    expect(togglePip(0, "action")).toBe(1);
    expect(togglePip(togglePip(0, "reaction"), "reaction")).toBe(0);
  });
});

describe("durations in rounds from their creator's turn (AC-CMB-09)", () => {
  it("'until the start of your next turn' ends at the start of that turn, a round on", () => {
    const x = roundsFrom(2, "mira", 1);
    expect(x).toEqual({ round: 3, turnOf: "mira", when: "start" });
    expect(durationExpired(x, { round: 2, turnOf: "goblin", when: "end" })).toBe(false);
    expect(durationExpired(x, { round: 3, turnOf: "goblin", when: "start" })).toBe(false);
    expect(durationExpired(x, { round: 3, turnOf: "mira", when: "start" })).toBe(true);
    // Its creator gone from the combat: it runs out once that round is over.
    expect(durationExpired(x, { round: 4, turnOf: "goblin", when: "start" })).toBe(true);
  });

  it("an end-of-turn expiry waits for the end of that turn", () => {
    const x = { round: 2, turnOf: "mira", when: "end" as const };
    expect(durationExpired(x, { round: 2, turnOf: "mira", when: "start" })).toBe(false);
    expect(durationExpired(x, { round: 2, turnOf: "mira", when: "end" })).toBe(true);
  });
});
