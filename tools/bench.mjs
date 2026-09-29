#!/usr/bin/env node
// `pnpm bench`: the performance budgets (SPEC §37) measured on this machine. Each part runs in its own process and
// prints one JSON line; the report (with the host's CPU, memory and OS) goes to artifacts/bench/report.json. The run
// fails when any part is over budget or fails to run. Parts so far: server vision recomputation (AC-VIS-12); the movement range field (§16.6, AC-MOV-10).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { ROOT } from "./features-lib.mjs";

const PARTS = [
  { name: "vision", file: join("packages", "server", "src", "bench", "vision.ts") },
  { name: "range", file: join("packages", "server", "src", "bench", "range.ts") },
];

const report = {
  at: new Date().toISOString(),
  host: {
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()}`,
    node: process.version,
  },
  results: {},
};
let failed = false;
for (const part of PARTS) {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", part.file], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (r.stderr) process.stderr.write(r.stderr);
  const last = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  let json = null;
  try {
    json = JSON.parse(last);
  } catch {
    json = null;
  }
  report.results[part.name] = json ?? { error: (r.stderr ?? "").trim() || `exit ${r.status}` };
  const ok = r.status === 0 && json !== null;
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${part.name} ${last}`);
}
const dir = join(ROOT, "artifacts", "bench");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `host: ${report.host.cpu} (${report.host.cores} threads), ${report.host.os}, node ${report.host.node}`,
);
console.log(`report: ${join("artifacts", "bench", "report.json")}`);
process.exit(failed ? 1 : 0);
