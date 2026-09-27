#!/usr/bin/env node
// `pnpm test:e2e`: builds the test-mode web app (packages/web/dist-test, with test hooks), then runs the
// Playwright journeys. Extra arguments are passed to Playwright (e.g. a spec path or -g "name").
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
const pw = (args, env = {}) => {
  Object.assign(process.env, env);
  return run(["exec", "playwright", "test", "-c", join("e2e", "playwright.config.ts"), ...args]);
};
if (extra.length) process.exit(pw(extra));
// The full run: the parallel journeys, then the timing journeys on their own (see playwright.config.ts). Both always
// run; either failing fails the run.
const main = pw(["--project=chromium"], { E2E_PART: "main" });
const timing = pw(["--project=timing"], { E2E_PART: "timing" });
process.exit(main || timing);
