import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CloudflaredCommand } from "../config.ts";
import type { Logger } from "../logger.ts";

export type TunnelKind = "quick" | "named";
export type TunnelStatus = "stopped" | "starting" | "up" | "reconnecting" | "failed";

export interface TunnelState {
  status: TunnelStatus;
  kind: TunnelKind | null;
  publicUrl: string | null;
  /** True after a restart produced a different quick-tunnel hostname (AC-HOST-09). */
  hostnameChanged: boolean;
  restarts: number;
  error: string | null;
}

export interface TunnelManagerOptions {
  command: CloudflaredCommand;
  localPort: () => number;
  preferredMetricsPort: number;
  log: Logger;
  /** Named tunnels: decrypted token (passed only via the child's TUNNEL_TOKEN) and public hostname. */
  namedToken: () => string | null;
  namedHostname: () => string | null;
  /** Timeouts, overridable by tests. */
  hostnameTimeoutMs?: number;
  readyTimeoutMs?: number;
  backoffMs?: number[];
  stopGraceMs?: number;
  /** Extra environment for the child (tests use this for fixture knobs). */
  extraEnv?: NodeJS.ProcessEnv;
}

const QUICK_HOST = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STABLE_MS = 60_000;

async function freeLoopbackPort(preferred: number): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number | null>((res) => {
      const srv = createServer();
      srv.once("error", () => res(null));
      srv.listen(p, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : null;
        srv.close(() => res(port));
      });
    });
  return (await tryPort(preferred)) ?? (await tryPort(0)) ?? preferred;
}

/**
 * Starts, supervises and stops `cloudflared` (SPEC §8.1, §22.1). Always spawned with fixed arguments and no
 * shell; the named-tunnel token only ever travels in the child's environment, never argv or logs.
 */
export class TunnelManager extends EventEmitter {
  private readonly opts: TunnelManagerOptions;
  private child: ChildProcess | null = null;
  private metricsPort = 0;
  private stderrTail: string[] = [];
  private stderrHost: string | null = null;
  private stopping = false;
  private superviseEpoch = 0;
  private lastQuickHost: string | null = null;
  /** Consecutive restarts; reset once the tunnel has stayed up for STABLE_MS. */
  private consecutive = 0;
  private upSince = 0;
  state: TunnelState = {
    status: "stopped",
    kind: null,
    publicUrl: null,
    hostnameChanged: false,
    restarts: 0,
    error: null,
  };

  constructor(opts: TunnelManagerOptions) {
    super();
    this.opts = opts;
  }

