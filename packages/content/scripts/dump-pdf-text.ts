/**
 * Research helper: dumps the verified SRD PDF to one plain-text file per page (lines rebuilt from glyph
 * positions) under .cache/srd-5.2.1-text/p###.txt so rules research can grep and cite page numbers.
 * Usage: node --disable-warning=ExperimentalWarning scripts/dump-pdf-text.ts [pdf] [outDir]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pdfPath = resolve(process.argv[2] ?? join(here, "..", ".cache", "SRD_CC_v5.2.1.pdf"));
const outDir = resolve(process.argv[3] ?? join(here, "..", ".cache", "srd-5.2.1-text"));
const PINNED_SHA256 = "8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87";

const bytes = readFileSync(pdfPath);
const sha = createHash("sha256").update(bytes).digest("hex");
if (pdfPath.endsWith("SRD_CC_v5.2.1.pdf") && sha !== PINNED_SHA256) {
  throw new Error(`SRD PDF hash mismatch: ${sha}`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({
  data: new Uint8Array(bytes),
  useSystemFonts: false,
}).promise;
mkdirSync(outDir, { recursive: true });

type Item = { str: string; x: number; y: number; w: number };
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  const items: Item[] = [];
  for (const it of content.items) {
    if (!("str" in it) || it.str.length === 0) continue;
    const t = it.transform as number[];
    items.push({ str: it.str, x: t[4] ?? 0, y: t[5] ?? 0, w: it.width });
  }
  // Two-column layout: split at the page's horizontal midpoint, then read each column top to bottom.
  const width = page.view[2] ?? 612;
  const mid = width / 2;
  const cols = [items.filter((i) => i.x < mid - 4), items.filter((i) => i.x >= mid - 4)];
  const out: string[] = [];
  for (const col of cols) {
    const rows = new Map<number, Item[]>();
    for (const it of col) {
      const key = Math.round(it.y / 2) * 2;
      const row = rows.get(key) ?? [];
      row.push(it);
      rows.set(key, row);
    }
    for (const key of [...rows.keys()].sort((a, b) => b - a)) {
      const row = (rows.get(key) ?? []).sort((a, b) => a.x - b.x);
      let line = "";
      let lastEnd = -1;
      for (const it of row) {
        if (lastEnd >= 0 && it.x - lastEnd > 1.5 && !line.endsWith(" ")) line += " ";
        line += it.str;
        lastEnd = it.x + it.w;
      }
      out.push(line.trimEnd());
    }
    out.push("");
  }
  writeFileSync(join(outDir, `p${String(n).padStart(3, "0")}.txt`), `${out.join("\n").trim()}\n`);
}
console.log(`Dumped ${doc.numPages} pages to ${outDir}`);
