import { resolve } from "node:path";
import { DEFAULT_METRICS_PORT, DEFAULT_PORT } from "@gloam/shared";
import { z } from "zod";

/** Environment configuration (SPEC §11, Appendix J), validated at startup. */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(DEFAULT_PORT),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATA_DIR: z.string().min(1).default("./data"),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_METRICS_PORT),
  CLOUDFLARED_PATH: z.string().min(1).default("cloudflared"),
  PUBLIC_URL: z.url().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  GLOAM_TEST_SEED: z.coerce.number().int().min(0).max(0xffffffff).optional(),
  /** Test builds only: run CLOUDFLARED_PATH with this script as its first argument (the fake cloudflared). */
  GLOAM_TEST_CLOUDFLARED_SCRIPT: z.string().optional(),
  /** Test builds only: serve this built SPA (the test-mode build with test hooks) instead of packages/web/dist. */
  GLOAM_TEST_WEB_DIST: z.string().optional(),
});

export type NodeEnv = "development" | "production" | "test";

/** How to launch cloudflared. Tests substitute a Node script; production uses the binary on PATH. */
export interface CloudflaredCommand {
  file: string;
  args: string[];
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  metricsPort: number;
  cloudflared: CloudflaredCommand;
  publicUrl: string | undefined;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  nodeEnv: NodeEnv;
  /** Seeded dice only when NODE_ENV=test (SPEC §18.2, AC-DICE-10); production ignores the variable. */
  testSeed: number | undefined;
  /** Serve the built SPA from here in production; dev mode uses Vite middleware instead. */
  webRoot: string;
  webDist: string;
  /** Print to the console (disabled in tests). */
  printBanner: boolean;
  /** Log to the console as well as the daily file. */
  consoleLog: boolean;
  /** Tunnel supervision timings and child env (tests shorten backoff and pass fixture knobs). */
  tunnel: {
    backoffMs?: number[];
    extraEnv?: NodeJS.ProcessEnv;
    stopGraceMs?: number;
    hostnameTimeoutMs?: number;
    readyTimeoutMs?: number;
  };
  /** Interval between automatic snapshots while the table is open (SPEC §20.3: 10 minutes). */
  autoSnapshotMs: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: resolve(e.DATA_DIR),
    metricsPort: e.METRICS_PORT,
    cloudflared: {
      file: e.CLOUDFLARED_PATH,
      args: e.NODE_ENV === "test" && e.GLOAM_TEST_CLOUDFLARED_SCRIPT ? [e.GLOAM_TEST_CLOUDFLARED_SCRIPT] : [],
    },
    publicUrl: e.PUBLIC_URL,
    logLevel: e.LOG_LEVEL,
    nodeEnv: e.NODE_ENV,
    testSeed: e.NODE_ENV === "test" ? e.GLOAM_TEST_SEED : undefined,
    webRoot: resolve(repoRoot, "packages", "web"),
    webDist:
      e.NODE_ENV === "test" && e.GLOAM_TEST_WEB_DIST
        ? resolve(e.GLOAM_TEST_WEB_DIST)
        : resolve(repoRoot, "packages", "web", "dist"),
    printBanner: e.NODE_ENV !== "test",
    consoleLog: e.NODE_ENV !== "test",
    tunnel: {},
    autoSnapshotMs: 10 * 60_000,
    ...overrides,
  };
}
