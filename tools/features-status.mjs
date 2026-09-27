#!/usr/bin/env node
// Prints acceptance-criteria status (SPEC Appendix E). With --verify, exits 1 when any passing entry lacks
// evidence, when a disputed entry has no reason, or when the ID set differs from the spec's.
import { extractFromSpec, PHASES, readFeatures } from "./features-lib.mjs";

const verify = process.argv.includes("--verify");
const { features } = readFeatures();

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const passing = features.filter((f) => f.passes === true && !nonEmpty(f.disputed));
const disputed = features.filter((f) => nonEmpty(f.disputed));
const failing = features.filter((f) => f.passes !== true && !nonEmpty(f.disputed));

console.log(
  `PASSING ${passing.length}/${features.length} · DISPUTED ${disputed.length} · FAILING ${failing.length}`,
);
console.log("");
console.log("Phase  Pass  Disp  Fail  Total");
for (const p of PHASES) {
  const inPhase = features.filter((f) => f.phase === p);
  const pa = inPhase.filter((f) => passing.includes(f)).length;
  const di = inPhase.filter((f) => disputed.includes(f)).length;
  const fa = inPhase.filter((f) => failing.includes(f)).length;
  console.log(
    `${p.padEnd(6)} ${String(pa).padStart(4)}  ${String(di).padStart(4)}  ${String(fa).padStart(4)}  ${String(inPhase.length).padStart(5)}`,
  );
}

if (process.argv.includes("--failing")) {
  console.log("");
  for (const f of failing) console.log(`${f.phase.padEnd(4)} ${f.id}`);
}

if (verify) {
  const problems = [];
  for (const f of features) {
    if (f.passes === true && !nonEmpty(f.evidence))
      problems.push(`${f.id}: passes=true but evidence is empty`);
    if (f.disputed !== null && f.disputed !== undefined && !nonEmpty(f.disputed)) {
      problems.push(`${f.id}: disputed is set but empty`);
    }
  }
  const specIds = new Set(extractFromSpec().map((e) => e.id));
  const fileIds = new Set(features.map((f) => f.id));
  for (const id of specIds)
    if (!fileIds.has(id)) problems.push(`${id}: in SPEC.md but missing from FEATURES.json`);
  for (const id of fileIds) if (!specIds.has(id)) problems.push(`${id}: in FEATURES.json but not in SPEC.md`);
  if (fileIds.size !== features.length) problems.push("FEATURES.json contains duplicate IDs");
  if (problems.length > 0) {
    console.error("");
    console.error(`features:status --verify failed (${problems.length} problem(s)):`);
    for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("");
  console.log("verify: OK");
}
