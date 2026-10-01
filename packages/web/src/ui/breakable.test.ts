import { describe, expect, it } from "vitest";
import { breakPoints } from "./Breakable.tsx";

describe("where a path or URL may break (critic RSP-01 r1–r2)", () => {
  it("after each slash, never mid-word", () => {
    expect(breakPoints("packages/mcp/src/index.ts")).toEqual(["packages/", "mcp/", "src/", "index.ts"]);
  });
  it("never inside '//', and a scheme or a drive keeps to what follows it", () => {
    expect(breakPoints("https://creativecommons.org/licenses/by/4.0/legalcode")).toEqual([
      "https://creativecommons.org/",
      "licenses/",
      "by/",
      "4.0/",
      "legalcode",
    ]);
    expect(breakPoints("D:/Github/Gloam/packages")).toEqual(["D:/Github/", "Gloam/", "packages"]);
    expect(breakPoints("http://127.0.0.1:4747/mcp?x=1&y=2")).toEqual([
      "http://127.0.0.1:4747/",
      "mcp?",
      "x=",
      "1&",
      "y=",
      "2",
    ]);
  });
  it("keeps every character, in order", () => {
    const s = "https://www.dndbeyond.com/srd";
    expect(breakPoints(s).join("")).toBe(s);
  });
});
