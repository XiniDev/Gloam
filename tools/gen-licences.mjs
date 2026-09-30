#!/usr/bin/env node
// Writes packages/server/src/about/licences.json (SPEC Appendix I; AC-ADM-05): every production dependency with its
// licence (from `pnpm licenses list --prod --json`, read from the installed packages — no network), the bundled fonts'
// SIL Open Font Licence texts (from their packages), and the vendored ZzFX. Run after changing dependencies:
//   node tools/gen-licences.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages", "server", "src", "about", "licences.json");

const r = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
  maxBuffer: 64 * 1024 * 1024,
});
if (r.status !== 0) {
  console.error(r.stderr || "pnpm licenses list failed");
  process.exit(1);
}
const byLicence = JSON.parse(r.stdout);
const packages = [];
for (const [licence, list] of Object.entries(byLicence))
  for (const p of list)
    packages.push({
      name: p.name,
      version: (p.versions ?? []).join(", "),
      license: p.license || licence,
      ...(p.author ? { author: String(p.author) } : {}),
      ...(p.homepage ? { homepage: String(p.homepage) } : {}),
    });
packages.sort((a, b) => a.name.localeCompare(b.name));

// The fonts (Appendix I: "include the licence texts"), each from its own package.
const FONTS = [
  { family: "Fraunces", pkg: "@fontsource-variable+fraunces", dir: "@fontsource-variable/fraunces" },
  { family: "Alegreya Sans", pkg: "@fontsource+alegreya-sans", dir: "@fontsource/alegreya-sans" },
  { family: "Cinzel", pkg: "@fontsource+cinzel", dir: "@fontsource/cinzel" },
  {
    family: "JetBrains Mono",
    pkg: "@fontsource-variable+jetbrains-mono",
    dir: "@fontsource-variable/jetbrains-mono",
  },
];
const store = join(root, "node_modules", ".pnpm");
const fonts = FONTS.map((f) => {
  const hit = readdirSync(store).find((d) => d.startsWith(`${f.pkg}@`));
  const file = hit ? join(store, hit, "node_modules", f.dir, "LICENSE") : null;
  if (!file || !existsSync(file)) {
    console.error(`no licence file for ${f.family}`);
    process.exit(1);
  }
  return {
    family: f.family,
    license: "OFL-1.1",
    text: readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim(),
  };
});

const vendored = [
  {
    name: "ZzFX",
    version: "1.3.2 (buildSamples, vendored)",
    license: "MIT",
    author: "Frank Force",
    homepage: "https://github.com/KilledByAPixel/ZzFX",
  },
];

writeFileSync(out, `${JSON.stringify({ packages, fonts, vendored }, null, 2)}\n`);
console.log(`${packages.length} packages, ${fonts.length} fonts → ${out}`);
