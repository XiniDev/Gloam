import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import type { Config } from "../config.ts";
import { type GloamServer, startServer } from "../server.ts";

export const FAKE_CLOUDFLARED = resolve(import.meta.dirname, "fixtures", "fake-cloudflared.mjs");

export interface TestServerOptions {
  env?: Record<string, string>;
  config?: Partial<Config>;
  /** "fake" (default): the fixture; "missing": a path that doesn't exist. */
  cloudflared?: "fake" | "missing";
  fakeEnv?: Record<string, string>;
  dataDir?: string;
}

export interface TestServer {
  server: GloamServer;
  url: string;
  dataDir: string;
  stop(opts?: { keepData?: boolean }): Promise<void>;
}

/** Starts Gloam in-process on a random port with a temp data dir (SPEC §4.4 integration tests). */
export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "gloam-test-"));
  const webDist = join(dataDir, "..", `${dataDir.split(/[\\/]/).pop()}-web`);
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<!doctype html><title>Gloam</title><div id=root></div>");
  const cloudflared =
    opts.cloudflared === "missing"
      ? { file: join(dataDir, "no-such-cloudflared.exe"), args: [] }
      : { file: process.execPath, args: [FAKE_CLOUDFLARED] };
  const server = await startServer({
    env: {
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      PORT: "0",
      LOG_LEVEL: "info",
      METRICS_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      ...opts.env,
    },
    config: {
      cloudflared,
      webDist,
      printBanner: false,
      consoleLog: false,
      tunnel: {
        backoffMs: [100, 200, 300],
        stopGraceMs: 1500,
        extraEnv: { FAKE_CF_LOG: join(dataDir, "fake-cf.log"), ...opts.fakeEnv },
      },
      ...opts.config,
    },
  });
  return {
    server,
    url: `http://localhost:${server.port}`,
    dataDir,
    async stop(o = {}) {
      await server.shutdown("test");
      if (!o.keepData) {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
        rmSync(webDist, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  };
}

/** A browser-like HTTP client: cookie jar, Origin header, CSRF double-submit header. */
export class Agent {
  readonly base: string;
  readonly cookies = new Map<string, string>();
  readonly headers: Record<string, string>;
  constructor(base: string, headers: Record<string, string> = {}) {
    this.base = base;
    this.headers = headers;
  }
  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  private store(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = (pair ?? "").indexOf("=");
      if (i < 0) continue;
      const k = (pair as string).slice(0, i).trim();
      const v = (pair as string).slice(i + 1).trim();
      if (v === "" || /expires=Thu, 01 Jan 1970/i.test(sc)) this.cookies.delete(k);
      else this.cookies.set(k, decodeURIComponent(v));
    }
  }
  async req(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<{
    status: number;
    json: { data?: unknown; error?: { code: string; message: string } } & Record<string, unknown>;
    res: Response;
  }> {
    const headers: Record<string, string> = { origin: this.base, ...this.headers, ...extra };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    const csrf = this.cookies.get("gloam_csrf");
    if (csrf) headers["x-gloam-csrf"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    this.store(res);
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { text };
    }
    return { status: res.status, json: json as never, res };
  }
  get(path: string, extra?: Record<string, string>) {
    return this.req("GET", path, undefined, extra);
  }
  post(path: string, body: unknown = {}, extra?: Record<string, string>) {
    return this.req("POST", path, body, extra);
  }
  patch(path: string, body: unknown = {}, extra?: Record<string, string>) {
    return this.req("PATCH", path, body, extra);
  }
  /** A Colyseus SDK client that presents this agent's cookies and Origin, like a browser would. */
  colyseus(): Client {
    return new Client(this.base, { headers: { cookie: this.cookieHeader(), origin: this.base } });
  }
}

/** First-run setup → returns an Admin agent signed in. */
export async function setupAdmin(t: TestServer, password = "correct horse battery staple"): Promise<Agent> {
  const admin = new Agent(t.url);
  const token = new URL(t.server.bootstrapLink).searchParams.get("token") ?? "";
  const r = await admin.post("/api/setup", { token, password });
  if (r.status !== 200) throw new Error(`setup failed: ${r.status} ${JSON.stringify(r.json)}`);
  return admin;
}

export async function createCampaign(admin: Agent, name = "Test Campaign"): Promise<string> {
  const r = await admin.post("/api/admin/campaigns", { name, select: true });
  if (r.status !== 200) throw new Error(`create campaign failed: ${JSON.stringify(r.json)}`);
  return (r.json.data as { id: string }).id;
}

export async function openTable(
  admin: Agent,
  mode: "local" | "lan" | "quick" | "named" = "local",
  extra: Record<string, unknown> = {},
): Promise<{ code: string; publicUrl: string; status: Record<string, unknown> }> {
  const r = await admin.post("/api/admin/table/open", { mode, ...extra });
  if (r.status !== 200) throw new Error(`open failed: ${r.status} ${JSON.stringify(r.json)}`);
  const d = r.json.data as { invite: { code: string }; publicUrl: string };
  return { code: d.invite.code, publicUrl: d.publicUrl, status: d as unknown as Record<string, unknown> };
}

export interface JoinedPlayer {
  agent: Agent;
  lobby: Room;
  userId: string;
  sessionId: string;
  messages: { type: string; payload: unknown; at: number }[];
}

/** Code step + identity step + waiting room (lobby room join). */
export async function joinAsNew(
  t: TestServer,
  code: string,
  name: string,
  opts: { pin?: string; color?: string; agent?: Agent; ip?: string } = {},
): Promise<JoinedPlayer> {
  const agent = opts.agent ?? new Agent(t.url, opts.ip ? {} : {});
  const c = await agent.post("/api/join/code", { code });
  if (c.status !== 200) throw new Error(`code failed: ${c.status} ${JSON.stringify(c.json)}`);
  const id = await agent.post("/api/join/identity", {
    mode: "new",
    name,
    color: opts.color ?? "amber",
    pin: opts.pin,
  });
  if (id.status !== 200) throw new Error(`identity failed: ${id.status} ${JSON.stringify(id.json)}`);
  return enterLobby(t, agent);
}

export async function enterLobby(t: TestServer, agent: Agent): Promise<JoinedPlayer> {
  const messages: JoinedPlayer["messages"] = [];
  const lobby = await agent.colyseus().joinById("lobby");
  lobby.onMessage("*", (type, payload) => messages.push({ type: String(type), payload, at: Date.now() }));
  const me = await agent.get("/api/me");
  const d = me.json.data as { user: { id: string } };
  const sessionId =
    [...t.server.ctx.sessions.liveForUser(d.user.id)].sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? "";
  return { agent, lobby, userId: d.user.id, sessionId, messages };
}

export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  timeoutMs = 3000,
  stepMs = 20,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
