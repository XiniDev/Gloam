import { describe, expect, it } from "vitest";
import { can, controlsToken, isDm } from "./permissions.ts";

describe("permissions matrix (SPEC §6)", () => {
  it("gives the Admin everything the DM has plus admin-only actions", () => {
    for (const cap of [
      "scene.edit",
      "token.manage",
      "combat.manage",
      "history.revert",
      "actAs",
      "viewAs",
    ] as const) {
      expect(can("admin", cap)).toBe(true);
      expect(can("dm", cap)).toBe(true);
      expect(can("player", cap)).toBe(false);
    }
    for (const cap of ["table.open", "admin.manage", "role.assign"] as const) {
      expect(can("admin", cap)).toBe(true);
      expect(can("dm", cap)).toBe(false);
    }
  });

  it("lets DMs admit only while the setting is on", () => {
    expect(can("dm", "lobby.admit")).toBe(true);
    expect(can("dm", "lobby.admit", { dmsCanAdmit: false })).toBe(false);
    expect(can("admin", "lobby.admit", { dmsCanAdmit: false })).toBe(true);
    expect(can("player", "lobby.admit")).toBe(false);
  });

  it("keeps spectators to emotes/pings and pending users to character-art uploads", () => {
    expect(can("spectator", "social")).toBe(true);
    expect(can("spectator", "dice.roll")).toBe(false);
    expect(can("spectator", "token.moveOwn")).toBe(false);
    expect(can("pending", "upload")).toBe(true);
    expect(can("pending", "table.see")).toBe(false);
    expect(can(null, "table.see")).toBe(false);
  });

  it("makes player damage to others DM-grantable", () => {
    expect(can("player", "hp.applyOthers")).toBe(false);
    expect(can("player", "hp.applyOthers", { playerDamageDirect: true })).toBe(true);
  });

  it("resolves token control", () => {
    const tok = { ownerIds: ["usr_a"] };
    expect(controlsToken("player", "usr_a", tok)).toBe(true);
    expect(controlsToken("player", "usr_b", tok)).toBe(false);
    expect(controlsToken("dm", "usr_b", tok)).toBe(true);
    expect(controlsToken("spectator", "usr_a", tok)).toBe(false);
    expect(isDm("admin")).toBe(true);
  });
});
