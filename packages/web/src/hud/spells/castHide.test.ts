import type { CastTargetView, CastView } from "@gloam/shared/protocol";
import { describe, expect, it } from "vitest";
import { asksOf, castHidden } from "./castHide.ts";

const row = (key: string, over: Partial<CastTargetView> = {}): CastTargetView =>
  ({ key, id: key, name: key, state: "in", conditions: [], times: 1, ...over }) as unknown as CastTargetView;

const card = (over: Partial<CastView> = {}): CastView =>
  ({
    id: "c1",
    kind: "spell",
    name: "Fire Bolt",
    targets: [row("g1")],
    can: { edit: false, roll: true, cancel: false },
    ...over,
  }) as unknown as CastView;

describe("a card its reader hid", () => {
  it("asks only what they may roll and haven't: attacks, their saves, damage", () => {
    const c = card({
      attack: { bonus: "+5" },
      damage: { formula: "1d10", types: ["fire"], healing: false, per: "target" },
    });
    expect(asksOf(c)).toEqual(["a:g1"]);
    const hit = card({
      ...c,
      targets: [row("g1", { attack: { total: 17, hit: true } })],
    });
    expect(asksOf(hit)).toEqual(["d:g1"]);
    expect(asksOf({ ...hit, can: { edit: false, roll: false, cancel: false } })).toEqual([]);
  });

  it("stays hidden while it asks nothing new, and comes back when it does", () => {
    const c = card({
      damage: {
        formula: "8d6",
        types: ["fire"],
        healing: false,
        per: "cast",
        roll: { total: 30, formula: "8d6" },
      },
    });
    const hidden = new Map([["c1", asksOf(c)]]);
    expect(castHidden(c, hidden)).toBe(true);
    // A save routed to their card: back on their screen.
    const asked = { ...c, targets: [row("g1", { save: { pending: true } as CastTargetView["save"] })] };
    expect(castHidden(asked, hidden)).toBe(false);
    // Another card, never hidden.
    expect(castHidden({ ...c, id: "c2" }, hidden)).toBe(false);
  });
});
