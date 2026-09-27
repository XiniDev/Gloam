import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE_CLOUDFLARED = join(
  ROOT,
  "packages",
  "server",
  "src",
  "test",
  "fixtures",
  "fake-cloudflared.mjs",
);
export const TEST_WEB_DIST = join(ROOT, "packages", "web", "dist-test");

export interface GloamProcess {
  url: string;
  port: number;
  bootstrapLink: string;
  dataDir: string;
  child: ChildProcess;
  fakeCloudflaredLog: () => { argv: string[]; pid: number }[];
  /** CSP reports the server received from any page (forwarded over IPC in test mode). */
  cspReports: string[];
  stop(): Promise<void>;
  /** Cuts a user's table connections abruptly, like a lost network (test builds only). */
  dropClient(userId: string): void;
}

/** Spawns a real Gloam server process for one test (SPEC §36.2: deterministic, fake cloudflared, seeded dice). */
export async function spawnServer(
  opts: { cloudflared?: "fake" | "missing"; env?: Record<string, string>; dataDir?: string } = {},
): Promise<GloamProcess> {
  if (!existsSync(join(TEST_WEB_DIST, "index.html"))) {
    throw new Error(
      "packages/web/dist-test is missing — run `pnpm --filter @gloam/web build:test` (pnpm test:e2e does this).",
    );
  }
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "gloam-e2e-"));
  const logFile = join(dataDir, "fake-cf.log");
  const child = fork(join(ROOT, "packages", "server", "src", "main.ts"), ["--dev"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      PORT: "0",
      LOG_LEVEL: "info",
      GLOAM_TEST_WEB_DIST: TEST_WEB_DIST,
      GLOAM_TEST_SEED: "20260927",
      METRICS_PORT: String(31000 + Math.floor(Math.random() * 8000)),
      FAKE_CF_LOG: logFile,
      ...(opts.cloudflared === "missing"
        ? { CLOUDFLARED_PATH: join(dataDir, "no-such-cloudflared.exe") }
        : { CLOUDFLARED_PATH: process.execPath, GLOAM_TEST_CLOUDFLARED_SCRIPT: FAKE_CLOUDFLARED }),
      ...opts.env,
    },
    execArgv: ["--disable-warning=ExperimentalWarning"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  const cspReports: string[] = [];
  child.on("message", (m) => {
    const r = m as { type?: string; directive?: string; blocked?: string; source?: string; sample?: string };
    if (r.type === "gloam:csp")
      cspReports.push(
        `${r.directive} blocked ${r.blocked || "(inline)"} at ${r.source} ${r.sample ?? ""}`.trim(),
      );
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const ready = await new Promise<{ port: number; bootstrapLink: string }>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start: ${stderr.slice(-2000)}`)), 45_000);
    child.on("message", (m) => {
      const r = m as { type?: string; port: number; bootstrapLink: string };
      if (r.type === "gloam:ready") {
        clearTimeout(t);
        res(r);
      }
    });
    child.once("exit", (code) => rej(new Error(`server exited (${code}): ${stderr.slice(-2000)}`)));
  });
  return {
    url: `http://localhost:${ready.port}`,
    port: ready.port,
    bootstrapLink: ready.bootstrapLink,
    dataDir,
    child,
    cspReports,
    fakeCloudflaredLog: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { argv: string[]; pid: number })
        : [],
    dropClient(userId: string) {
      child.send({ type: "gloam:drop", userId });
    },
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        if (process.platform === "win32") child.send("SIGTERM");
        else child.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 12_000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
