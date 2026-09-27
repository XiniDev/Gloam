#!/usr/bin/env node
// Builds docs/FEATURES.json from docs/SPEC.md (SPEC Appendix E). Preserves passes/evidence/disputed/updatedAt
// for IDs that still exist; fails on duplicate IDs; prints counts per phase.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extractFromSpec, FEATURES_PATH, PHASES } from "./features-lib.mjs";

const extracted = extractFromSpec();
const previous = existsSync(FEATURES_PATH)
  ? JSON.parse(readFileSync(FEATURES_PATH, "utf8"))
  : { features: [] };
const prevById = new Map(previous.features.map((f) => [f.id, f]));

const features = extracted.map((e) => {
  const prev = prevById.get(e.id);
  return {
    id: e.id,
    feature: e.feature,
    code: e.code,
    phase: e.phase,
    text: e.text,
    passes: prev?.passes ?? false,
    evidence: prev?.evidence ?? null,
    disputed: prev?.disputed ?? null,
    updatedAt: prev?.updatedAt ?? null,
  };
});

const removed = [...prevById.keys()].filter((id) => !features.some((f) => f.id === id));
if (removed.length > 0) {
  console.error(`Warning: ${removed.length} IDs no longer in the spec were dropped: ${removed.join(", ")}`);
}

const doc = { specVersion: "1.0", generatedFrom: "docs/SPEC.md", features };
writeFileSync(FEATURES_PATH, `${JSON.stringify(doc, null, 2)}\n`);

const counts = Object.fromEntries(PHASES.map((p) => [p, 0]));
for (const f of features) counts[f.phase] = (counts[f.phase] ?? 0) + 1;
console.log(`Extracted ${features.length} acceptance criteria into docs/FEATURES.json`);
for (const p of PHASES) console.log(`  ${p.padEnd(4)} ${String(counts[p]).padStart(3)}`);
