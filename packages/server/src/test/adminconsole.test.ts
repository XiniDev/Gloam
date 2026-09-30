import type { Room } from "@colyseus/sdk";
import { type Capability, can } from "@gloam/shared/rules";
import { Table, type TableState } from "@gloam/shared/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SRD_ATTRIBUTION } from "../about/about.ts";
import {
  Agent,
  createCampaign,
  joinAsNew,
  openTable,
  rq,
  setupAdmin,
  sleep,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

type TableRoomClient = Room<unknown, TableState>;
const PASSWORD = "correct horse battery staple";
const CAPABILITIES: Capability[] = [
  "table.see",
  "table.open",
  "lobby.admit",
  "admin.manage",
  "role.assign",
  "scene.edit",
  "token.manage",
  "token.moveOwn",
  "token.moveAny",
  "door.use",
  "light.toggleOwn",
  "dice.roll",
  "dice.request",
  "sheet.editOwn",
  "sheet.editAny",
  "cast.own",
  "hp.applyOthers",
  "combat.manage",
  "turn.endOwn",
  "upload",
  "upload.approve",
  "homebrew.create",
  "homebrew.propose",
  "audio.control",
  "social",
  "undo.own",
  "history.revert",
  "actAs",
  "viewAs",
];

/**
 * The Admin console on the server (SPEC §8.20): people management (AC-ADM-02), the Admin's powers and session rules
 * (AC-ADM-03), the security log (AC-ADM-04), About & Credits (AC-ADM-05), the first-run checklist (AC-ADM-06), and the
 * campaigns, assets and content sections behind their pages (AC-ADM-01).
 */
describe("P12 — the Admin console on the server (ADM)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  const q = <T>(sql: string, ...a: unknown[]) => t.server.ctx.sqlite.prepare(sql).all(...a) as T[];

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t, PASSWORD);
  }, 60_000);
  afterAll(async () => {
    await t?.stop();
  });

  it("AC-ADM-06: the first-run checklist tracks its five steps and is done when all are", async () => {
    const steps = async () =>
      (await admin.get("/api/admin/checklist")).json.data as {
        steps: Record<string, boolean>;
        done: boolean;
      };
    let s = await steps();
    expect(s.steps).toEqual({
      password: true,
      cloudflared: expect.any(Boolean),
      campaign: false,
      map: false,
      tableOpened: false,
    });
    expect(s.done).toBe(false);
    campaignId = await createCampaign(admin);
    expect((await steps()).steps.campaign).toBe(true);
    const dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", () => {});
    await rq(dm, "scene.create", {
      name: "Crypt",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 40,
    });
    expect((await steps()).steps.map).toBe(true);
    await dm.leave();
    code = (await openTable(admin, "local")).code;
    s = await steps();
    expect(s.steps.tableOpened).toBe(true);
    // cloudflared: the one step a machine may not have — marked done when it's seen, as the doorway card does.
    t.server.ctx.settings.update({
      checklist: { ...t.server.ctx.settings.get().checklist, cloudflaredSeen: true },
    });
    s = await steps();
    expect(s.done).toBe(true);
  });

  it("AC-ADM-02: rename, PIN set and clear, a DM made (rejoining as one), kick, ban and unban, delete with the characters handed on", async () => {
    const dave = await joinAsNew(t, code, "Dave");
    await admin.post("/api/admin/table/knocks/decide", {
      sessionId: dave.sessionId,
      decision: "admitPlayer",
    });
    await waitFor(() => dave.messages.find((m) => m.type === "admitted"));
    await dave.agent.post("/api/join/enter");
    const room = (await dave.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    const left: number[] = [];
    room.onMessage("*", () => {});
    room.onLeave((c) => left.push(c));
    await waitFor(() => room.state.presence?.get(dave.userId));
    // Rename: the profile, and his place at the table at once.
    expect((await admin.patch(`/api/admin/people/${dave.userId}`, { name: "Davey" })).status).toBe(200);
    await waitFor(() => room.state.presence.get(dave.userId)?.name === "Davey");
    expect((await admin.patch(`/api/admin/people/${dave.userId}`, { name: "x" })).status).toBe(400);
    // PIN: set (4–8 digits), then it's what proves him from another browser; cleared, it's gone.
    expect((await admin.post(`/api/admin/people/${dave.userId}/pin`, { pin: "12" })).status).toBe(400);
    expect((await admin.post(`/api/admin/people/${dave.userId}/pin`, { pin: "4821" })).status).toBe(200);
    const other = new Agent(t.url);
    await other.post("/api/join/code", { code });
    expect(
      (await other.post("/api/join/identity", { mode: "returning", profileId: dave.userId, pin: "0000" }))
        .status,
    ).not.toBe(200);
    await sleep(50);
    const again = new Agent(t.url);
    await again.post("/api/join/code", { code });
    expect(
      (await again.post("/api/join/identity", { mode: "returning", profileId: dave.userId, pin: "4821" }))
        .status,
    ).toBe(200);
    expect(
      q<{ pin_hash: string | null }>("SELECT pin_hash FROM users WHERE id = ?", dave.userId)[0]?.pin_hash,
    ).toBeTruthy();
    await admin.post(`/api/admin/people/${dave.userId}/pin`, { pin: null });
    expect(
      q<{ pin_hash: string | null }>("SELECT pin_hash FROM users WHERE id = ?", dave.userId)[0]?.pin_hash,
    ).toBeNull();
    // Made a DM: he's sent to rejoin (4012), and rejoins as one.
    await admin.post(`/api/admin/people/${dave.userId}/role`, { campaignId, role: "dm" });
    await waitFor(() => left.includes(4012));
    expect(t.server.ctx.campaigns.membership(campaignId, dave.userId)).toBe("dm");
    const asDm = (await dave.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    asDm.onMessage("*", () => {});
    await waitFor(() => asDm.state.presence?.get(dave.userId)?.role === "dm");
    await admin.post(`/api/admin/people/${dave.userId}/role`, { campaignId, role: "player" });
    expect(t.server.ctx.campaigns.membership(campaignId, dave.userId)).toBe("player");
    // Kick, ban, unban (the people routes of P1, still here).
    const erin = await joinAsNew(t, code, "Erin");
    await admin.post("/api/admin/table/knocks/decide", {
      sessionId: erin.sessionId,
      decision: "admitPlayer",
    });
    await waitFor(() => erin.messages.find((m) => m.type === "admitted"));
    expect((await admin.post(`/api/admin/people/${erin.userId}/ban`, { reason: "test" })).status).toBe(200);
    expect(
      q<{ banned_at: number | null }>("SELECT banned_at FROM users WHERE id = ?", erin.userId)[0]?.banned_at,
    ).toBeTruthy();
    expect((await admin.post(`/api/admin/people/${erin.userId}/unban`)).status).toBe(200);
    expect(
      q<{ banned_at: number | null }>("SELECT banned_at FROM users WHERE id = ?", erin.userId)[0]?.banned_at,
    ).toBeNull();

    // Delete with reassignment: Dave's character (live campaign, through the bus) and one in another campaign (on
    // disk) go to Erin.
    const dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", () => {});
    const { actorId: mira } = await rq<{ actorId: string }>(dm, "actor.create", {
      kind: "character",
      ownerUserId: dave.userId,
      sheet: { core: { name: "Mira" } },
    });
    const otherCampaign = await unselected(admin, "Second campaign");
    const now = Date.now();
    t.server.ctx.sqlite
      .prepare(
        "INSERT INTO actors (id, campaign_id, kind, owner_user_id, lock_level, sheet_json, status_json, created_at, updated_at) VALUES (?, ?, 'character', ?, 'unlocked', ?, '{}', ?, ?)",
      )
      .run(
        "act_offline1",
        otherCampaign,
        dave.userId,
        JSON.stringify({ core: { name: "Offline Oona" } }),
        now,
        now,
      );
    t.server.ctx.campaigns.setMembership(otherCampaign, dave.userId, "player");
    const r = await admin.post(`/api/admin/people/${dave.userId}/delete`, { reassignTo: erin.userId });
    expect(r.status).toBe(200);
    expect((r.json.data as { reassigned: number }).reassigned).toBe(2);
    expect(
      q<{ owner_user_id: string }>("SELECT owner_user_id FROM actors WHERE id = ?", mira)[0]?.owner_user_id,
    ).toBe(erin.userId);
    expect(
      q<{ owner_user_id: string }>("SELECT owner_user_id FROM actors WHERE id = ?", "act_offline1")[0]
        ?.owner_user_id,
    ).toBe(erin.userId);
    // The live change went through the bus: the history has it.
    expect(
      q<{ type: string }>(
        "SELECT type FROM history WHERE campaign_id = ? AND type = 'actor.setOwner'",
        campaignId,
      ),
    ).toHaveLength(1);
    expect(
      q<{ deleted_at: number | null }>("SELECT deleted_at FROM users WHERE id = ?", dave.userId)[0]
        ?.deleted_at,
    ).toBeTruthy();
    expect(t.server.ctx.campaigns.membership(campaignId, dave.userId)).toBeNull();
    // Erin plays in the other campaign now (she was made a player there to take Oona).
    expect(t.server.ctx.campaigns.membership(otherCampaign, erin.userId)).toBe("player");
    // The Admin's own profile can't be deleted.
    const adminId = (t.server.ctx.profiles.admin() as { id: string }).id;
    expect((await admin.post(`/api/admin/people/${adminId}/delete`, { reassignTo: null })).status).toBe(403);
  });

  it("AC-ADM-03: the Admin has every DM power and the admin-only ones; sessions end after 12 h idle; login from the host PC only unless allowed", async () => {
    // Every capability a DM has, the Admin has; the Admin-only ones a DM doesn't.
    for (const cap of CAPABILITIES) if (can("dm", cap)) expect(can("admin", cap), cap).toBe(true);
    expect(can("dm", "admin.manage")).toBe(false);
    expect(can("admin", "admin.manage")).toBe(true);
    // 12 h idle: the session is refused.
    const fresh = await setupLogin(t);
    expect((await fresh.get("/api/admin/people")).status).toBe(200);
    t.server.ctx.sqlite
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE kind = 'admin'")
      .run(Date.now() - 12 * 3600_000 - 60_000);
    expect((await fresh.get("/api/admin/people")).status).toBe(401);
    // Through the doorway (Cloudflare headers) the login is refused unless the setting allows it.
    admin = await setupLogin(t);
    const cf = { "cf-connecting-ip": "203.0.113.9", "cf-ray": "abc" };
    expect((await new Agent(t.url, cf).post("/api/admin/login", { password: PASSWORD })).status).toBe(403);
    await admin.patch("/api/admin/settings", { allowAdminThroughDoorway: true });
    expect((await new Agent(t.url, cf).post("/api/admin/login", { password: PASSWORD })).status).toBe(200);
    await admin.patch("/api/admin/settings", { allowAdminThroughDoorway: false });
  });

  it("AC-ADM-04: the security log records logins and failures, knocks, admits and denials, kicks, bans, invite rotations and refused uploads — each with its time and IP", async () => {
    await new Agent(t.url).post("/api/admin/login", { password: "wrong password here" });
    const k = await joinAsNew(t, code, "Knocker");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: k.sessionId, decision: "deny" });
    const k2 = await joinAsNew(t, code, "Kicked");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: k2.sessionId, decision: "admitPlayer" });
    await waitFor(() => k2.messages.find((m) => m.type === "admitted"));
    await k2.agent.post("/api/join/enter");
    const kr = (await k2.agent.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    kr.onMessage("*", () => {});
    await admin.post(`/api/admin/people/${k2.userId}/kick`);
    await admin.post("/api/admin/table/invite/rotate");
    // A refused upload (not an image at all).
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: "image/png" }),
      "fake.png",
    );
    const up = await fetch(`${t.url}/api/assets?purpose=token`, {
      method: "POST",
      headers: {
        origin: t.url,
        cookie: admin.cookieHeader(),
        "x-gloam-csrf": admin.cookies.get("gloam_csrf") ?? "",
      },
      body: form,
    });
    expect(up.status).toBeGreaterThanOrEqual(400);
    const log = (await admin.get("/api/admin/security-log")).json.data as {
      event: string;
      ip: string | null;
      createdAt: number;
    }[];
    const kinds = new Set(log.map((e) => e.event));
    for (const e of [
      "admin.login",
      "admin.login.failed",
      "knock",
      "admit",
      "deny",
      "kick",
      "ban",
      "unban",
      "invite.rotate",
      "upload.rejected",
    ])
      expect(kinds.has(e), e).toBe(true);
    for (const e of log.filter((x) => x.event !== "csp.violation")) {
      expect(e.ip, `${e.event}'s IP`).toBeTruthy();
      expect(e.createdAt).toBeGreaterThan(0);
    }
    // Filtered by kind.
    const only = (await admin.get("/api/admin/security-log?event=upload.rejected")).json.data as {
      event: string;
    }[];
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((e) => e.event === "upload.rejected")).toBe(true);
  });

  it("AC-ADM-05: About & Credits carries the SRD 5.2.1 attribution word for word and the fonts' and libraries' licences", async () => {
    const a = (await admin.get("/api/admin/about")).json.data as {
      srd: { attribution: string; matches: boolean };
      fonts: { family: string; license: string; text: string }[];
      packages: { name: string; license: string }[];
      vendored: { name: string }[];
    };
    expect(a.srd.attribution).toBe(SRD_ATTRIBUTION);
    // The pack's ATTRIBUTION statement is the same words (Appendix I).
    expect(a.srd.matches).toBe(true);
    expect(a.fonts.map((f) => f.family).sort()).toEqual([
      "Alegreya Sans",
      "Cinzel",
      "Fraunces",
      "JetBrains Mono",
    ]);
    for (const f of a.fonts) expect(f.text).toMatch(/SIL Open Font License, Version 1\.1/);
    for (const name of ["three", "react", "colyseus", "zod"])
      expect(
        a.packages.some((p) => p.name.includes(name)),
        name,
      ).toBe(true);
    expect(a.vendored.some((v) => v.name === "ZzFX")).toBe(true);
    // Admin only.
    expect((await new Agent(t.url).get("/api/admin/about")).status).toBe(401);
  });

  it("AC-ADM-01 (server): campaigns renamed, archived and deleted by name; assets and content overviews; a campaign's packs", async () => {
    const c2 = await unselected(admin, "Doomed campaign");
    expect((await admin.patch(`/api/admin/campaigns/${c2}`, { name: "Renamed campaign" })).status).toBe(200);
    expect(t.server.ctx.campaigns.get(c2)?.name).toBe("Renamed campaign");
    await admin.patch(`/api/admin/campaigns/${c2}`, { archived: true });
    expect(t.server.ctx.campaigns.get(c2)?.archivedAt).toBeTruthy();
    expect((await admin.post(`/api/admin/campaigns/${c2}/delete`, { confirm: "wrong" })).status).toBe(400);
    expect(
      (await admin.post(`/api/admin/campaigns/${c2}/delete`, { confirm: "Renamed campaign" })).status,
    ).toBe(200);
    expect(t.server.ctx.campaigns.get(c2)).toBeUndefined();
    // The table's own campaign can't be deleted while the table is open.
    const name = t.server.ctx.campaigns.get(campaignId)?.name as string;
    expect((await admin.post(`/api/admin/campaigns/${campaignId}/delete`, { confirm: name })).status).toBe(
      409,
    );
    // Assets and content.
    const assets = (await admin.get("/api/admin/assets")).json.data as { files: number; diskBytes: number };
    expect(typeof assets.files).toBe("number");
    expect((await admin.post("/api/admin/assets/cleanup")).status).toBe(200);
    const content = (await admin.get("/api/admin/content")).json.data as {
      packs: { id: string; spells: number }[];
      campaigns: { id: string; packs: string[] }[];
    };
    expect(content.packs[0]?.spells).toBeGreaterThan(300);
    expect(content.campaigns.find((c) => c.id === campaignId)?.packs).toEqual(["srd-5.2.1"]);
    // The SRD pack off for the table's campaign: Fire Bolt can't be cast there; back on, it can.
    expect((await admin.post(`/api/admin/campaigns/${campaignId}/packs`, { packs: [] })).status).toBe(200);
    const dm = (await admin.colyseus().joinById(campaignId, {}, Table)) as unknown as TableRoomClient;
    dm.onMessage("*", () => {});
    const room = t.server.ctx.rooms.tables.get(campaignId) as unknown as {
      model: { campaign: { settings: { packs: string[] } } };
    };
    expect(room.model.campaign.settings.packs).toEqual([]);
    await admin.post(`/api/admin/campaigns/${campaignId}/packs`, { packs: ["srd-5.2.1"] });
    expect(room.model.campaign.settings.packs).toEqual(["srd-5.2.1"]);
  });
});

/** A fresh Admin login from the host PC. */
async function setupLogin(t: TestServer): Promise<Agent> {
  const a = new Agent(t.url);
  const r = await a.post("/api/admin/login", { password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

/** A campaign made without making it the table's (the table keeps running its own). */
async function unselected(admin: Agent, name: string): Promise<string> {
  const r = await admin.post("/api/admin/campaigns", { name });
  return (r.json.data as { id: string }).id;
}
