import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lanAddress } from "../services/table.ts";
import {
  Agent,
  createCampaign,
  joinAsNew,
  openTable,
  setupAdmin,
  sleep,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

const PASSWORD = "correct horse battery staple";

describe("cross-cutting security (SEC)", () => {
  let t: TestServer;
  let admin: Agent;
  let campaignId: string;
  let code: string;
  const responses: string[] = [];

  beforeAll(async () => {
    t = await startTestServer();
    admin = await setupAdmin(t, PASSWORD);
    campaignId = await createCampaign(admin);
    code = (await openTable(admin, "local")).code;
  });
  afterAll(async () => {
    await t?.stop();
  });

  async function admittedPlayer(name: string, pin?: string) {
    const p = await joinAsNew(t, code, name, { pin });
    await admin.post("/api/admin/table/knocks/decide", { sessionId: p.sessionId, decision: "admitPlayer" });
    await waitFor(() => p.messages.find((m) => m.type === "admitted"));
    await p.agent.post("/api/join/enter");
    const room = await p.agent.colyseus().joinById(campaignId);
    room.onMessage("*", () => {});
    return { ...p, room };
  }

  it("AC-SEC-01 REST bodies and room messages are strictly validated; fuzzed input never reaches domain code", async () => {
    // Unknown keys are rejected.
    const extra = await admin.post("/api/admin/table/lock", { locked: true, evil: 1 });
    expect(extra.status).toBe(400);
    expect(extra.json.error?.code).toBe("INVALID");
    // Strings are length-capped, numbers range-checked.
    expect((await new Agent(t.url).post("/api/join/code", { code: "x".repeat(5000) })).status).toBe(400);
    expect((await admin.post("/api/admin/table/invite/policy", { maxUses: 1e9 })).status).toBe(400);
    expect((await admin.post("/api/admin/table/invite/policy", { maxUses: -5 })).status).toBe(400);
    expect((await admin.post("/api/admin/table/invite/policy", { maxUses: "12" })).status).toBe(400);
    expect((await admin.post("/api/admin/table/invite/policy", { maxUses: 2.5 })).status).toBe(400);
    // Fuzz every JSON endpoint with junk: never a 5xx. (Own admin session: the fuzz uses more than one
    // session's REST budget of 60 requests per 10 s, which is itself the limiter working.)
    const fuzz = new Agent(t.url);
    await fuzz.get(`/admin/magic?token=${t.server.ctx.admin.issueMagicToken()}`);
    const endpoints = [
      "/api/join/code",
      "/api/join/identity",
      "/api/admin/login",
      "/api/setup",
      "/api/admin/table/open",
      "/api/admin/table/lock",
      "/api/admin/table/invite/policy",
      "/api/admin/table/knocks/decide",
      "/api/admin/campaigns",
      "/api/client-log",
    ];
    const junk: unknown[] = [
      null,
      42,
      "str",
      [],
      [1, 2],
      {},
      { __proto__: { admin: true } },
      { constructor: { prototype: { x: 1 } } },
      { mode: { $ne: 1 } },
      { code: ["a"], name: 1e308 },
      { sessionId: "../../etc/passwd", decision: "admitPlayer" },
      { name: "\u0000\u202e", color: "amber", mode: "new" },
      { password: { toString: 1 } },
    ];
    for (const ep of endpoints) {
      for (const body of junk) {
        const r = await fuzz.post(ep, body);
        expect(r.status, `${ep} ${JSON.stringify(body)}`).toBeLessThan(500);
      }
    }
    // Malformed JSON.
    const raw = await fetch(`${t.url}/api/join/code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: t.url },
      body: "{not json",
    });
    expect(raw.status).toBe(400);
    // Room messages: unknown keys and wrong types → INVALID rejection, the socket stays open.
    const p = await admittedPlayer("Fuzz");
    let left = false;
    p.room.onLeave(() => {
      left = true;
    });
    for (const payload of [{ raised: "yes" }, { raised: true, extra: 1 }, "x", 7, [1]]) {
      await expect(p.room.request("hand.toggle", payload)).rejects.toMatchObject({
        reason: { code: "INVALID" },
      });
      await sleep(1100);
    }
    await expect(p.room.request("campaign.update", { name: 5 })).rejects.toMatchObject({
      reason: { code: expect.stringMatching(/INVALID|FORBIDDEN/) },
    });
    await expect(p.room.request("clock.sync", { t0: "now" })).rejects.toMatchObject({
      reason: { code: "INVALID" },
    });
    expect(left).toBe(false);
    await p.room.leave();
  }, 60_000);

  it("AC-SEC-02 cookie-authenticated state changes need a valid CSRF token and an allowed Origin", async () => {
    const good = await admin.post("/api/admin/table/lock", { locked: false });
    expect(good.status).toBe(200);
    const csrf = admin.cookies.get("gloam_csrf") ?? "";
    const headersBase = { "content-type": "application/json", cookie: admin.cookieHeader() };
    const post = (h: Record<string, string>) =>
      fetch(`${t.url}/api/admin/table/lock`, {
        method: "POST",
        headers: { ...headersBase, ...h },
        body: '{"locked":false}',
      });
    expect((await post({ origin: t.url })).status).toBe(403); // no CSRF header
    expect((await post({ origin: t.url, "x-gloam-csrf": "forged" })).status).toBe(403);
    expect((await post({ origin: "https://evil.example", "x-gloam-csrf": csrf })).status).toBe(403);
    expect((await post({ "x-gloam-csrf": csrf })).status).toBe(403); // missing Origin
    expect((await post({ origin: t.url, "x-gloam-csrf": csrf })).status).toBe(200);
    // A CSRF token from another session doesn't work.
    const other = await admittedPlayer("Csrf");
    const otherToken = other.agent.cookies.get("gloam_csrf") ?? "";
    expect((await post({ origin: t.url, "x-gloam-csrf": otherToken })).status).toBe(403);
    // Anonymous state changes (join) still need an allowed Origin.
    const x = await fetch(`${t.url}/api/join/code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ code }),
    });
    expect(x.status).toBe(403);
    // Room messages require an authenticated, admitted session.
    const pending = await joinAsNew(t, code, "Pending");
    await expect(pending.agent.colyseus().joinById(campaignId)).rejects.toBeTruthy();
    await expect(new Agent(t.url).colyseus().joinById(campaignId)).rejects.toBeTruthy();
    // Cross-origin matchmaking and WebSocket upgrades are refused (Colyseus routes bypass Express).
    const mm = await fetch(`${t.url}/matchmake/joinById/${campaignId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        cookie: admin.cookieHeader(),
      },
      body: "{}",
    });
    expect(mm.status).toBeGreaterThanOrEqual(400);
    expect(mm.headers.get("access-control-allow-origin")).toBeNull();
    await pending.lobby.leave();
    await other.room.leave();
  });

  it("AC-SEC-03 CSP and security headers on every response; cookie attributes as specified", async () => {
    const paths = ["/", "/api/me", "/api/does-not-exist", "/admin", "/join", "/api/health", "/setup"];
    for (const p of paths) {
      const r = await fetch(`${t.url}${p}`, { headers: { origin: t.url } });
      const csp = r.headers.get("content-security-policy") ?? "";
      for (const d of [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ]) {
        expect(csp, `${p}: ${d}`).toContain(d);
      }
      expect(csp).toMatch(new RegExp(`connect-src 'self' ws://localhost:${t.server.port}`));
      expect(csp).not.toContain("upgrade-insecure-requests");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(r.headers.get("permissions-policy")).toBe(
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      );
      expect(r.headers.get("strict-transport-security")).toBeNull(); // plain HTTP
      expect(r.headers.get("access-control-allow-origin")).toBeNull(); // Colyseus CORS reflection disabled
      responses.push(await r.text());
    }
    // HTTPS via the tunnel: HSTS is added and connect-src uses wss.
    // fetch() can't override Host, so speak raw HTTP like cloudflared does on loopback.
    const tunnel = await new Promise<{ headers: Record<string, string | string[] | undefined> }>((res, rej) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: t.server.port,
          path: "/api/me",
          headers: {
            "cf-ray": "x",
            "cf-connecting-ip": "203.0.113.1",
            "x-forwarded-proto": "https",
            host: "calm-river-1234.trycloudflare.com",
          },
        },
        (r) => {
          r.resume();
          res({ headers: r.headers });
        },
      );
      req.on("error", rej);
      req.end();
    });
    expect(tunnel.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(String(tunnel.headers["content-security-policy"])).toContain(
      "connect-src 'self' wss://calm-river-1234.trycloudflare.com",
    );
    // Cookies.
    const p = new Agent(t.url);
    const c = await p.post("/api/join/code", { code });
    expect(c.status).toBe(200);
    const id = await p.post("/api/join/identity", { mode: "new", name: "Cookie", color: "teal" });
    const set = id.res.headers.getSetCookie();
    const sid = set.find((s) => s.startsWith("gloam_sid=")) ?? "";
    const dev = set.find((s) => s.startsWith("gloam_dev=")) ?? "";
    const csrf = set.find((s) => s.startsWith("gloam_csrf=")) ?? "";
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/SameSite=Lax/i);
    expect(sid).toMatch(/Path=\//);
    expect(sid).not.toMatch(/Secure/i);
    expect(sid).toMatch(/Max-Age=2592000/); // 30 days (player)
    expect(dev).toMatch(/HttpOnly/i);
    expect(dev).toMatch(/Max-Age=34560000/); // 400 days
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/SameSite=Strict/i);
    // Over HTTPS (tunnel) cookies are Secure.
    const s = new Agent(t.url, {
      "cf-ray": "x",
      "cf-connecting-ip": "203.0.113.2",
      "x-forwarded-proto": "https",
    });
    const sc = await s.post("/api/join/code", { code });
    const joinCookie = sc.res.headers.getSetCookie().find((v) => v.startsWith("gloam_join=")) ?? "";
    expect(joinCookie).toMatch(/Secure/i);
    // Admin session: 7 days absolute.
    const token = t.server.ctx.admin.issueMagicToken();
    const m = await fetch(`${t.url}/admin/magic?token=${token}`, { redirect: "manual" });
    expect(m.headers.getSetCookie().find((v) => v.startsWith("gloam_sid="))).toMatch(/Max-Age=604800/);
  });

  it("AC-SEC-04 local-only endpoints refuse Cloudflare headers and non-loopback addresses", async () => {
    const cf = { "cf-connecting-ip": "203.0.113.5", "cf-ray": "abc" };
    const token = t.server.ctx.admin.issueMagicToken();
    expect(
      (await fetch(`${t.url}/admin/magic?token=${token}`, { headers: cf, redirect: "manual" })).status,
    ).toBe(403);
    expect(
      (await fetch(`${t.url}/setup?token=x`, { headers: { "cf-visitor": '{"scheme":"https"}' } })).status,
    ).toBe(403);
    expect((await fetch(`${t.url}/setup?token=x`, { headers: { "cf-ipcountry": "GB" } })).status).toBe(403);
    expect((await new Agent(t.url, cf).post("/api/admin/login", { password: PASSWORD })).status).toBe(403);
    expect((await admin.patch("/api/admin/settings", { port: 4999 }, cf)).status).toBe(403);
    expect((await admin.patch("/api/admin/settings", { cloudflaredPath: "C:/evil.exe" }, cf)).status).toBe(
      403,
    );
    // A non-loopback peer (LAN) is not local even without Cloudflare headers.
    const ip = lanAddress();
    if (ip) {
      await admin.post("/api/admin/table/close");
      await openTable(admin, "lan", { confirmLan: true });
      const lan = `http://${ip}:${t.server.port}`;
      const r = await fetch(`${lan}/setup?token=x`);
      expect(r.status).toBe(403);
      const login = await fetch(`${lan}/api/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: lan },
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(login.status).toBe(403);
      await admin.post("/api/admin/table/close");
      code = (await openTable(admin, "local")).code;
    }
    // "Allow admin login through the doorway" lifts only the login restriction.
    await admin.patch("/api/admin/settings", { allowAdminThroughDoorway: true });
    expect((await new Agent(t.url, cf).post("/api/admin/login", { password: PASSWORD })).status).toBe(200);
    await admin.patch("/api/admin/settings", { allowAdminThroughDoorway: false });
  });

  it("AC-SEC-05 room message rate limits disconnect abusers after a warning; per-IP limits protect auth", async () => {
    const p = await admittedPlayer("Spammer");
    let leftCode: number | undefined;
    p.room.onLeave((c) => {
      leftCode = c;
    });
    const toasts: unknown[] = [];
    p.room.onMessage("toast", (m) => toasts.push(m));
    const results: string[] = [];
    for (let burst = 0; burst < 4 && leftCode === undefined; burst++) {
      for (let i = 0; i < 4; i++) {
        p.room
          .request("hand.toggle", {})
          .then(() => results.push("ok"))
          .catch((e: { reason?: { code?: string } }) => results.push(e.reason?.code ?? "closed"));
      }
      await sleep(1200);
    }
    await waitFor(() => leftCode !== undefined, 5000);
    expect(results).toContain("RATE_LIMITED");
    expect(toasts.length).toBeGreaterThan(0);
    expect(leftCode).toBe(4029);
    expect(t.server.ctx.security.list({ event: "ws.ratelimited" }).length).toBeGreaterThan(0);
    // Admin login: 5 wrong per IP → 429.
    const a = new Agent(t.url);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await a.post("/api/admin/login", { password: `wrong-${i}` })).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  }, 30_000);

  it("AC-SEC-06 secrets never appear in logs, API responses or client state", async () => {
    const p = await admittedPlayer("Secretive", "97531");
    const tunnelToken = "eyJzZWNyZXQiOiJ0dW5uZWwiLCJ0IjoiMTIzNDUifQXYZZYSECRET";
    await admin.patch("/api/admin/settings", { tunnelToken, publicHostname: "t.example.com" });
    const secrets: Record<string, string> = {
      adminPassword: PASSWORD,
      pin: "97531",
      tunnelToken,
      adminSid: admin.cookies.get("gloam_sid") ?? "",
      playerSid: p.agent.cookies.get("gloam_sid") ?? "",
      device: p.agent.cookies.get("gloam_dev") ?? "",
      invite: code,
      secretKeyHex: readFileSync(join(t.dataDir, "secret.key")).toString("hex"),
      secretKeyB64: readFileSync(join(t.dataDir, "secret.key")).toString("base64"),
    };
    // Exercise many code paths that log.
    await admin.get("/api/admin/settings");
    await admin.get("/api/admin/people");
    await admin.get("/api/admin/security-log");
    await admin.get("/api/admin/table");
    await new Agent(t.url).post("/api/admin/login", { password: "wrong password" });
    t.server.ctx.snapshots.write(campaignId, "manual", "secret sweep");
    const apiBodies = [
      JSON.stringify((await admin.get("/api/admin/settings")).json),
      JSON.stringify((await admin.get("/api/admin/people")).json),
      JSON.stringify((await admin.get("/api/admin/security-log")).json),
      JSON.stringify((await p.agent.get("/api/me")).json),
      JSON.stringify((await admin.get("/api/me")).json),
      ...responses,
    ].join("\n");
    const stateJson = JSON.stringify(p.room.state);
    const logs = readdirSync(join(t.dataDir, "logs"))
      .map((f) => readFileSync(join(t.dataDir, "logs", f), "utf8"))
      .join("\n");
    const snapDir = join(t.dataDir, "snapshots", campaignId);
    const snaps = readdirSync(snapDir)
      .map((f) => gunzipSync(readFileSync(join(snapDir, f))).toString("utf8"))
      .join("\n");
    for (const [name, value] of Object.entries(secrets)) {
      if (!value) continue;
      const tableOpenInvite = name === "invite";
      expect(logs.includes(value), `${name} in logs`).toBe(false);
      expect(snaps.includes(value), `${name} in snapshots`).toBe(false);
      expect(stateJson.includes(value), `${name} in client state`).toBe(false);
      // The Admin console legitimately shows the current invite code to the Admin.
      if (!tableOpenInvite) expect(apiBodies.includes(value), `${name} in API responses`).toBe(false);
    }
    expect(logs).not.toMatch(/"(password|pin|token|code|cookie)":"[^[]/);
    await p.room.leave();
  });

  it("AC-SEC-08 the data directory and secret.key are owner-only", () => {
    const dir = t.dataDir;
    const key = join(t.dataDir, "secret.key");
    if (process.platform === "win32") {
      for (const target of [dir, key]) {
        const out = spawnSync("icacls", [target], { encoding: "utf8", windowsHide: true }).stdout;
        const aces = out
          .split(/\r?\n/)
          .slice(0, -2)
          .map((l) => l.replace(target, "").trim())
          .filter((l) => l.includes(":("));
        expect(aces.length, out).toBe(1);
        expect(aces[0]?.toLowerCase()).toContain(userInfo().username.toLowerCase());
        expect(aces[0]).toMatch(/\(F\)|\(OI\)\(CI\)\(F\)/);
      }
    } else {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(key).mode & 0o777).toBe(0o600);
    }
    expect(statSync(key).size).toBe(32);
  });
});
