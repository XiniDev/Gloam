import { describe, expect, it } from "vitest";
import { EMPTY_STATUS, type TokenStatusT } from "../schemas/entities.ts";
import {
  AT_ZERO_SOURCE,
  applyToStatus,
  type Consequence,
  damageConsequences,
  deathSave,
  healingConsequences,
  isBloodied,
} from "./consequences.ts";
import { applyDamage, applyHealing, type DamageTarget } from "./damage.ts";

const rules = { bloodied: true, npcAtZero: "dead" as const };
const pc = (o: Partial<DamageTarget> = {}): DamageTarget => ({
  hp: 20,
  hpMax: 40,
  hpTemp: 0,
  resistances: [],
  immunities: [],
  vulnerabilities: [],
  conditions: [],
  concentrating: false,
  isPC: true,
  ...o,
});
const status = (o: Partial<TokenStatusT> = {}): TokenStatusT => ({ ...EMPTY_STATUS, ...o });
const hit = (t: DamageTarget, amount: number, s = status(), crit = false) =>
  damageConsequences(
    { hp: t.hp, hpMax: t.hpMax, isPC: t.isPC, status: s },
    applyDamage(t, [{ amount, type: "untyped" }], { crit }),
    rules,
  );

describe("what damage brings (SPEC §8.11; AC-HP-06/07/09/10)", () => {
  it("a PC brought to 0 goes Unconscious and Prone and starts dying; concentration ends", () => {
    const c = hit(pc({ hp: 5 }), 9, status({ concentration: { spellName: "Bless" } }));
    expect(c).toContainEqual({ kind: "down", conditions: ["unconscious", "prone"] });
    expect(c).toContainEqual({ kind: "concentrationEnds", reason: "Unconscious" });
    expect(c.some((x) => x.kind === "dying")).toBe(false);
    const s = applyToStatus(status(), c[0] as Consequence);
    expect(s.conditions).toEqual([
      { id: "unconscious", source: AT_ZERO_SOURCE },
      { id: "prone", source: AT_ZERO_SOURCE },
    ]);
    expect(s.markers.map((m) => m.id)).toEqual(["deathsaves"]);
    expect(s.deathSaves).toEqual({ successes: 0, failures: 0, stable: false, dead: false });
  });

  it("an NPC brought to 0: the DM's choice, the campaign default preselected", () => {
    expect(hit(pc({ hp: 5, isPC: false }), 9)).toContainEqual({ kind: "npcAtZero", choice: "dead" });
    const unconscious = damageConsequences(
      { hp: 5, hpMax: 40, isPC: false, status: status() },
      applyDamage(pc({ hp: 5, isPC: false }), [{ amount: 9, type: "untyped" }]),
      { ...rules, npcAtZero: "unconscious" },
    );
    expect(unconscious).toContainEqual({ kind: "npcAtZero", choice: "unconscious" });
    const dead = applyToStatus(status(), { kind: "npcAtZero", choice: "dead" });
    expect(dead.markers.map((m) => m.id)).toContain("dead");
    expect(applyToStatus(status(), { kind: "npcAtZero", choice: "dead" }, "keep")).toEqual(status());
  });

  it("massive damage asks the DM: instant death?", () => {
    expect(hit(pc({ hp: 5, hpMax: 40 }), 45)).toContainEqual({ kind: "dying", reason: "massive" });
    expect(hit(pc({ hp: 5, hpMax: 40 }), 44).some((c) => c.kind === "dying")).toBe(false);
  });

  it("damage at 0: one failure, two from a crit; the third asks 'Mark dead?'", () => {
    const dying = status({ deathSaves: { successes: 1, failures: 1, stable: false, dead: false } });
    expect(hit(pc({ hp: 0 }), 3, dying)).toEqual([{ kind: "deathSaveFailures", n: 1, failures: 2 }]);
    expect(hit(pc({ hp: 0 }), 3, dying, true)).toEqual([
      { kind: "deathSaveFailures", n: 2, failures: 3 },
      { kind: "dying", reason: "failures" },
    ]);
    const s = applyToStatus(dying, { kind: "deathSaveFailures", n: 1, failures: 2 });
    expect(s.deathSaves?.failures).toBe(2);
    const dead = applyToStatus(s, { kind: "dying", reason: "failures" });
    expect(dead.deathSaves?.dead).toBe(true);
    expect(dead.markers.map((m) => m.id)).toEqual(["dead"]);
  });

  it("a concentrating creature hit (and still up) makes a save: DC max(10, half), 30 at most", () => {
    const s = status({ concentration: { spellName: "Bless" } });
    expect(hit(pc({ hp: 40 }), 12, s)).toContainEqual({ kind: "concentrationSave", dc: 10 });
    expect(hit(pc({ hp: 40, hpMax: 80 }), 30, s)).toContainEqual({ kind: "concentrationSave", dc: 15 });
    expect(hit(pc({ hp: 40 }), 12).some((c) => c.kind === "concentrationSave")).toBe(false);
  });

  it("Bloodied: on at half its HP or fewer, off above it or at 0 (AC-HP-06)", () => {
    expect(isBloodied(20, 40)).toBe(true);
    expect(isBloodied(21, 40)).toBe(false);
    expect(isBloodied(0, 40)).toBe(false);
    expect(hit(pc({ hp: 30 }), 10)).toContainEqual({ kind: "bloodied", on: true });
    expect(hit(pc({ hp: 30 }), 5).some((c) => c.kind === "bloodied")).toBe(false);
    expect(
      damageConsequences(
        { hp: 30, hpMax: 40, isPC: true, status: status() },
        applyDamage(pc({ hp: 30 }), [{ amount: 10, type: "untyped" }]),
        { ...rules, bloodied: false },
      ).some((c) => c.kind === "bloodied"),
    ).toBe(false);
    const healed = healingConsequences(
      { hp: 15, hpMax: 40, status: status() },
      applyHealing({ hp: 15, hpMax: 40 }, 10),
      rules,
    );
    expect(healed).toEqual([{ kind: "bloodied", on: false }]);
  });
});

