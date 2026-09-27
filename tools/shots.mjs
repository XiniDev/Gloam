#!/usr/bin/env node
// `pnpm shots`: builds the test-mode web app, then renders the key screens (e2e/shots/*.shots.ts) at the spec's
// three viewports into artifacts/screens/<phase>/<viewport>/. Extra arguments go to Playwright.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./features-lib.mjs";

const isWin = process.platform === "win32";
const pnpm = isWin ? "pnpm.cmd" : "pnpm";
const run = (args) => spawnSync(pnpm, args, { cwd: ROOT, stdio: "inherit", shell: isWin }).status ?? 1;
if (!process.argv.includes("--no-build")) {
  const b = run(["--filter", "@gloam/web", "build:test"]);
  if (b !== 0) process.exit(b);
}
const extra = process.argv.slice(2).filter((a) => a !== "--no-build");
process.exit(run(["exec", "playwright", "test", "-c", join("e2e", "shots.config.ts"), ...extra]));
