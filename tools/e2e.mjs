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
// A chosen project runs as asked.
if (extra.some((a) => a.startsWith("--project"))) process.exit(pw(extra));
// The parallel journeys, then the timing journeys on their own (see playwright.config.ts) — for the full run and for
// chosen specs alike: run in one go, Playwright runs both projects at once, and a timing journey then measures its
// neighbour. Both parts always run; either failing fails the run. (Chosen specs may hold only one kind: an empty part
// passes, but nothing chosen at all fails.)
if (extra.length) {
  const listed = spawnSync(
    pnpm,
    ["exec", "playwright", "test", "-c", join("e2e", "playwright.config.ts"), "--list", ...extra],
    { cwd: ROOT, encoding: "utf8", shell: isWin },
  );
  const total = /Total: (\d+) tests?/.exec(listed.stdout ?? "");
  if (!total || Number(total[1]) === 0) {
    process.stderr.write(
      `${listed.stdout ?? ""}${listed.stderr ?? ""}\nNo journeys match: ${extra.join(" ")}\n`,
    );
    process.exit(1);
  }
}
const main = pw(["--project=chromium", "--pass-with-no-tests", ...extra], { E2E_PART: "main" });
const timing = pw(["--project=timing", "--pass-with-no-tests", ...extra], { E2E_PART: "timing" });
process.exit(main || timing);
