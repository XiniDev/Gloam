import { describe, expect, it } from "vitest";
import { getPath, inverse, keysOverlap, type Op, setPath, touchedKeys } from "./ops.ts";

describe("ops", () => {
  it("inverts sets, creates, deletes, fog and sheet ops in reverse order", () => {
    const ops: Op[] = [
      { k: "create", e: "token", id: "tok_a", value: { id: "tok_a" } },
      { k: "set", e: "token", id: "tok_a", path: ["pos", "x"], value: 5, prev: 0 },
      {
        k: "fog",
        sceneId: "scn_1",
        layer: "reveal:all",
        rect: { x: 0, y: 0, w: 2, h: 2 },
        before: "A",
        after: "B",
      },
      {
        k: "sheet",
        actorId: "act_1",
        patch: [{ op: "replace", path: "/hp", value: 3 }],
        inverse: [{ op: "replace", path: "/hp", value: 7 }],
      },
      { k: "delete", e: "wall", id: "wal_1", prev: { id: "wal_1" } },
    ];
    const inv = inverse(ops);
    expect(inv.map((o) => o.k)).toEqual(["create", "sheet", "fog", "set", "delete"]);
    expect(inv[3]).toMatchObject({ value: 0, prev: 5 });
    expect(inv[2]).toMatchObject({ before: "B", after: "A" });
    expect(inverse(inv)).toEqual(ops);
  });

  it("sets and reads nested paths immutably", () => {
    const o = { a: { b: 1 } };
    const n = setPath(o, ["a", "c"], 2);
    expect(o).toEqual({ a: { b: 1 } });
    expect(n).toEqual({ a: { b: 1, c: 2 } });
    expect(getPath(n, ["a", "c"])).toBe(2);
    expect(setPath(n, ["a", "b"], undefined)).toEqual({ a: { c: 2 } });
  });

  it("detects overlapping keys by entity and path prefix", () => {
    const [k1] = touchedKeys([{ k: "set", e: "token", id: "t", path: ["stats"], value: 1, prev: 0 }]);
    const [k2] = touchedKeys([{ k: "set", e: "token", id: "t", path: ["stats", "hp"], value: 1, prev: 0 }]);
    const [k3] = touchedKeys([{ k: "set", e: "token", id: "t", path: ["pos"], value: 1, prev: 0 }]);
    const [k4] = touchedKeys([{ k: "delete", e: "token", id: "t", prev: {} }]);
    expect(keysOverlap(k1 as string, k2 as string)).toBe(true);
    expect(keysOverlap(k2 as string, k3 as string)).toBe(false);
    expect(keysOverlap(k4 as string, k3 as string)).toBe(true);
    const f = (x: number) =>
      touchedKeys([
        { k: "fog", sceneId: "s", layer: "reveal:all", rect: { x, y: 0, w: 4, h: 4 }, before: "", after: "" },
      ])[0] as string;
    expect(keysOverlap(f(0), f(2))).toBe(true);
    expect(keysOverlap(f(0), f(8))).toBe(false);
  });
});
