#!/usr/bin/env node
// Design-token lint (SPEC §27, AC-DS-01): see tokens-lib.mjs for the rules.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./features-lib.mjs";
import { exempt, scan } from "./tokens-lib.mjs";

const WEB_SRC = join(ROOT, "packages", "web", "src");
const EXT = /\.(tsx?|css|html)$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const problems = [];
for (const file of walk(WEB_SRC)) {
  const rel = relative(WEB_SRC, file);
  if (exempt(rel)) continue;
  problems.push(...scan(readFileSync(file, "utf8"), rel));
}
if (problems.length > 0) {
  console.error(`check-tokens: ${problems.length} problem(s)`);
  for (const p of problems.slice(0, 80)) console.error(`  ${p}`);
  process.exit(1);
}
console.log("check-tokens: OK");
