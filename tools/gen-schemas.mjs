#!/usr/bin/env node
// Writes the published import JSON Schemas (SPEC §8.23, §26.1; AC-API-03) to docs/schemas/<name>.json from the zod
// schemas in packages/shared. The server serves the same documents at /api/v1/schemas/<name>.json, and a test
// regenerates them and compares with these files — run this after changing an import schema:
//   node tools/gen-schemas.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "schemas");
const { IMPORT_SCHEMA_NAMES, importJsonSchema } = await import(
  pathToFileURL(join(root, "packages", "shared", "src", "schemas", "imports.ts")).href
);
mkdirSync(out, { recursive: true });
for (const name of IMPORT_SCHEMA_NAMES)
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(importJsonSchema(name), null, 2)}\n`);
console.log(`${IMPORT_SCHEMA_NAMES.length} schemas → ${out}`);
