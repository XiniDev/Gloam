import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

/** kebab-case id from a spell name: "Arcanist’s Magic Aura" → "arcanists-magic-aura". */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Comparison key for names across sources (typographic quotes, case and spacing ignored). */
export function nameKey(name: string): string {
  return slugify(name);
}

/** Pretty JSON with 2-space indentation and a trailing newline (deterministic for a given value). */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.replace(/\r\n/g, "\n"));
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** True when the module at `metaUrl` is the process entry point (works on Node 22 and 24). */
export function isEntryPoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(metaUrl);
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function assertNever(x: never, what: string): never {
  throw new Error(`Unexpected ${what}: ${JSON.stringify(x)}`);
}
