#!/usr/bin/env node
// `pnpm bench` part (SPEC §37; AC-PERF-01/04/05, AC-RSP-05): the client budgets on the benchmark scene, in headed
// Chromium on this machine's GPU (e2e/bench.config.ts) — headless WebGL is software-rendered and would measure the
// CPU's rasteriser. Builds the test bundle first (unless --no-build), runs e2e/bench/client.spec.ts, and prints its
// results (artifacts/bench/client.json) as one JSON line. Exits 1 when a budget is missed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./features-lib.mjs";

const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";
const run = (args) =>
  spawnSync(pnpm, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: isWin,
    timeout: 1_800_000,
    maxBuffer: 64 << 20,
  });

if (!process.argv.includes("--no-build")) {
  const b = run(["--filter", "@gloam/web", "build:test"]);
  if (b.status !== 0) {
    process.stderr.write(b.stderr || b.stdout || "build failed\n");
    process.exit(1);
  }
}
const out = join(ROOT, "artifacts", "bench", "client.json");
rmSync(out, { force: true });
const r = run(["exec", "playwright", "test", "-c", join("e2e", "bench.config.ts")]);
process.stderr.write(r.stdout ?? "");
const client = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { error: "no results" };
console.log(JSON.stringify({ client: { ...client, ok: r.status === 0 } }));
process.exit(r.status === 0 ? 0 : 1);
