// Shared helpers for tools/extract-features.mjs and tools/features-status.mjs (SPEC Appendix E).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_PATH = resolve(ROOT, "docs/SPEC.md");
export const FEATURES_PATH = resolve(ROOT, "docs/FEATURES.json");

/** Code → feature → default phase, with per-AC exceptions (SPEC Appendix E table). */
export const CODE_MAP = {
  HOST: { feature: "F01", phase: "P1" },
  AUTH: { feature: "F02", phase: "P1", exceptions: { 7: "P2" } },
  SCN: { feature: "F03", phase: "P2", exceptions: { 6: "P6", 7: "P4" } },
  BRD: { feature: "F04", phase: "P2" },
  TOK: { feature: "F05", phase: "P2", exceptions: { 4: "P7", 12: "P7", 7: "P3", 13: "P6" } },
  MOV: {
    feature: "F06",
    phase: "P3",
    exceptions: {
      1: "P8",
      4: "P8",
      5: "P8",
      7: "P8",
      9: "P8",
      10: "P8",
      15: "P8",
      16: "P8",
      18: "P8",
      6: "P10",
    },
  },
  WAL: { feature: "F07", phase: "P3" },
  VIS: { feature: "F08", phase: "P4", exceptions: { 6: "P9", 7: "P9", 8: "P9", 15: "P7" } },
  DICE: { feature: "F09", phase: "P5", exceptions: { 6: "P6", 11: "P7" } },
  SHEET: { feature: "F10", phase: "P6" },
  HP: { feature: "F11", phase: "P7", exceptions: { 8: "P8" } },
  CMB: { feature: "F12", phase: "P8" },
  SPL: { feature: "F13", phase: "P9" },
  UNDO: { feature: "F14", phase: "P10" },
  PER: { feature: "F15", phase: "P10", exceptions: { 1: "P1", 3: "P1", 4: "P1" } },
  AST: { feature: "F16", phase: "P2" },
  AUD: { feature: "F17", phase: "P11" },
  FUN: { feature: "F18", phase: "P11", exceptions: { 2: "P3" } },
  DMP: { feature: "F19", phase: "P12" },
  ADM: { feature: "F20", phase: "P12" },
  RSP: { feature: "F21", phase: "P14" },
  A11Y: { feature: "F22", phase: "P14" },
  API: { feature: "F23", phase: "P13" },
  DEMO: { feature: "F24", phase: "P12" },
  SEC: { feature: "cross-cutting", phase: "P1", exceptions: { 7: "P15", 9: "P15" } },
  PERF: { feature: "cross-cutting", phase: "P15" },
  DS: { feature: "cross-cutting", phase: "P2", exceptions: { 3: "P7", 2: "P15", 5: "P15" } },
};

export const PHASES = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "P8",
  "P9",
  "P10",
  "P11",
  "P12",
  "P13",
  "P14",
  "P15",
];

const AC_LINE = /^- `(AC-[A-Z0-9]+-\d{2})` (.+)$/;

/** Parses every acceptance-criterion line of the spec. Throws on duplicates or unknown codes. */
export function extractFromSpec(specText = readFileSync(SPEC_PATH, "utf8")) {
  const seen = new Map();
  const out = [];
  for (const [i, raw] of specText.split(/\r?\n/).entries()) {
    const m = AC_LINE.exec(raw);
    if (!m) continue;
    const id = m[1];
    const text = m[2].trim();
    if (seen.has(id)) throw new Error(`Duplicate AC id ${id} on lines ${seen.get(id)} and ${i + 1}`);
    seen.set(id, i + 1);
    const parts = id.split("-");
    const code = parts.slice(1, -1).join("-");
    const num = Number(parts.at(-1));
    const map = CODE_MAP[code];
    if (!map) throw new Error(`Unknown AC code ${code} (${id}) on line ${i + 1}`);
    const phase = map.exceptions?.[num] ?? map.phase;
    out.push({ id, feature: map.feature, code, phase, text });
  }
  return out;
}

export function readFeatures() {
  return JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
}
