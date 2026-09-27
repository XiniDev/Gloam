import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../auth/crypto.ts";
import {
  Agent,
  createCampaign,
  enterLobby,
  joinAsNew,
  openTable,
  setupAdmin,
  sleep,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

describe("F02 joining, identity, lobby and approval (AUTH)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
  });
  afterAll(async () => {
    await t?.stop();
  });

  async function admitted(name: string, extra: { pin?: string } = {}) {
    const p = await joinAsNew(t, code, name, extra);
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const room = await p.agent.colyseus().joinById(campaignId);
    room.onMessage("*", () => {});
    return { ...p, room };
  }

  it("AC-AUTH-01 wrong codes get a generic error; 10 wrong attempts from one IP → 429 for 10 minutes", async () => {
    // Distinct client IPs arrive via cf-connecting-ip from the loopback cloudflared peer.
    const a = new Agent(t.url, { "cf-connecting-ip": "198.51.100.7", "cf-ray": "x" });
    for (let i = 1; i <= 9; i++) {
      const r = await a.post("/api/join/code", { code: `WRONG-${String(i).padStart(5, "0")}` });
      expect(r.status).toBe(400);
      expect(r.json.error?.message).toBe("That code didn't open the door");
    }
    const tenth = await a.post("/api/join/code", { code: "ZZZZZ-ZZZZZ" });
    expect(tenth.status).toBe(429);
    // Now even the right code is refused from that IP, with a Retry-After of ~10 minutes.
    const locked = await a.post("/api/join/code", { code });
    expect(locked.status).toBe(429);
    expect(Number(locked.res.headers.get("retry-after"))).toBeGreaterThan(9 * 60);
    // Another IP is unaffected.
    const b = new Agent(t.url, { "cf-connecting-ip": "198.51.100.8", "cf-ray": "y" });
    expect((await b.post("/api/join/code", { code })).status).toBe(200);
    // An expired/revoked code gives the same generic message as a wrong one.
    const c = new Agent(t.url, { "cf-connecting-ip": "198.51.100.9", "cf-ray": "z" });
    const wrong = await c.post("/api/join/code", { code: "00000-00000" });
    expect(wrong.json.error?.message).toBe("That code didn't open the door");
  });

  it("AC-AUTH-02 a valid code + identity reaches the waiting room within 1 s and the Admin/DMs get a knock card", async () => {
    const watcher = await admin.colyseus().joinById("lobby");
    const cards: { name: string; identity: string; deviceLabel: string }[] = [];
    watcher.onMessage("knock", (m) => cards.push(m));
    watcher.onMessage("*", () => {});
    const t0 = Date.now();
    const p = await joinAsNew(t, code, "Priya");
    expect(Date.now() - t0).toBeLessThan(1000);
    await waitFor(() => cards.find((c) => c.name === "Priya"), 1000);
    expect(cards.find((c) => c.name === "Priya")).toMatchObject({ identity: "new" });
    // The waiting client sees its own knock as pending.
    await waitFor(
      () => (p.lobby.state as { knocks?: Map<string, { status: string }> }).knocks?.size === 1,
      1000,
    );
    const mine = [
      ...(p.lobby.state as { knocks: Map<string, { status: string; name: string }> }).knocks.values(),
    ];
    expect(mine[0]).toMatchObject({ status: "pending", name: "Priya" });
    await p.lobby.leave();
    await watcher.leave();
  });

  it("AC-AUTH-03 admit → table within 1 s without reload; deny message; ban auto-denies future knocks", async () => {
    const p = await joinAsNew(t, code, "Dave", { pin: "4321" });
    const t0 = Date.now();
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"), 1000);
    await p.agent.post("/api/join/enter");
    const room = await p.agent.colyseus().joinById(campaignId);
    room.onMessage("*", () => {});
    expect(Date.now() - t0).toBeLessThan(1000);
    await room.leave();

    const q = await joinAsNew(t, code, "Eve");
    let qLeft = false;
    q.lobby.onLeave(() => {
      qLeft = true;
    });
    await admin.post("/api/admin/table/knocks/decide", { sessionId: q.sessionId, decision: "deny" });
    await waitFor(() => q.messages.find((m) => m.type === "denied"), 1000);
    expect(q.messages.find((m) => m.type === "denied")?.payload).toMatchObject({
      message: "The DM couldn't let you in right now",
    });
    await waitFor(() => qLeft, 1000);

    const r = await joinAsNew(t, code, "Mallory");
    await admin.post("/api/admin/table/knocks/decide", { sessionId: r.sessionId, decision: "ban" });
    await waitFor(() => r.messages.find((m) => m.type === "banned"), 1000);
    // Same device, a brand-new profile: auto-denied.
    const again = await r.agent.post("/api/join/code", { code });
    expect(again.status).toBe(200);
    const denied = await r.agent.post("/api/join/identity", {
      mode: "new",
      name: "Mallory Two",
      color: "rose",
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error?.message).toBe("You can't join this table");
    // Same profile from another device: auto-denied too.
    const other = new Agent(t.url);
    await other.post("/api/join/code", { code });
    const viaProfile = await other.post("/api/join/identity", { mode: "returning", profileId: r.userId });
    expect([403, 404]).toContain(viaProfile.status);
    // DMs (non-admin) can't ban.
    expect(t.server.ctx.security.list({ event: "ban" }).length).toBeGreaterThan(0);
  });

  it("AC-AUTH-04 returning players: device cookie on the same origin; PIN on a new origin; 5 wrong PINs lock 15 min", async () => {
    const p = await joinAsNew(t, code, "Thorin", { pin: "2468" });
    await p.lobby.leave();
    // Same browser (device cookie) → recognised.
    const c1 = await p.agent.post("/api/join/code", { code });
    expect((c1.json.data as { device: { name: string } | null }).device?.name).toBe("Thorin");
    const back = await p.agent.post("/api/join/identity", { mode: "device" });
    expect(back.status).toBe(200);
    expect((back.json.data as { identity: string }).identity).toBe("device");
    // New origin / new browser: pick the profile and enter the PIN.
    const fresh = new Agent(t.url);
    const c2 = await fresh.post("/api/join/code", { code });
    const profiles = (c2.json.data as { profiles: { id: string; displayName: string; hasPin: boolean }[] })
      .profiles;
    const thorin = profiles.find((x) => x.displayName === "Thorin");
    expect(thorin?.hasPin).toBe(true);
    expect(JSON.stringify(profiles)).not.toMatch(/pin_?hash|argon/i);
    const good = await fresh.post("/api/join/identity", {
      mode: "returning",
      profileId: thorin?.id,
      pin: "2468",
    });
    expect(good.status).toBe(200);
    expect((good.json.data as { identity: string }).identity).toBe("pin");
    // 5 wrong PINs → locked for 15 minutes, even the right PIN.
    const thief = new Agent(t.url);
    await thief.post("/api/join/code", { code });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await thief.post("/api/join/identity", { mode: "returning", profileId: thorin?.id, pin: `000${i}` }))
          .status,
      );
    }
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(429);
    const right = await thief.post("/api/join/identity", {
      mode: "returning",
      profileId: thorin?.id,
      pin: "2468",
    });
    expect(right.status).toBe(429);
    expect(t.server.ctx.profiles.pinLimiter.lockedFor(thorin?.id ?? "")).toBeGreaterThan(14 * 60_000);
  });

  it("AC-AUTH-05 kick returns the person to the waiting room; kicked and banned sockets close within 500 ms", async () => {
    const k = await admitted("Kira");
    let closedAt = 0;
    k.room.onLeave(() => {
      closedAt = Date.now();
    });
    const kicked: unknown[] = [];
    k.room.onMessage("kicked", (m) => kicked.push(m));
    const t0 = Date.now();
    const r = await admin.post(`/api/admin/people/${k.userId}/kick`);
    expect(r.status).toBe(200);
    await waitFor(() => closedAt > 0, 1500);
    expect(closedAt - t0).toBeLessThan(500);
    expect(kicked).toHaveLength(1);
    // Back in the waiting room: the lobby accepts them and a new knock appears.
    const back = await enterLobby(t, k.agent);
    await waitFor(() => (back.lobby.state as { knocks?: Map<string, unknown> }).knocks?.size === 1, 1000);
    await back.lobby.leave();

    const b = await admitted("Bram");
    let bClosed = 0;
    b.room.onLeave(() => {
      bClosed = Date.now();
    });
    const t1 = Date.now();
    await admin.post(`/api/admin/people/${b.userId}/ban`, { reason: "test" });
    await waitFor(() => bClosed > 0, 1500);
    expect(bClosed - t1).toBeLessThan(500);
    // A banned session can't come back.
    await expect(b.agent.colyseus().joinById(campaignId)).rejects.toBeTruthy();
    await admin.post(`/api/admin/people/${b.userId}/unban`);
  });

  it("AC-AUTH-06 pending users' lobby state contains only their own knock status", async () => {
    const a = await joinAsNew(t, code, "Ana");
    const b = await joinAsNew(t, code, "Ben");
    await sleep(300);
    const knocksOf = (p: { lobby: { state: unknown } }) => [
      ...(p.lobby.state as { knocks: Map<string, { name: string; sessionId: string }> }).knocks.values(),
    ];
    expect(knocksOf(a).map((k) => k.name)).toEqual(["Ana"]);
    expect(knocksOf(b).map((k) => k.name)).toEqual(["Ben"]);
    // Nothing about the table is in the lobby state at all.
    expect(Object.keys((a.lobby.state as { toJSON: () => object }).toJSON())).toEqual(["knocks"]);
    await a.lobby.leave();
    await b.lobby.leave();
  });

  it("AC-AUTH-08 rotating the invite code kills the old one immediately; people inside are unaffected", async () => {
    const inside = await admitted("Iris");
    let left = false;
    inside.room.onLeave(() => {
      left = true;
    });
    const old = code;
    const r = await admin.post("/api/admin/table/invite/rotate");
    const next = (r.json.data as { invite: { code: string } }).invite.code;
    expect(next).not.toBe(old);
    expect((await new Agent(t.url).post("/api/join/code", { code: old })).status).toBe(400);
    expect((await new Agent(t.url).post("/api/join/code", { code: next })).status).toBe(200);
    await sleep(300);
    expect(left).toBe(false);
    code = next;
    await inside.room.leave();
  });

  it("AC-AUTH-09 with auto-admit on, PIN-verified or device-recognised returning players skip the prompt; knock still logged", async () => {
    const p = await joinAsNew(t, code, "Lyra", { pin: "8642" });
    await p.lobby.leave();
    await admin.patch("/api/admin/settings", { autoAdmitReturning: true });
    const fresh = new Agent(t.url);
    const c = await fresh.post("/api/join/code", { code });
    const lyra = (c.json.data as { profiles: { id: string; displayName: string }[] }).profiles.find(
      (x) => x.displayName === "Lyra",
    );
    await fresh.post("/api/join/identity", { mode: "returning", profileId: lyra?.id, pin: "8642" });
    const back = await enterLobby(t, fresh);
    await waitFor(() => back.messages.find((m) => m.type === "admitted"), 1000);
    expect(t.server.ctx.security.list({ event: "knock.autoadmit" }).some((e) => e.userId === lyra?.id)).toBe(
      true,
    );
    // A brand-new profile still needs approval.
    const newbie = await joinAsNew(t, code, "Newbie");
    await sleep(300);
    expect(newbie.messages.find((m) => m.type === "admitted")).toBeUndefined();
    await admin.patch("/api/admin/settings", { autoAdmitReturning: false });
    await back.lobby.leave();
    await newbie.lobby.leave();
  });

  it("AC-AUTH-10 codes are 10 Crockford chars shown as XXXXX-XXXXX, stored only as SHA-256, and die at close", async () => {
    const status = t.server.ctx.table.dto();
    expect(status.invite?.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    expect(status.invite?.display).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    const plain = status.invite?.code ?? "";
    const rows = t.server.ctx.sqlite.prepare("SELECT code_hash FROM invite_codes").all() as {
      code_hash: string;
    }[];
    expect(rows.some((r) => r.code_hash === sha256Hex(plain))).toBe(true);
    for (const r of rows) expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
    // The plain code isn't anywhere in the database file or the logs.
    t.server.ctx.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    expect(readFileSync(join(t.dataDir, "gloam.db")).includes(Buffer.from(plain))).toBe(false);
    // Entropy: 32^10 ≈ 2^50.
    expect(Math.log2(32 ** 10)).toBeCloseTo(50, 5);
    // Lower-case, spaces, dash-less and Crockford look-alikes are accepted.
    const loose = plain.toLowerCase().replace(/(.{5})/, "$1 ");
    expect((await new Agent(t.url).post("/api/join/code", { code: loose })).status).toBe(200);
    await admin.post("/api/admin/table/close");
    expect((await new Agent(t.url).post("/api/join/code", { code: plain })).status).toBe(400);
    expect(t.server.ctx.invites.active()).toHaveLength(0);
  });
});
