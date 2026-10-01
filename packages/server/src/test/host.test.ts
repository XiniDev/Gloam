import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Agent,
  createCampaign,
  FAKE_CLOUDFLARED,
  joinAsNew,
  openTable,
  setupAdmin,
  sleep,
  startTestServer,
  type TestServer,
  waitFor,
} from "./harness.ts";

const running: TestServer[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer(opts);
  running.push(t);
  return t;
}
afterEach(async () => {
  while (running.length) await running.pop()?.stop();
});

function fakeLog(t: TestServer): { argv: string[]; hasTunnelToken: boolean; pid: number }[] {
  const p = join(t.dataDir, "fake-cf.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { argv: string[]; hasTunnelToken: boolean; pid: number });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("F01 table lifecycle and the doorway (HOST)", () => {
  it("AC-HOST-01 first start prints a one-time local-only setup link that can't be reused", async () => {
    const t = await server();
    expect(t.server.bootstrapLink).toMatch(/\/setup\?token=[A-Za-z0-9_-]{20,}$/);
    const token = new URL(t.server.bootstrapLink).searchParams.get("token") ?? "";
    const a = new Agent(t.url);
    // Opening it from localhost works…
    expect((await a.get(`/setup?token=${token}`)).status).toBe(200);
    expect((await a.get(`/api/setup/status?token=${token}`)).json.data).toMatchObject({
      needed: true,
      tokenValid: true,
    });
    // …but the same request through Cloudflare is refused.
    expect((await a.get(`/setup?token=${token}`, { "cf-ray": "8a1b2c3d4e5f-LHR" })).status).toBe(403);
    expect((await a.get(`/setup?token=${token}`, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(403);
    const viaCf = await a.post(
      "/api/setup",
      { token, password: "a strong passphrase!" },
      { "cf-connecting-ip": "203.0.113.9" },
    );
    expect(viaCf.status).toBe(403);
    // Password shorter than 12 characters is refused.
    expect((await a.post("/api/setup", { token, password: "short" })).status).toBe(400);
    const ok = await a.post("/api/setup", { token, password: "a strong passphrase!" });
    expect(ok.status).toBe(200);
    expect(a.cookies.get("gloam_sid")).toBeTruthy();
    // The link can't be reused.
    const again = await new Agent(t.url).post("/api/setup", { token, password: "another passphrase!!" });
    expect(again.status).toBe(403);
    expect((await a.get("/api/me")).json.data).toMatchObject({
      authenticated: true,
      user: { isAdmin: true },
    });
  });

  it("AC-HOST-01 the terminal banner prints the one-time setup URL on first run (real process)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gloam-banner-"));
    const child = fork(resolve(import.meta.dirname, "..", "main.ts"), ["--production"], {
      env: { ...process.env, DATA_DIR: dataDir, PORT: "0", LOG_LEVEL: "warn" },
      execArgv: ["--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    try {
      await waitFor(() => out.includes("First-run setup"), 30_000, 100);
      expect(out).toMatch(/Local address\s+http:\/\/localhost:\d+/);
      expect(out).toMatch(/Table status\s+CLOSED/);
      expect(out).toMatch(/First-run setup\s+http:\/\/localhost:\d+\/setup\?token=[A-Za-z0-9_-]{20,}/);
      expect(out).toMatch(/one-time, 30 minutes, this PC only/);
    } finally {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);

  it("AC-HOST-02 binds 127.0.0.1 by default; LAN binds 0.0.0.0 only after confirmation, with a badge flag", async () => {
    const t = await server();
    expect(t.server.ctx.http.address().host).toBe("127.0.0.1");
    expect((t.server.ctx.http.server.address() as { address: string }).address).toBe("127.0.0.1");
    const admin = await setupAdmin(t);
    await createCampaign(admin);
    const refused = await admin.post("/api/admin/table/open", { mode: "lan" });
    expect(refused.status).toBe(400);
    expect(refused.json.error?.message).toMatch(/confirmation/i);
    expect((t.server.ctx.http.server.address() as { address: string }).address).toBe("127.0.0.1");
    const { status } = await openTable(admin, "lan", { confirmLan: true });
    expect((t.server.ctx.http.server.address() as { address: string }).address).toBe("0.0.0.0");
    expect(status).toMatchObject({ status: "open", mode: "lan", lanActive: true });
    expect(String(status.publicUrl)).toMatch(/^http:\/\/.+:\d+$/);
    await admin.post("/api/admin/table/close");
    expect((t.server.ctx.http.server.address() as { address: string }).address).toBe("127.0.0.1");
  });

  it("a rebind (LAN on, then off) keeps every connection already made: a browser's kept-alive socket serves its next request, never reset", async () => {
    const t = await server();
    const port = t.server.ctx.http.address().port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = () =>
      new Promise<{ status: number; reused: boolean }>((resolveGet, rejectGet) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/api/health", agent }, (res) => {
          res.resume();
          res.on("end", () => resolveGet({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
        });
        req.on("error", rejectGet);
      });
    try {
      expect((await get()).status).toBe(200);
      await t.server.ctx.http.rebind("0.0.0.0");
      expect((t.server.ctx.http.server.address() as { address: string }).address).toBe("0.0.0.0");
      // The same socket, idle across the rebind, answers.
      expect(await get()).toEqual({ status: 200, reused: true });
      await t.server.ctx.http.rebind("127.0.0.1");
      expect(await get()).toEqual({ status: 200, reused: true });
    } finally {
      agent.destroy();
    }
  });

  it("AC-HOST-03 quick tunnel: spawns cloudflared, gets the trycloudflare hostname, Open only after /ready", async () => {
    const t = await server({ fakeEnv: { FAKE_CF_READY_DELAY_MS: "1500" } });
    const admin = await setupAdmin(t);
    await createCampaign(admin);
    const t0 = Date.now();
    const opening = admin.post("/api/admin/table/open", { mode: "quick" });
    // While cloudflared is up but not ready, the table is still "opening".
    await waitFor(() => fakeLog(t).length > 0, 10_000);
    await sleep(500);
    expect(t.server.ctx.table.status).toBe("opening");
    const r = await opening;
    expect(r.status).toBe(200);
    const d = r.json.data as { status: string; publicUrl: string };
    expect(d.status).toBe("open");
    expect(d.publicUrl).toBe("https://calm-river-1234.trycloudflare.com");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
    expect(Date.now() - t0).toBeLessThan(30_000);
    const [spawn] = fakeLog(t);
    expect(spawn?.argv.slice(0, 2)).toEqual(["tunnel", "--no-autoupdate"]);
    expect(spawn?.argv).toContain("--url");
    expect(spawn?.argv[spawn.argv.indexOf("--url") + 1]).toBe(`http://127.0.0.1:${t.server.port}`);
    expect(spawn?.argv[spawn.argv.indexOf("--metrics") + 1]).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it("AC-HOST-04 close stops cloudflared, revokes codes, shows everyone the closed screen, writes a close snapshot", async () => {
    const t = await server();
    const admin = await setupAdmin(t);
    const campaignId = await createCampaign(admin);
    const { code } = await openTable(admin, "quick");
    const pid = fakeLog(t)[0]?.pid ?? 0;
    expect(alive(pid)).toBe(true);
    const inside = await joinAsNew(t, code, "Mira");
    await admin.post("/api/admin/table/knocks/decide", {
      sessionId: inside.sessionId,
      decision: "admitPlayer",
    });
    await waitFor(() => inside.messages.find((m) => m.type === "admitted"));
    await inside.agent.post("/api/join/enter");
    const room = await inside.agent.colyseus().joinById(campaignId);
    const roomMsgs: string[] = [];
    let roomLeft = false;
    room.onMessage("*", (type) => roomMsgs.push(String(type)));
    room.onLeave(() => {
      roomLeft = true;
    });
    const waiting = await joinAsNew(t, code, "Dave");
    let lobbyLeft = false;
    waiting.lobby.onLeave(() => {
      lobbyLeft = true;
    });
    const r = await admin.post("/api/admin/table/close");
    expect(r.status).toBe(200);
    expect((r.json.data as { status: string }).status).toBe("closed");
    await waitFor(() => roomLeft && lobbyLeft, 5000);
    expect(roomMsgs).toContain("table.closing");
    expect(waiting.messages.map((m) => m.type)).toContain("table.closing");
    await waitFor(() => !alive(pid), 8000);
    expect((await new Agent(t.url).post("/api/join/code", { code })).status).toBe(400);
    expect(t.server.ctx.invites.active()).toHaveLength(0);
    expect(t.server.ctx.snapshots.list(campaignId).some((s) => s.kind === "close")).toBe(true);
  });

  it("AC-HOST-05 Copy Discord message contains the public URL and the invite code", async () => {
    const t = await server();
    const admin = await setupAdmin(t);
    await createCampaign(admin);
    const { status } = await openTable(admin, "quick");
    const invite = status.invite as { display: string };
    expect(status.discordMessage).toBe(
      `🎲 The table is open! Join: https://calm-river-1234.trycloudflare.com — code ${invite.display} (works until the table closes)`,
    );
    expect(invite.display).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it("AC-HOST-06 with cloudflared missing, the Table page gets OS-specific install info; Local and LAN still work", async () => {
    const t = await server({ cloudflared: "missing" });
    const admin = await setupAdmin(t);
    await createCampaign(admin);
    const re = await admin.post("/api/admin/table/cloudflared/recheck");
    const cf = (re.json.data as { cloudflared: { installed: boolean; os: string } }).cloudflared;
    expect(cf.installed).toBe(false);
    expect(cf.os).toBe(process.platform);
    const quick = await admin.post("/api/admin/table/open", { mode: "quick" });
    expect(quick.status).toBe(400);
    expect(quick.json.error?.message).toMatch(/cloudflared isn't installed/);
    await openTable(admin, "local");
    await admin.post("/api/admin/table/close");
    await openTable(admin, "lan", { confirmLan: true });
    await admin.post("/api/admin/table/close");
  });

  it("AC-HOST-07 SIGINT/SIGTERM: graceful shutdown (clients notified, snapshot, tunnel stopped, DB closed) within 10 s", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gloam-sig-"));
    const logFile = join(dataDir, "fake-cf.log");
    const child: ChildProcess = fork(resolve(import.meta.dirname, "..", "main.ts"), ["--dev"], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATA_DIR: dataDir,
        PORT: "0",
        LOG_LEVEL: "info",
        CLOUDFLARED_PATH: process.execPath,
        GLOAM_TEST_CLOUDFLARED_SCRIPT: FAKE_CLOUDFLARED,
        FAKE_CF_LOG: logFile,
        METRICS_PORT: String(30000 + Math.floor(Math.random() * 5000)),
      },
      execArgv: ["--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let exitCode: number | null = null;
    let exitedAt = 0;
    child.on("exit", (c) => {
      exitCode = c;
      exitedAt = Date.now();
    });
    try {
      const ready = await new Promise<{ port: number; bootstrapLink: string }>((res) =>
        child.on("message", (m) => {
          const r = m as { type?: string; port: number; bootstrapLink: string };
          if (r.type === "gloam:ready") res(r);
        }),
      );
      const url = `http://localhost:${ready.port}`;
      const admin = new Agent(url);
      const token = new URL(ready.bootstrapLink).searchParams.get("token") ?? "";
      expect((await admin.post("/api/setup", { token, password: "a strong passphrase!" })).status).toBe(200);
      const campaign = await admin.post("/api/admin/campaigns", { name: "Sig", select: true });
      const campaignId = (campaign.json.data as { id: string }).id;
      const open = await admin.post("/api/admin/table/open", { mode: "quick" });
      expect(open.status).toBe(200);
      const code = (open.json.data as { invite: { code: string } }).invite.code;
      const pidCf = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n")[0] as string).pid as number;
      const player = new Agent(url);
      await player.post("/api/join/code", { code });
      await player.post("/api/join/identity", { mode: "new", name: "Dave", color: "sky" });
      const lobby = await player.colyseus().joinById("lobby");
      const got: string[] = [];
      lobby.onMessage("*", (type) => got.push(String(type)));
      await sleep(300);
      const t0 = Date.now();
      if (process.platform === "win32") child.send("SIGINT");
      else child.kill("SIGINT");
      await waitFor(() => exitCode !== null, 12_000, 50);
      expect(exitedAt - t0).toBeLessThan(10_000);
      expect(exitCode).toBe(0);
      expect(got).toContain("table.closing");
      await waitFor(() => !alive(pidCf), 5000);
      const snaps = readdirSync(join(dataDir, "snapshots", campaignId));
      expect(snaps.some((f) => f.endsWith("-close.json.gz"))).toBe(true);
      expect(snaps.some((f) => f.endsWith("-shutdown.json.gz"))).toBe(true);
      // DB closed cleanly: the WAL was checkpointed and the file can be opened exclusively.
      const logs = readdirSync(join(dataDir, "logs"))
        .map((f) => readFileSync(join(dataDir, "logs", f), "utf8"))
        .join("");
      expect(logs).toContain("shutdown complete");
    } finally {
      if (exitCode === null) child.kill("SIGKILL");
      await sleep(200);
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);

  it("AC-HOST-08 named tunnel: token only via TUNNEL_TOKEN, configured hostname, masked after saving, never logged", async () => {
    const t = await server();
    const admin = await setupAdmin(t);
    await createCampaign(admin);
    const token = "eyJhIjoiZGVhZGJlZWYiLCJ0IjoiY2FmZWJhYmUiLCJzIjoiMTIzNDU2Nzg5MCJ9TOPSECRET";
    // Saving the token is local-only.
    const remote = await admin.patch("/api/admin/settings", { tunnelToken: token }, { "cf-ray": "abc" });
    expect(remote.status).toBe(403);
    const saved = await admin.patch("/api/admin/settings", {
      tunnelToken: token,
      publicHostname: "table.example.com",
    });
    expect(saved.status).toBe(200);
    const masked = (saved.json.data as { tunnelToken: string }).tunnelToken;
    expect(masked).not.toBe(token);
    expect(masked).not.toContain("TOPSECRET".slice(0, 6));
    expect(JSON.stringify((await admin.get("/api/admin/settings")).json)).not.toContain(token);
    const { status } = await openTable(admin, "named");
    expect(status.publicUrl).toBe("https://table.example.com");
    const [spawn] = fakeLog(t);
    expect(spawn?.hasTunnelToken).toBe(true);
    expect(spawn?.argv).toContain("run");
    expect(spawn?.argv.join(" ")).not.toContain(token);
    await admin.post("/api/admin/table/close");
    const logs = readdirSync(join(t.dataDir, "logs"))
      .map((f) => readFileSync(join(t.dataDir, "logs", f), "utf8"))
      .join("");
    expect(logs).not.toContain(token);
    const db = readFileSync(join(t.dataDir, "gloam.db"));
    expect(db.includes(Buffer.from(token))).toBe(false);
  });

  it("AC-HOST-09 a crashed cloudflared is restarted up to 3 times, shows reconnecting, and highlights a changed hostname", async () => {
    const t = await server();
    Object.assign(t.server.ctx.config.tunnel.extraEnv ?? {}, { FAKE_CF_HOSTNAME_RANDOM: "1" });
    const admin = await setupAdmin(t);
    await createCampaign(admin);
    const { status } = await openTable(admin, "quick");
    const firstUrl = status.publicUrl as string;
    const statuses: string[] = [];
    t.server.ctx.table.on("status", (s: { status: string }) => statuses.push(s.status));
    // Crash the running cloudflared.
    const pid = fakeLog(t)[0]?.pid ?? 0;
    process.kill(pid, "SIGKILL");
    await waitFor(() => statuses.includes("reconnecting"), 5000);
    await waitFor(() => t.server.ctx.table.dto().doorway.status === "up" && fakeLog(t).length >= 2, 10_000);
    const dto = t.server.ctx.table.dto();
    expect(dto.status).toBe("open");
    expect(dto.doorway.hostnameChanged).toBe(true);
    expect(dto.publicUrl).not.toBe(firstUrl);
    expect(dto.discordMessage).toContain(dto.publicUrl as string);
    // Keep crashing: after 3 consecutive restarts it gives up.
    Object.assign(t.server.ctx.config.tunnel.extraEnv ?? {}, { FAKE_CF_CRASH_AFTER_MS: "900" });
    for (let i = 0; i < 3; i++) {
      const last = fakeLog(t).at(-1)?.pid ?? 0;
      if (alive(last)) process.kill(last, "SIGKILL");
      await sleep(1500);
    }
    await waitFor(() => t.server.ctx.tunnel.state.status === "failed", 15_000, 100);
    expect(fakeLog(t).length).toBeLessThanOrEqual(2 + 3 + 1);
    expect(t.server.ctx.tunnel.state.error).toMatch(/3 attempts/);
  }, 60_000);
});
