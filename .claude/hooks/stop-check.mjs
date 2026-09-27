#!/usr/bin/env node
// Stop hook (SPEC Appendix D): unless a stop hook is already active, runs `pnpm --silent check:fast` and
// `node tools/features-status.mjs --verify`. On failure prints the first 40 lines of errors to stderr and
// exits 2 so the turn continues and the errors get fixed. Node only; works on Windows, macOS and Linux.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function readStdin() {
  return new Promise((res) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => res(data));
    process.stdin.on("error", () => res(data));
  });
}

let input = {};
try {
  input = JSON.parse((await readStdin()) || "{}");
} catch {
  input = {};
}
if (input.stop_hook_active === true) process.exit(0);

const root = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const isWin = process.platform === "win32";

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    shell: isWin && cmd.endsWith(".cmd"),
    timeout: 280_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
}

const failures = [];
const check = run(isWin ? "pnpm.cmd" : "pnpm", ["--silent", "check:fast"]);
if (!check.ok) failures.push(["pnpm -s check:fast", check.out]);
const status = run(process.execPath, [resolve(root, "tools/features-status.mjs"), "--verify"]);
if (!status.ok) failures.push(["features-status --verify", status.out]);

if (failures.length > 0) {
  const lines = [];
  for (const [name, out] of failures) {
    lines.push(`✗ ${name} failed:`);
    lines.push(
      ...out
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .slice(0, 40),
    );
  }
  process.stderr.write(`${lines.slice(0, 40).join("\n")}\n`);
  process.exit(2);
}
process.exit(0);
