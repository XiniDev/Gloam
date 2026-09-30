#!/usr/bin/env node
// `pnpm bench` part (SPEC §37 "Initial table-route JS ≤ 1.2 MB gzipped"; AC-PERF-02): builds the web app as it ships
// (production mode, with Vite's manifest) into packages/web/dist-bench, then sums the gzipped JavaScript a player's
// browser loads to show the table — the entry, the table route, the board, and everything they import statically.
// What loads later (the DM panel, the dice physics worker — prefetched when idle — the other workers, other routes)
// isn't counted; that it stays out is checked too. Prints one JSON line; exits 1 over budget.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ROOT } from "./features-lib.mjs";

const BUDGET = 1_200_000;
const WEB = join(ROOT, "packages", "web");
const OUT = join(WEB, "dist-bench");

rmSync(OUT, { recursive: true, force: true });
const b = spawnSync(
  "pnpm",
  ["exec", "vite", "build", "--outDir", "dist-bench", "--manifest", "--emptyOutDir"],
  {
    cwd: WEB,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 600_000,
  },
);
if (b.status !== 0) {
  process.stderr.write(b.stderr || b.stdout || "vite build failed\n");
  process.exit(1);
}
const manifestPath = join(OUT, ".vite", "manifest.json");
if (!existsSync(manifestPath)) {
  process.stderr.write("no manifest\n");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

/** A chunk and everything it imports statically. */
const files = new Set();
const walk = (key) => {
  const c = manifest[key];
  if (!c || files.has(c.file)) return;
  files.add(c.file);
  for (const i of c.imports ?? []) walk(i);
};
const need = ["index.html", "src/routes/Table.tsx", "src/board/Board.tsx"];
for (const k of need) {
  if (!manifest[k]) {
    process.stderr.write(`manifest has no ${k}\n`);
    process.exit(1);
  }
  walk(k);
}
const js = [...files].filter((f) => f.endsWith(".js"));
let raw = 0;
let gz = 0;
const parts = [];
for (const f of js) {
  const buf = readFileSync(join(OUT, f));
  const g = gzipSync(buf).length;
  raw += buf.length;
  gz += g;
  parts.push({ file: f, gzip: g });
}
parts.sort((a, b) => b.gzip - a.gzip);
// Loaded later, not up front: the DM panel and the dice physics worker (and the other workers) are not in the set.
const later = ["src/hud/dm/DmPanel.tsx"].map((k) => manifest[k]?.file).filter(Boolean);
const leaked = later.filter((f) => files.has(f));
const workers = Object.values(manifest)
  .map((c) => c.file)
  .filter((f) => /worker/i.test(f));
const workerLeaked = workers.filter((f) => files.has(f));
const ok = gz <= BUDGET && leaked.length === 0 && workerLeaked.length === 0;
rmSync(OUT, { recursive: true, force: true });
console.log(
  JSON.stringify({
    bundle: {
      gzipBytes: gz,
      rawBytes: raw,
      budgetBytes: BUDGET,
      chunks: js.length,
      largest: parts.slice(0, 5),
      lazyStayLazy: leaked.length === 0 && workerLeaked.length === 0,
      ok,
    },
  }),
);
process.exit(ok ? 0 : 1);