describe("healing from 0 (AC-HP-02)", () => {
  it("brings the creature round: Unconscious from 0 HP off (Prone stays), death saves cleared", () => {
    const down = applyToStatus(status({ conditions: [{ id: "poisoned" }] }), {
      kind: "down",
      conditions: ["unconscious", "prone"],
    });
    const c = healingConsequences(
      { hp: 0, hpMax: 40, status: down },
      applyHealing({ hp: 0, hpMax: 40 }, 5),
      rules,
    );
    expect(c).toContainEqual({ kind: "revive" });
    const up = applyToStatus(down, { kind: "revive" });
    expect(up.conditions.map((x) => x.id)).toEqual(["poisoned", "prone"]);
    expect(up.deathSaves).toBeUndefined();
    expect(up.markers.map((m) => m.id)).toEqual([]);
  });
});

describe("death saving throws (§19.5; AC-HP-08's rules)", () => {
  it("DC 10; a natural 20 is back with 1 HP; a 1 is two failures; three of either decides", () => {
    expect(deathSave({ successes: 0, failures: 0 }, 12, 12)).toMatchObject({ successes: 1, failures: 0 });
    expect(deathSave({ successes: 0, failures: 0 }, 9, 9)).toMatchObject({ successes: 0, failures: 1 });
    expect(deathSave({ successes: 0, failures: 1 }, 1, 1)).toMatchObject({ failures: 3, dying: true });
    expect(deathSave({ successes: 2, failures: 2 }, 20, 20)).toEqual({
      successes: 0,
      failures: 0,
      regain: true,
      stable: false,
      dying: false,
    });
    expect(deathSave({ successes: 2, failures: 0 }, 14, 14)).toMatchObject({ successes: 3, stable: true });
    expect(deathSave({ successes: 0, failures: 2 }, 5, 5)).toMatchObject({ failures: 3, dying: true });
    // A bonus counts toward the DC (a natural 8 with +2 succeeds).
    expect(deathSave({ successes: 0, failures: 0 }, 8, 10)).toMatchObject({ successes: 1 });
  });
});
