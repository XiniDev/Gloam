#!/usr/bin/env node
// Marks acceptance criteria as passing with evidence (never deletes or rewords entries; SPEC §4.3).
// Usage: node tools/features-mark.mjs AC-XXX-01[,AC-XXX-02…] "evidence string"
//        node tools/features-mark.mjs --dispute AC-XXX-01 "reason (also logged in DECISIONS.md)"
import { readFileSync, writeFileSync } from "node:fs";
import { FEATURES_PATH } from "./features-lib.mjs";

const args = process.argv.slice(2);
const dispute = args[0] === "--dispute";
if (dispute) args.shift();
const [ids, text] = args;
if (!ids || !text || text.trim().length < 8) {
  console.error('usage: node tools/features-mark.mjs AC-A-01[,AC-B-02] "evidence (test file › name, or screenshot path)"');
  process.exit(2);
}
const doc = JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
const now = new Date().toISOString();
for (const id of ids.split(",").map((s) => s.trim())) {
  const f = doc.features.find((x) => x.id === id);
  if (!f) {
    console.error(`unknown id ${id}`);
    process.exit(1);
  }
  if (dispute) f.disputed = text;
  else {
    f.passes = true;
    f.evidence = text;
  }
  f.updatedAt = now;
  console.log(`${dispute ? "disputed" : "passing"} ${id}`);
}
writeFileSync(FEATURES_PATH, `${JSON.stringify(doc, null, 2)}\n`);
