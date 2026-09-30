import { describe, expect, it } from "vitest";
import { SheetChangeIn } from "./protocol/commands.ts";
import { applyChanges } from "./rules/sheetLocks.ts";
import { applyPatch } from "./rules/sheetPatch.ts";

/** Whatever was tried, the shared prototype is untouched afterwards. */
function clean(): void {
  const probe = {} as Record<string, unknown>;
  for (const k of ["polluted", "shareVisionWith", "freeMovement", "cid"]) expect(probe[k], k).toBeUndefined();
}

describe("paths never reach Object.prototype (security review H1, SPEC §22)", () => {
  it("a sheet change naming __proto__, constructor or prototype is refused by its schema", () => {
    for (const path of [
      ["__proto__", "polluted"],
      ["constructor", "prototype", "polluted"],
      ["core", "prototype"],
    ])
      expect(SheetChangeIn.safeParse({ path, after: "yes" }).success, path.join(".")).toBe(false);
    expect(SheetChangeIn.safeParse({ path: ["core", "hp", "current"], after: 3 }).success).toBe(true);
  });

  it("applyChanges refuses such a path even when no schema stood in front of it, and changes nothing", () => {
    const sheet = { core: { hp: { current: 5 } } };
    for (const path of [
      ["__proto__", "polluted"],
      ["__proto__", "shareVisionWith"],
      ["constructor", "prototype", "freeMovement"],
    ])
      expect(() => applyChanges(sheet, [{ path, before: undefined, after: "yes" }])).toThrow(
        /can't be part of a path/,
      );
    clean();
    expect(sheet).toEqual({ core: { hp: { current: 5 } } });
    // An ordinary edit still works, and makes a new document.
    expect(
      applyChanges(sheet, [{ path: ["core", "hp", "current"], before: 5, after: 7 }]).core.hp.current,
    ).toBe(7);
  });

  it("applyPatch refuses such a pointer, and steps only through the document's own keys", () => {
    for (const path of ["/__proto__/polluted", "/constructor/prototype/cid"])
      expect(() => applyPatch({ a: 1 }, [{ op: "add", path, value: "yes" }])).toThrow(
        /can't be part of a path/,
      );
    clean();
    // "toString" is inherited by every object, not the document's: there's no such key to replace.
    expect(() => applyPatch({ a: 1 }, [{ op: "replace", path: "/toString", value: 1 }])).toThrow(
      /no \/toString/,
    );
    expect(applyPatch({ a: { b: 1 } }, [{ op: "replace", path: "/a/b", value: 2 }])).toEqual({ a: { b: 2 } });
  });
});
