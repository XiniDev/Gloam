#!/usr/bin/env node
// Design-token lint (SPEC §27.2, AC-DS-01): raw hex colours may appear only in the token file
// (packages/web/src/styles/tokens.css) and in board shader code (packages/web/src/board/**), which takes its
// values from packages/shared/src/constants.ts. Also rejects inline font-family declarations outside the
// token file so type comes from tokens too.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ROOT } from "./features-lib.mjs";

const WEB_SRC = join(ROOT, "packages", "web", "src");
const ALLOW = [(rel) => rel === ["styles", "tokens.css"].join(sep), (rel) => rel.startsWith(`board${sep}`)];
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const FONT_FAMILY = /font-family\s*:/g;
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
    else if (EXT.test(name)) yield p;
  }
}

const problems = [];
for (const file of walk(WEB_SRC)) {
  const rel = relative(WEB_SRC, file);
  if (ALLOW.some((f) => f(rel))) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    // HTML entities like &#x27; are not colours; the lookbehind above skips "&#".
    for (const m of line.matchAll(HEX)) problems.push(`${rel}:${i + 1}: raw colour ${m[0]} (use a token)`);
    if (!rel.endsWith(".css") && FONT_FAMILY.test(line)) {
      problems.push(`${rel}:${i + 1}: inline font-family (use a token)`);
    }
    FONT_FAMILY.lastIndex = 0;
  });
}

if (problems.length > 0) {
  console.error(`check-tokens: ${problems.length} problem(s)`);
  for (const p of problems.slice(0, 60)) console.error(`  ${p}`);
  process.exit(1);
}
console.log("check-tokens: OK");