  private set(patch: Partial<TunnelState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  /** `cloudflared --version` (SPEC §8.1: install card when missing). */
  async checkInstalled(): Promise<{ installed: boolean; version: string | null }> {
    const { file, args } = this.opts.command;
    return new Promise((res) => {
      let out = "";
      let done = false;
      const finish = (v: { installed: boolean; version: string | null }) => {
        if (!done) {
          done = true;
          res(v);
        }
      };
      try {
        const c = spawn(file, [...args, "--version"], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        c.stdout?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        c.stderr?.on("data", (d: Buffer) => {
          out += d.toString();
        });
        c.once("error", () => finish({ installed: false, version: null }));
        c.once("exit", (code) => {
          const m = /version\s+([0-9][\w.-]*)/i.exec(out);
          finish(
            code === 0
              ? { installed: true, version: m?.[1] ?? out.trim().slice(0, 60) }
              : { installed: false, version: null },
          );
        });
        setTimeout(() => {
          c.kill();
          finish({ installed: false, version: null });
        }, 8000).unref();
      } catch {
        finish({ installed: false, version: null });
      }
    });
  }

  /** Quick tunnels refuse to start while ~/.cloudflared/config.yaml exists (SPEC §3). */
  configYamlPresent(): boolean {
    return (
      existsSync(join(homedir(), ".cloudflared", "config.yaml")) ||
      existsSync(join(homedir(), ".cloudflared", "config.yml"))
    );
  }

  private async metrics(path: string): Promise<{ status: number; body: string } | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.metricsPort}${path}`, {
        signal: AbortSignal.timeout(1500),
      });
      return { status: r.status, body: await r.text() };
    } catch {
      return null;
    }
  }

  private spawnChild(kind: TunnelKind): ChildProcess {
    const { file, args } = this.opts.command;
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.extraEnv };
    delete env.TUNNEL_TOKEN;
    const base = [...args, "tunnel", "--no-autoupdate"];
    let argv: string[];
    if (kind === "quick") {
      argv = [
        ...base,
        "--url",
        `http://127.0.0.1:${this.opts.localPort()}`,
        "--metrics",
        `127.0.0.1:${this.metricsPort}`,
      ];
    } else {
      const token = this.opts.namedToken();
      if (!token) throw new Error("No named-tunnel token is saved. Add it in Admin → Settings → Tunnel.");
      env.TUNNEL_TOKEN = token;
      argv = [...base, "--metrics", `127.0.0.1:${this.metricsPort}`, "run"];
    }
    this.stderrTail = [];
    this.stderrHost = null;
    const child = spawn(file, argv, {
      shell: false,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line.slice(0, 300));
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        const m = QUICK_HOST.exec(line);
        if (m) this.stderrHost = m[0];
      }
    };
    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    return child;
  }

  /** Spawns cloudflared and resolves with the public URL once the metrics `/ready` endpoint returns 200. */
  private async bringUp(kind: TunnelKind): Promise<string> {
    this.metricsPort = await freeLoopbackPort(this.opts.preferredMetricsPort);
    const child = this.spawnChild(kind);
    this.child = child;
    const exited = new Promise<string>((res) => {
      child.once("exit", (code) => res(`cloudflared exited (code ${code ?? "signal"})`));
      child.once("error", (e) => res(`cloudflared could not start: ${e.message}`));
    });
    let exitReason: string | null = null;
    void exited.then((r) => {
      exitReason = r;
    });
    const hostDeadline = Date.now() + (this.opts.hostnameTimeoutMs ?? 30_000);
    let publicUrl: string | null = null;
    if (kind === "named") {
      const host = this.opts.namedHostname();
      if (!host) throw new Error("No public hostname is configured for the named tunnel.");
      publicUrl = host.startsWith("http") ? host : `https://${host}`;
    }
    while (!publicUrl) {
      if (exitReason) throw new Error(`${exitReason}. ${this.stderrTail.slice(-3).join(" ")}`.trim());
      if (Date.now() > hostDeadline)
        throw new Error("cloudflared did not report a quick-tunnel address within 30 s.");
      const r = await this.metrics("/quicktunnel");
      if (r?.status === 200) {
        try {
          const h = (JSON.parse(r.body) as { hostname?: string }).hostname;
          if (h) publicUrl = `https://${h}`;
        } catch {
          // fall through to the stderr fallback
        }
      }
      if (!publicUrl && this.stderrHost) publicUrl = this.stderrHost;
      if (!publicUrl) await sleep(200);
    }
    const readyDeadline = Date.now() + (this.opts.readyTimeoutMs ?? 30_000);
    for (;;) {
      if (exitReason) throw new Error(`${exitReason}. ${this.stderrTail.slice(-3).join(" ")}`.trim());
      if (Date.now() > readyDeadline) throw new Error("cloudflared never became ready (metrics /ready).");
      const r = await this.metrics("/ready");
      if (r?.status === 200) break;
      await sleep(200);
    }
    return publicUrl;
  }

  async start(kind: TunnelKind): Promise<string> {
    if (this.child) await this.stop();
    this.stopping = false;
    this.lastQuickHost = null;
    this.set({ status: "starting", kind, publicUrl: null, hostnameChanged: false, restarts: 0, error: null });
    try {
      const url = await this.bringUp(kind);
      if (kind === "quick") this.lastQuickHost = url;
      this.consecutive = 0;
      this.upSince = Date.now();
      this.set({ status: "up", publicUrl: url });
      this.supervise(kind);
      return url;
    } catch (err) {
      await this.killChild();
      const message = err instanceof Error ? err.message : String(err);
      this.set({ status: "failed", error: message });
      throw err;
    }
  }

  /** Restarts cloudflared up to 3 times with 2 s / 5 s / 10 s backoff when it dies unexpectedly (AC-HOST-09). */
  private supervise(kind: TunnelKind): void {
    const epoch = ++this.superviseEpoch;
    const child = this.child;
    child?.once("exit", async () => {
      if (this.stopping || epoch !== this.superviseEpoch) return;
      this.child = null;
      const backoff = this.opts.backoffMs ?? [2000, 5000, 10000];
      if (Date.now() - this.upSince >= STABLE_MS) this.consecutive = 0;
      for (let attempt = this.consecutive; attempt < backoff.length; attempt++) {
        this.consecutive = attempt + 1;
        this.set({ status: "reconnecting", restarts: attempt + 1 });
        this.opts.log.warn({ attempt: attempt + 1 }, "cloudflared exited unexpectedly; restarting");
        await sleep(backoff[attempt] ?? 2000);
        if (this.stopping || epoch !== this.superviseEpoch) return;
        try {
          const url = await this.bringUp(kind);
          const changed = kind === "quick" && this.lastQuickHost !== null && url !== this.lastQuickHost;
          if (kind === "quick") this.lastQuickHost = url;
          this.upSince = Date.now();
          this.set({
            status: "up",
            publicUrl: url,
            hostnameChanged: changed || this.state.hostnameChanged,
            error: null,
          });
          if (changed) this.emit("hostnameChanged", url);
          this.supervise(kind);
          return;
        } catch (err) {
          await this.killChild();
          this.opts.log.warn({ err: (err as Error).message }, "cloudflared restart failed");
        }
      }
      this.set({ status: "failed", error: "The doorway could not be restarted after 3 attempts." });
    });
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    child.kill("SIGTERM");
    const grace = this.opts.stopGraceMs ?? 5000;
    const timedOut = await Promise.race([exited.then(() => false), sleep(grace).then(() => true)]);
    if (timedOut) {
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(2000)]);
    }
  }

  /** SIGTERM, then SIGKILL after 5 s (on Windows SIGTERM already terminates the process). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.superviseEpoch++;
    await this.killChild();
    this.set({
      status: "stopped",
      kind: null,
      publicUrl: null,
      hostnameChanged: false,
      restarts: 0,
      error: null,
    });
  }

  acknowledgeHostnameChange(): void {
    this.set({ hostnameChanged: false });
  }

  diagnostics(): string[] {
    return [...this.stderrTail];
  }
}
