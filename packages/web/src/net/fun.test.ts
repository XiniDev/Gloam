import { describe, expect, it } from "vitest";
import { logMarkdown } from "./fun.ts";

describe("the campaign log as Markdown (AC-FUN-05 export)", () => {
  it("heads each session, lists its entries with their times and authors, keeps a note's own lines", () => {
    const at = Date.UTC(2026, 8, 29, 19, 5);
    const md = logMarkdown("The Lantern Crypt", [
      {
        id: "log_1",
        sessionNo: 1,
        kind: "session.open",
        text: "Session 1 began.",
        userId: null,
        createdAt: at,
      },
      {
        id: "log_2",
        sessionNo: 1,
        kind: "manual",
        text: "We found the stair.\nDave kept the key.",
        userId: "usr_d",
        author: "Dave",
        createdAt: at + 60_000,
      },
      {
        id: "log_3",
        sessionNo: 2,
        kind: "scene",
        text: "The table moved to Flooded chamber.",
        userId: null,
        createdAt: at + 86_400_000,
      },
    ]);
    expect(md).toBe(
      [
        "# The Lantern Crypt — campaign log",
        "",
        "## Session 1",
        "",
        "- *2026-09-29 19:05*: Session 1 began.",
        "- *2026-09-29 19:06* — Dave: We found the stair.",
        "  Dave kept the key.",
        "",
        "## Session 2",
        "",
        "- *2026-09-30 19:05*: The table moved to Flooded chamber.",
        "",
      ].join("\n"),
    );
  });
});
