import { describe, expect, it } from "vitest";
import { detailText } from "./securityDetail.ts";

describe("the Security log's details in words (AC-ADM-04)", () => {
  it("says what happened, never a key and a raw value", () => {
    expect(detailText({ by: "u_1", as: "player", auto: false })).toBe("as a player");
    expect(detailText({ by: "u_1", as: "spectator", auto: true })).toBe("as a spectator · automatically");
    expect(detailText({ identity: "new" })).toBe("someone new");
    expect(detailText({ mode: "local", sessionNo: 1 })).toBe("Local only · session 1");
    expect(detailText({ via: "magic" })).toBe("with the host link");
    expect(detailText({ locked: false })).toBe("unlocked");
    expect(detailText({ by: "u_1", field: "role", role: "dm", campaignId: "c_1" })).toBe("role: DM");
    expect(detailText({ by: "u_1", reassigned: 2, to: "u_2" })).toBe("2 characters handed on");
    expect(detailText({ cleanup: { references: 0, files: 1 } })).toBe("cleaned up 1 file");
    expect(detailText({ status: 415, reason: "Not a picture", purpose: "map" })).toBe(
      "Not a picture · a map upload",
    );
  });
  it("shows a key it doesn't know as it is, and nothing for nothing", () => {
    expect(detailText({ newThing: 3 })).toBe("newThing: 3");
    expect(detailText({ by: "u_1" })).toBe("");
  });
});
