/**
 * Step 2 of the content pipeline (SPEC §33.2): parse the spell chapter of the SRD 5.2.1 PDF into the
 * canonical spell list, with header fields and Markdown text (paragraphs, bullet lists, tables and the
 * stat blocks some spells include).
 *
 * The parser works from glyph positions and real font names (pdfjs text content plus the page's font
 * objects), not from a flattened text dump:
 * - reading order is column by column, top to bottom (the content stream order differs on some pages);
 * - a spell starts at a GillSans-SemiBold 12 pt name followed by a Cambria-Italic "Level N School (…)" or
 *   "School Cantrip (…)" line, then the four GillSans header fields;
 * - body text is ragged-right Cambria: a paragraph ends when the next line's first word would have fit on
 *   the previous line, at a first-line indent, at a bullet, or at a vertical gap;
 * - GillSans 9.3/9.5/10.5 pt lines inside a body are tables; Optima lines are creature stat blocks.
 *
 * Usage (debugging): node --disable-warning=ExperimentalWarning scripts/parse-srd-pdf.ts [pdf] [--dump slug]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, SRD_PDF } from "./lib/pins.ts";
import { isEntryPoint, sha256, slugify, toJson } from "./lib/util.ts";

// ---------------------------------------------------------------------------------------------------------
// Types

export interface Run {
  text: string;
  b: boolean;
  i: boolean;
}

export type Block =
  | { kind: "para"; runs: Run[] }
  | { kind: "bullet"; runs: Run[] }
  | { kind: "table"; title?: string; header: Run[][]; rows: Run[][][] }
  | { kind: "statblock"; md: string; plain: string };

export interface PdfSpell {
  name: string;
  id: string;
  page: number;
  pages: number[];
  level: number;
  school: string;
  classes: string[];
  header: { castingTime: string; range: string; components: string; duration: string };
  blocks: Block[];
  /** Markdown of the description (without the higher-level / cantrip-upgrade paragraph). */
  text: string;
  /** Plain text of paragraphs and bullets only (no tables or stat blocks) — input for prose patterns. */
  prose: string;
  /** Plain text of tables and stat blocks. */
  extraPlain: string;
  higherLevels?: { md: string; plain: string };
  cantripUpgrade?: { md: string; plain: string };
}

export interface HyphenDecision {
  spell: string;
  left: string;
  right: string;
  result: string;
  reason:
    | "dictionary-hyphen"
    | "dictionary-join"
    | "non-alpha"
    | "capital"
    | "compound-suffix"
    | "exception-keep"
    | "exception-join"
    | "default-join";
}

export interface ParseResult {
  spells: PdfSpell[];
  firstPage: number;
  lastPage: number;
  hyphenation: HyphenDecision[];
  /** Exception entries that matched no line break (stale overlay entries). */
  unusedHyphenationExceptions: string[];
  /** Plain text of every page (lines in reading order), for verifying overlay citations. */
  pageText: Map<number, string>;
  warnings: string[];
}

interface Glyph {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
}

interface Line {
  page: number;
  col: 0 | 1;
  y: number;
  x: number;
  xEnd: number;
  glyphs: Glyph[];
  text: string;
}

// ---------------------------------------------------------------------------------------------------------
// Font helpers

const isBoldFont = (f: string) => /Bold|SemiBold/.test(f);
const isItalicFont = (f: string) => /Italic/.test(f);
const isCambria = (f: string) => f.startsWith("Cambria");
const isGill = (f: string) => f.startsWith("GillSans");
const isOptima = (f: string) => f.startsWith("Optima");
const isSmallCaps = (f: string) => f.includes("-SC");

function firstGlyph(line: Line): Glyph {
  const g = line.glyphs.find((x) => x.str.trim() !== "");
  if (!g) throw new Error(`empty line on page ${line.page}`);
  return g;
}

const near = (a: number, b: number, tol = 0.4) => Math.abs(a - b) <= tol;

function isSpellNameLine(l: Line): boolean {
  const g = firstGlyph(l);
  return g.font.startsWith("GillSans-SemiBold") && near(g.size, 12, 0.3);
}
function isLevelLine(l: Line): boolean {
  const g = firstGlyph(l);
  return g.font === "Cambria-Italic" && near(g.size, 10);
}
function isChapterHeading(l: Line): boolean {
  return firstGlyph(l).size >= 17;
}
function isStatBlockLine(l: Line): boolean {
  const g = firstGlyph(l);
  return (
    isOptima(g.font) ||
    (g.font === "GillSans-SemiBold" && near(g.size, 14.6, 0.5)) ||
    (g.font === "GillSans" && near(g.size, 12, 0.3)) ||
    (isGill(g.font) && g.size < 7.5) ||
    (isGill(g.font) && near(g.size, 9.8, 0.3))
  );
}
function isTableLine(l: Line): boolean {
  const g = firstGlyph(l);
  return isGill(g.font) && g.size >= 9 && g.size < 11 && !near(g.size, 9.8, 0.3);
}

// ---------------------------------------------------------------------------------------------------------
// Glyphs → lines

type PdfDoc = Awaited<ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs")["getDocument"]>["promise"]>;

async function pageGlyphs(
  doc: PdfDoc,
  n: number,
  withFonts: boolean,
): Promise<{ glyphs: Glyph[]; mid: number }> {
  const page = await doc.getPage(n);
  if (withFonts) await page.getOperatorList();
  const content = await page.getTextContent();
  const glyphs: Glyph[] = [];
  const fontNames = new Map<string, string>();
  for (const it of content.items) {
    if (!("str" in it) || it.str === "") continue;
    const t = it.transform as number[];
    let font = it.fontName;
    if (withFonts) {
      let real = fontNames.get(it.fontName);
      if (real === undefined) {
        const obj = page.commonObjs.get(it.fontName) as { name?: string } | undefined;
        real = (obj?.name ?? it.fontName).replace(/^[A-Z]{6}\+/, "");
        fontNames.set(it.fontName, real);
      }
      font = real;
    }
    glyphs.push({ str: it.str, x: t[4] ?? 0, y: t[5] ?? 0, w: it.width, size: Math.abs(t[0] ?? 0), font });
  }
  return { glyphs, mid: (page.view[2] ?? 594) / 2 };
}

function joinGlyphText(glyphs: Glyph[]): string {
  let out = "";
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const g of glyphs) {
    const gap = g.x - prevEnd;
    if (out !== "" && gap > 1.0 && !/\s$/.test(out) && !/^\s/.test(g.str)) out += " ";
    out += g.str;
    prevEnd = g.x + g.w;
  }
  return out;
}

function buildLines(page: number, glyphs: Glyph[], mid: number): Line[] {
  const lines: Line[] = [];
  for (const col of [0, 1] as const) {
    const colGlyphs = glyphs
      .filter((g) => (col === 0 ? g.x < mid - 4 : g.x >= mid - 4) && g.y > 45)
      .sort((a, b) => b.y - a.y || a.x - b.x);
    let cur: Glyph[] = [];
    let curY = Number.NaN;
    const flush = () => {
      const visible = cur.filter((g) => g.str.trim() !== "");
      if (visible.length > 0) {
        const sorted = [...cur].sort((a, b) => a.x - b.x);
        const first = visible.reduce((m, g) => (g.x < m.x ? g : m));
        const last = visible.reduce((m, g) => (g.x + g.w > m.x + m.w ? g : m));
        lines.push({
          page,
          col,
          y: curY,
          x: first.x,
          xEnd: last.x + last.w,
          glyphs: sorted,
          text: joinGlyphText(sorted).trim(),
        });
      }
      cur = [];
    };
    for (const g of colGlyphs) {
      if (cur.length > 0 && Math.abs(g.y - curY) > 1.2) flush();
      if (cur.length === 0) curY = g.y;
      cur.push(g);
    }
    flush();
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------
// Runs and inline Markdown

function runsOfGlyphs(glyphs: Glyph[], smallCapsLower = false): Run[] {
  const runs: Run[] = [];
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const g of glyphs) {
    let str = g.str;
    if (smallCapsLower && isSmallCaps(g.font) && g.size < 9) str = str.toLowerCase();
    const gap = g.x - prevEnd;
    const needSpace = runs.length > 0 && gap > 1.0 && !/^\s/.test(str);
    prevEnd = g.x + g.w;
    const b = isBoldFont(g.font);
    const i = isItalicFont(g.font);
    const last = runs[runs.length - 1];
    if (needSpace && last && !/\s$/.test(last.text)) last.text += " ";
    if (last && last.b === b && last.i === i) last.text += str;
    else runs.push({ text: str, b, i });
  }
  return runs;
}

function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.text === "") continue;
    const last = out[out.length - 1];
    // Whitespace carries no style; merge it into the neighbour so markers never wrap bare spaces.
    if (last && last.b === r.b && last.i === r.i) last.text += r.text;
    else if (last && r.text.trim() === "") last.text += r.text;
    else out.push({ ...r });
  }
  for (const r of out) r.text = r.text.replace(/\s+/g, " ");
  return out;
}

function escapeMd(s: string): string {
  return s.replace(/([\\*_`])/g, "\\$1");
}

export function runsToMarkdown(runs: Run[], cell = false): string {
  let out = "";
  for (const r of normalizeRuns(runs)) {
    const lead = r.text.match(/^\s*/)?.[0] ?? "";
    const trail = r.text.match(/\s*$/)?.[0] ?? "";
    const core = r.text.trim();
    if (core === "") {
      out += r.text;
      continue;
    }
    let esc = escapeMd(core);
    if (cell) esc = esc.replace(/\|/g, "\\|");
    const mark = r.b && r.i ? "***" : r.b ? "**" : r.i ? "*" : "";
    out += `${lead}${mark}${esc}${mark}${trail}`;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function runsToPlain(runs: Run[]): string {
  return runs
    .map((r) => r.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------------------------------------
// Hyphenation

export class Dehyphenator {
  private readonly words = new Set<string>();
  private readonly pairs = new Set<string>();
  readonly decisions: HyphenDecision[] = [];
  private static readonly compoundSuffixes = new Set([
    "radius",
    "foot",
    "feet",
    "high",
    "wide",
    "long",
    "thick",
    "deep",
    "level",
    "like",
    "sized",
    "shaped",
    "mile",
    "inch",
    "pound",
    "hour",
    "minute",
    "round",
    "day",
    "square",
  ]);

  /** Learn word forms from lines, skipping fragments at hyphenated line breaks. */
  learn(lineTexts: string[]): void {
    let prevHyphen = false;
    for (const text of lineTexts) {
      const tokens = text.match(/[A-Za-z’']+(?:-[A-Za-z’']+)*-?/g) ?? [];
      const endsHyphen = /[A-Za-z]-$/.test(text);
      tokens.forEach((tok, idx) => {
        if (idx === 0 && prevHyphen) return;
        if (idx === tokens.length - 1 && endsHyphen) return;
        const clean = tok.replace(/-$/, "").toLowerCase().replace(/’/g, "'");
        const parts = clean.split("-");
        for (const p of parts) this.words.add(p);
        for (let k = 0; k + 1 < parts.length; k++) this.pairs.add(`${parts[k]}-${parts[k + 1]}`);
      });
      prevHyphen = endsHyphen;
    }
  }

  private exceptionsKeep = new Set<string>();
  private exceptionsJoin = new Set<string>();
  /** Exception keys ("long-dead") that matched at least one line break. */
  readonly usedExceptions = new Set<string>();

  /** Reviewed decisions for breaks the dictionary can't settle (overlays/hyphenation.json). */
  setExceptions(keep: readonly string[], join: readonly string[]): void {
    this.exceptionsKeep = new Set(keep.map((k) => k.toLowerCase()));
    this.exceptionsJoin = new Set(join.map((k) => k.toLowerCase()));
  }

  /** Joins `left` (ending in "-") and `right`; returns the combined string. */
  join(left: string, right: string, spell: string): string {
    const lw = (left.slice(0, -1).match(/[A-Za-z’']+$/)?.[0] ?? "").toLowerCase().replace(/’/g, "'");
    const rwRaw = right.match(/^[A-Za-z’']+/)?.[0] ?? "";
    const rw = rwRaw.toLowerCase().replace(/’/g, "'");
    const keep = (reason: HyphenDecision["reason"]) => {
      this.decisions.push({ spell, left: lw, right: rwRaw, result: `${lw}-${rw}`, reason });
      return left + right;
    };
    const drop = (reason: HyphenDecision["reason"]) => {
      this.decisions.push({ spell, left: lw, right: rwRaw, result: `${lw}${rw}`, reason });
      return left.slice(0, -1) + right;
    };
    if (lw === "" || rw === "") return keep("non-alpha");
    const key = `${lw}-${rw}`;
    if (this.exceptionsKeep.has(key)) {
      this.usedExceptions.add(key);
      return keep("exception-keep");
    }
    if (this.exceptionsJoin.has(key)) {
      this.usedExceptions.add(key);
      return drop("exception-join");
    }
    const hyph = this.pairs.has(`${lw}-${rw}`);
    const joined = this.words.has(`${lw}${rw}`);
    if (hyph && !joined) return keep("dictionary-hyphen");
    if (joined && !hyph) return drop("dictionary-join");
    if (/^[A-Z0-9]/.test(rwRaw)) return keep("capital");
    if (Dehyphenator.compoundSuffixes.has(rw)) return keep("compound-suffix");
    return drop("default-join");
  }
}

/**
 * Appends the runs of a following line to a block: a line-final hyphen is resolved by the dehyphenator;
 * otherwise the lines are joined with one space (none after an em dash, which the PDF sets closed up).
 */
function appendLine(target: Run[], add: Run[], dehyph: Dehyphenator, spell: string): void {
  const last = target[target.length - 1];
  const first = add[0];
  if (!last || !first) {
    target.push(...add);
    return;
  }
  const firstText = first.text.trimStart();
  if (/[A-Za-z0-9]-$/.test(last.text)) {
    const joined = dehyph.join(last.text, firstText, spell);
    last.text = joined.slice(0, joined.length - firstText.length);
  } else if (!/[\s—]$/.test(last.text)) {
    last.text += " ";
  }
  target.push({ ...first, text: firstText }, ...add.slice(1));
}

// ---------------------------------------------------------------------------------------------------------
// Body segmentation

interface ColumnGeometry {
  left: [number, number];
  right: [number, number];
}

class BodyBuilder {
  readonly blocks: Block[] = [];
  private cur: { kind: "para" | "bullet"; runs: Run[]; hanging: boolean } | null = null;
  private prev: Line | null = null;
  private tableLines: Line[] = [];
  private statLines: Line[] = [];

  private readonly geo: ColumnGeometry;
  private readonly dehyph: Dehyphenator;
  private readonly spell: string;

  constructor(geo: ColumnGeometry, dehyph: Dehyphenator, spell: string) {
    this.geo = geo;
    this.dehyph = dehyph;
    this.spell = spell;
  }

  private colLeft(l: Line): number {
    return l.col === 0 ? this.geo.left[0] : this.geo.right[0];
  }
  addLine(l: Line): void {
    if (isStatBlockLine(l) || (this.statLines.length > 0 && this.continuesStatBlock(l))) {
      this.flushText();
      this.flushTable();
      this.statLines.push(l);
      this.prev = l;
      return;
    }
    if (isTableLine(l)) {
      this.flushText();
      this.flushStat();
      this.tableLines.push(l);
      this.prev = l;
      return;
    }
    this.flushTable();
    this.flushStat();
    this.addTextLine(l);
  }

  private continuesStatBlock(l: Line): boolean {
    const g = firstGlyph(l);
    return isOptima(g.font) || isSmallCaps(g.font);
  }

  private addTextLine(l: Line): void {
    const offset = l.x - this.colLeft(l);
    const bullet = l.text.startsWith("•");
    let runs = runsOfGlyphs(l.glyphs);
    if (bullet) {
      runs = runs.map((r, idx) => (idx === 0 ? { ...r, text: r.text.replace(/^\s*•\s*/, "") } : r));
    }
    // Paragraph structure is typographic, not lexical (the PDF is set ragged-right with a paragraph
    // composer, so line lengths say nothing reliable): a first-line indent (+8 pt) starts a paragraph;
    // bullets hang at +12 pt; bold-labelled entries ("Antipathy.") are flush with a +8 pt hanging indent;
    // bold-italic run-in headings always start a paragraph; lists are followed by an extra vertical gap.
    const prev = this.prev;
    const cur = this.cur;
    const firstRun = runs.find((r) => r.text.trim() !== "");
    const prevLast = prev ? [...prev.glyphs].reverse().find((g) => g.str.trim() !== "") : undefined;
    const prevEndsBoldItalic =
      prevLast !== undefined && isBoldFont(prevLast.font) && isItalicFont(prevLast.font);
    let startNew = cur === null || bullet;
    if (!startNew && cur && prev) {
      if (!isCambria(firstGlyph(prev).font)) startNew = true;
      else if (firstRun?.b && firstRun.i && !prevEndsBoldItalic) startNew = true;
      else if (cur.kind === "para" && !cur.hanging && offset > 4.5 && offset < 10.5) startNew = true;
      else if (cur.kind === "bullet" && offset < 10) startNew = true;
      else if (cur.kind === "para" && cur.hanging && offset < 3) startNew = true;
      else if (prev.col === l.col && prev.page === l.page && prev.y - l.y > 16) startNew = true;
    }
    if (startNew) {
      this.flushText();
      const first = runs.find((r) => r.text.trim() !== "");
      const hanging = !bullet && offset < 3 && first?.b === true && !first.i;
      this.cur = { kind: bullet ? "bullet" : "para", runs, hanging };
    } else if (cur) {
      appendLine(cur.runs, runs, this.dehyph, this.spell);
    }
    this.prev = l;
  }

  private flushText(): void {
    if (this.cur) {
      const runs = normalizeRuns(this.cur.runs);
      if (runs.length > 0) this.blocks.push({ kind: this.cur.kind, runs });
    }
    this.cur = null;
  }

  private flushTable(): void {
    if (this.tableLines.length === 0) return;
    for (const t of parseTables(this.tableLines, this.dehyph, this.spell)) {
      const prevBlock = this.blocks[this.blocks.length - 1];
      // A table continued in the next column/page repeats its header without a title: merge the rows.
      if (
        prevBlock?.kind === "table" &&
        t.title === undefined &&
        JSON.stringify(prevBlock.header.map(runsToPlain)) === JSON.stringify(t.header.map(runsToPlain))
      ) {
        prevBlock.rows.push(...t.rows);
      } else {
        this.blocks.push(t);
      }
    }
    this.tableLines = [];
  }

  private flushStat(): void {
    if (this.statLines.length === 0) return;
    this.blocks.push(parseStatBlock(this.statLines, this.dehyph, this.spell));
    this.statLines = [];
  }

  finish(): Block[] {
    this.flushText();
    this.flushTable();
    this.flushStat();
    return this.blocks;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Tables

interface Cell {
  x: number;
  xEnd: number;
  glyphs: Glyph[];
}

function splitCells(glyphs: Glyph[], gap = 6): Cell[] {
  const cells: Cell[] = [];
  let cur: Cell | null = null;
  for (const g of [...glyphs].sort((a, b) => a.x - b.x)) {
    if (g.str.trim() === "") {
      if (cur) cur.glyphs.push(g);
      continue;
    }
    if (cur && g.x - cur.xEnd <= gap) {
      cur.glyphs.push(g);
      cur.xEnd = Math.max(cur.xEnd, g.x + g.w);
    } else {
      cur = { x: g.x, xEnd: g.x + g.w, glyphs: [g] };
      cells.push(cur);
    }
  }
  return cells;
}

function parseTables(
  lines: Line[],
  dehyph: Dehyphenator,
  spell: string,
): Extract<Block, { kind: "table" }>[] {
  // Side-by-side tables: a title line with several title cells splits the following lines by x.
  const groups: Line[][] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const g = firstGlyph(l);
    const isTitle = near(g.size, 10.5, 0.3);
    const titleCells = isTitle ? splitCells(l.glyphs, 12) : [];
    if (isTitle && titleCells.length > 1) {
      const cuts = titleCells.slice(1).map((c) => c.x - 4);
      let j = i + 1;
      while (j < lines.length && !near(firstGlyph(lines[j]!).size, 10.5, 0.3)) j++;
      const block = lines.slice(i, j);
      const bounds = [Number.NEGATIVE_INFINITY, ...cuts, Number.POSITIVE_INFINITY];
      for (let k = 0; k + 1 < bounds.length; k++) {
        const lo = bounds[k]!;
        const hi = bounds[k + 1]!;
        const sub: Line[] = [];
        for (const bl of block) {
          const gl = bl.glyphs.filter((x) => x.x >= lo && x.x < hi);
          if (gl.some((x) => x.str.trim() !== "")) {
            const vis = gl.filter((x) => x.str.trim() !== "");
            sub.push({
              ...bl,
              glyphs: gl,
              x: Math.min(...vis.map((x) => x.x)),
              xEnd: Math.max(...vis.map((x) => x.x + x.w)),
              text: joinGlyphText(gl).trim(),
            });
          }
        }
        groups.push(sub);
      }
      i = j;
      continue;
    }
    // Plain sequence: a new group starts at a title, or at a header row that follows body rows.
    const lastGroup = groups[groups.length - 1];
    const isHeader = g.font.startsWith("GillSans-SemiBold") && near(g.size, 9.3, 0.1);
    const lastLine = lastGroup?.[lastGroup.length - 1];
    const lastWasBody = lastLine !== undefined && near(firstGlyph(lastLine).size, 9.5, 0.1);
    if (
      !lastGroup ||
      isTitle ||
      (isHeader && lastWasBody) ||
      lastLine?.page !== l.page ||
      lastLine.col !== l.col
    ) {
      groups.push([l]);
    } else {
      lastGroup.push(l);
    }
    i++;
  }
  return groups
    .map((g) => parseTable(g, dehyph, spell))
    .filter((t) => t.header.length > 0 || t.rows.length > 0);
}

function parseTable(lines: Line[], dehyph: Dehyphenator, spell: string): Extract<Block, { kind: "table" }> {
  let title: string | undefined;
  const headerLines: Line[] = [];
  const bodyLines: Line[] = [];
  for (const l of lines) {
    const g = firstGlyph(l);
    if (near(g.size, 10.5, 0.3) && title === undefined && headerLines.length === 0) title = l.text;
    else if (g.font.startsWith("GillSans-SemiBold") && near(g.size, 9.3, 0.1) && bodyLines.length === 0)
      headerLines.push(l);
    else bodyLines.push(l);
  }
  // Header cells: the line with the most cells defines the columns; stacked words attach by overlap.
  const headerRows = headerLines.map((l) => splitCells(l.glyphs));
  const base = [...headerRows].sort((a, b) => b.length - a.length)[0] ?? [];
  const cols = base.map((c) => ({ x: c.x, xEnd: c.xEnd, parts: [] as { y: number; cell: Cell }[] }));
  headerRows.forEach((row, ri) => {
    const y = headerLines[ri]!.y;
    for (const c of row) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      cols.forEach((col, k) => {
        const overlap = Math.min(col.xEnd, c.xEnd) - Math.max(col.x, c.x);
        const d = overlap > 0 ? -overlap : Math.abs((col.x + col.xEnd) / 2 - (c.x + c.xEnd) / 2);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      cols[best]!.parts.push({ y, cell: c });
    }
  });
  for (const col of cols) col.x = Math.min(col.x, ...col.parts.map((p) => p.cell.x));
  const header: Run[][] = cols.map((col) => {
    const runs: Run[] = [];
    for (const p of [...col.parts].sort((a, b) => b.y - a.y)) {
      if (runs.length > 0) runs.push({ text: " ", b: false, i: false });
      runs.push(...runsOfGlyphs(p.cell.glyphs));
    }
    return normalizeRuns(runs).map((r) => ({ ...r, b: false }));
  });
  const starts = cols.map((c) => c.x);
  const colOf = (x: number) => {
    let k = 0;
    for (let j = 0; j < starts.length; j++) if (x >= starts[j]! - 7) k = j;
    return k;
  };
  const nCols = Math.max(1, cols.length);
  const rows: Run[][][] = [];
  let prevY = Number.NaN;
  for (const l of bodyLines) {
    const newRow = rows.length === 0 || Number.isNaN(prevY) || prevY - l.y > 13.8;
    if (newRow) rows.push(Array.from({ length: nCols }, () => [] as Run[]));
    const row = rows[rows.length - 1]!;
    for (const c of splitCells(l.glyphs)) {
      const k = colOf(c.x);
      appendLine(row[k]!, runsOfGlyphs(c.glyphs), dehyph, spell);
    }
    prevY = l.y;
  }
  const table: Extract<Block, { kind: "table" }> = {
    kind: "table",
    header,
    rows: rows.map((r) => r.map((c) => normalizeRuns(c))),
  };
  if (title !== undefined) table.title = title;
  return unfoldRepeatedColumns(table);
}

/** "1d10 | Species | 1d10 | Species" printed in two halves becomes one two-column table. */
function unfoldRepeatedColumns(t: Extract<Block, { kind: "table" }>): Extract<Block, { kind: "table" }> {
  const n = t.header.length;
  if (n < 4 || n % 2 !== 0) return t;
  const h = t.header.map(runsToPlain);
  const half = n / 2;
  if (h.slice(0, half).join("|") !== h.slice(half).join("|")) return t;
  const left = t.rows.map((r) => r.slice(0, half));
  const right = t.rows.map((r) => r.slice(half)).filter((r) => r.some((c) => runsToPlain(c) !== ""));
  return { ...t, header: t.header.slice(0, half), rows: [...left, ...right] };
}

function tableToMarkdown(t: Extract<Block, { kind: "table" }>): string {
  const lines: string[] = [];
  if (t.title) lines.push(`**${escapeMd(t.title)}**`, "");
  const cols = Math.max(t.header.length, ...t.rows.map((r) => r.length));
  const cell = (runs: Run[] | undefined) => (runs ? runsToMarkdown(runs, true) : "");
  const header = Array.from({ length: cols }, (_, k) => cell(t.header[k]));
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const r of t.rows) lines.push(`| ${Array.from({ length: cols }, (_, k) => cell(r[k])).join(" | ")} |`);
  return lines.join("\n");
}

function tableToPlain(t: Extract<Block, { kind: "table" }>): string {
  const rows = [t.header, ...t.rows].map((r) => r.map(runsToPlain).join(" | "));
  return [t.title ?? "", ...rows].filter((s) => s !== "").join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// Stat blocks

function parseStatBlock(
  lines: Line[],
  dehyph: Dehyphenator,
  spell: string,
): Extract<Block, { kind: "statblock" }> {
  const md: string[] = [];
  const plain: string[] = [];
  let props: string[] = [];
  let propsPlain: string[] = [];
  const abilities: string[][] = [];
  let entry: { runs: Run[]; y: number; lastBoldItalic: boolean } | null = null;
  const flushProps = () => {
    if (props.length > 0) {
      md.push(props.join("  \n"));
      plain.push(propsPlain.join("\n"));
    }
    props = [];
    propsPlain = [];
  };
  const flushAbilities = () => {
    if (abilities.length === 0) return;
    md.push(
      [
        "| Ability | Score | Mod | Save |",
        "| --- | --- | --- | --- |",
        ...abilities.map((a) => `| ${a.join(" | ")} |`),
      ].join("\n"),
    );
    plain.push(abilities.map((a) => a.join(" ")).join("\n"));
    abilities.length = 0;
  };
  const flushEntry = () => {
    if (entry) {
      md.push(runsToMarkdown(entry.runs));
      plain.push(runsToPlain(entry.runs));
    }
    entry = null;
  };
  let title = "";
  for (const l of lines) {
    const g = firstGlyph(l);
    if (g.font === "GillSans-SemiBold" && near(g.size, 14.6, 0.5)) {
      flushProps();
      flushAbilities();
      flushEntry();
      title = l.text;
      md.push(`#### ${escapeMd(l.text)}`);
      plain.push(l.text);
      continue;
    }
    if (isGill(g.font) && g.size < 7.5) continue; // "MOD SAVE" column captions
    if (l.glyphs.some((x) => isSmallCaps(x.font))) {
      flushProps();
      const text = runsToPlain(runsOfGlyphs(l.glyphs, true));
      // Small-caps labels come out as e.g. "d"+"ex" or "c"+"h"+"A"; normalise to "Dex", "Cha".
      for (const m of text.matchAll(/([A-Za-z]{3})\s+(\d+)\s+([+−-]\d+)\s+([+−-]\d+)/g)) {
        const label = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
        abilities.push([label, m[2]!, m[3]!, m[4]!]);
      }
      continue;
    }
    if (g.font === "GillSans" && near(g.size, 12, 0.3)) {
      flushProps();
      flushAbilities();
      flushEntry();
      md.push(`##### ${escapeMd(l.text)}`);
      plain.push(l.text);
      continue;
    }
    if (g.font === "Optima-Italic" && md.length === 1 && props.length === 0 && entry === null) {
      md.push(`*${escapeMd(l.text)}*`);
      plain.push(l.text);
      continue;
    }
    if (g.font === "Optima-Bold") {
      flushAbilities();
      flushEntry();
      props.push(runsToMarkdown(runsOfGlyphs(l.glyphs)));
      propsPlain.push(l.text);
      continue;
    }
    if (entry === null && props.length > 0 && g.font === "Optima-Regular") {
      props[props.length - 1] += ` ${runsToMarkdown(runsOfGlyphs(l.glyphs))}`;
      propsPlain[propsPlain.length - 1] += ` ${l.text}`;
      continue;
    }
    flushProps();
    flushAbilities();
    const runs = runsOfGlyphs(l.glyphs);
    const startsBoldItalic = g.font === "Optima-BoldItalic";
    const cur: { runs: Run[]; y: number; lastBoldItalic: boolean } | null = entry;
    const isNew = cur === null || (startsBoldItalic && !cur.lastBoldItalic) || cur.y - l.y > 14.5;
    if (isNew || cur === null) {
      flushEntry();
      entry = { runs, y: l.y, lastBoldItalic: false };
    } else {
      appendLine(cur.runs, runs, dehyph, spell);
      cur.y = l.y;
    }
    const lastGlyph = [...l.glyphs].reverse().find((x) => x.str.trim() !== "");
    if (entry)
      (entry as { lastBoldItalic: boolean }).lastBoldItalic = lastGlyph?.font === "Optima-BoldItalic";
  }
  flushProps();
  flushAbilities();
  flushEntry();
  if (title === "") title = "Stat block";
  return { kind: "statblock", md: md.join("\n\n"), plain: plain.join("\n") };
}

// ---------------------------------------------------------------------------------------------------------
// Headers

const LEVEL_RE = /^Level (\d) (\w+) \((.+)\)$/;
const CANTRIP_RE = /^(\w+) Cantrip \((.+)\)$/;
const FIELD_LABELS = ["Casting Time", "Range", "Components", "Duration"] as const;
type FieldLabel = (typeof FIELD_LABELS)[number];

function spellName(l: Line): string {
  return runsToPlain(runsOfGlyphs(l.glyphs, true));
}

// ---------------------------------------------------------------------------------------------------------
// Main

export interface ParseOptions {
  hyphenation?: { keep: readonly string[]; join: readonly string[] };
}

export async function parseSrdPdf(pdfPath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const bytes = readFileSync(pdfPath);
  if (sha256(bytes) !== SRD_PDF.sha256)
    throw new Error(`PDF at ${pdfPath} does not match the pinned SHA-256`);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  if (doc.numPages !== SRD_PDF.pages) throw new Error(`Expected ${SRD_PDF.pages} pages, got ${doc.numPages}`);

  // Pass 1: every page's plain lines → hyphenation dictionary; locate the spell chapter.
  const dehyph = new Dehyphenator();
  const pageText = new Map<number, string>();
  if (opts.hyphenation) dehyph.setExceptions(opts.hyphenation.keep, opts.hyphenation.join);
  let firstPage = -1;
  let lastPage = -1;
  for (let n = 1; n <= doc.numPages; n++) {
    const { glyphs, mid } = await pageGlyphs(doc, n, false);
    const lines = buildLines(n, glyphs, mid);
    dehyph.learn(lines.map((l) => l.text));
    pageText.set(n, lines.map((l) => l.text).join("\n"));
    for (const l of lines) {
      const g = firstGlyph(l);
      if (g.size >= 17 && l.text === "Spell Descriptions" && firstPage < 0) firstPage = n;
      if (g.size >= 17 && l.text === "Rules Glossary" && firstPage > 0 && lastPage < 0) lastPage = n;
    }
  }
  if (firstPage < 0 || lastPage < 0)
    throw new Error("Could not locate the spell chapter (Spell Descriptions … Rules Glossary)");

  // Pass 2: the chapter with real font names.
  const lines: Line[] = [];
  for (let n = firstPage; n <= lastPage; n++) {
    const { glyphs, mid } = await pageGlyphs(doc, n, true);
    lines.push(...buildLines(n, glyphs, mid));
  }
  await task.destroy();

  // Column geometry from body text lines (left edge = most common x, right edge = 99th percentile xEnd).
  const geo = columnGeometry(lines);
  const warnings: string[] = [];
  const spells: PdfSpell[] = [];
  let started = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isChapterHeading(l)) {
      if (started && l.text === "Rules Glossary") break;
      started = l.text === "Spell Descriptions" || started;
      i++;
      continue;
    }
    const next = lines[i + 1];
    if (!(started && isSpellNameLine(l) && next && isLevelLine(next))) {
      if (started) warnings.push(`p${l.page}: stray line before first spell: ${l.text}`);
      i++;
      continue;
    }
    const name = spellName(l);
    const page = l.page;
    const pages = new Set<number>([page]);
    i++;
    // Level / school / classes (may wrap).
    let levelText = "";
    while (i < lines.length && isLevelLine(lines[i]!)) {
      levelText = `${levelText} ${lines[i]!.text}`.trim();
      pages.add(lines[i]!.page);
      i++;
      if ((levelText.match(/\(/g)?.length ?? 0) <= (levelText.match(/\)/g)?.length ?? 0)) break;
    }
    const lm = LEVEL_RE.exec(levelText);
    const cm = CANTRIP_RE.exec(levelText);
    if (!lm && !cm) throw new Error(`p${page} ${name}: cannot parse level line "${levelText}"`);
    const level = lm ? Number(lm[1]) : 0;
    const school = (lm ? lm[2]! : cm![1]!).toLowerCase();
    const classes = (lm ? lm[3]! : cm![2]!).split(/,\s*/).map((c) => c.trim().toLowerCase());
    // Header fields.
    const fields: Partial<Record<FieldLabel, string>> = {};
    let curField: FieldLabel | null = null;
    while (i < lines.length) {
      const hl = lines[i]!;
      const g = firstGlyph(hl);
      const lm2 = /^(Casting Time|Range|Components?|Duration):/.exec(hl.text);
      // The PDF prints "Component:" (singular) once (Barkskin, p. 112); normalise it.
      const label = lm2 ? (FIELD_LABELS.find((f) => f.startsWith(lm2[1]!)) ?? null) : null;
      if (lm2 && label && (isGill(g.font) || isCambria(g.font)) && isBoldFont(g.font)) {
        if (lm2[1] !== label)
          warnings.push(`p${hl.page} ${name}: header label "${lm2[1]}:" read as "${label}:"`);
        curField = label;
        fields[label] = hl.text.slice(lm2[0].length).trim();
      } else if (
        // A wrapped header value continues on an indented GillSans line.
        curField &&
        g.font === "GillSans" &&
        near(g.size, 9.5, 0.3) &&
        hl.x - (hl.col === 0 ? geo.left[0] : geo.right[0]) > 5
      ) {
        const prevText = fields[curField] ?? "";
        fields[curField] = /[A-Za-z0-9]-$/.test(prevText)
          ? dehyph.join(prevText, hl.text, name)
          : `${prevText} ${hl.text}`.trim();
      } else break;
      pages.add(hl.page);
      i++;
    }
    for (const f of FIELD_LABELS) {
      if (fields[f] === undefined) throw new Error(`p${page} ${name}: missing header field ${f}`);
    }
    // Body until the next spell or the end of the chapter.
    const body = new BodyBuilder(geo, dehyph, name);
    while (i < lines.length) {
      const bl = lines[i]!;
      const nx = lines[i + 1];
      if (isChapterHeading(bl)) break;
      if (isSpellNameLine(bl) && nx && isLevelLine(nx)) break;
      body.addLine(bl);
      pages.add(bl.page);
      i++;
    }
    const blocks = body.finish();
    spells.push(
      assembleSpell(
        name,
        page,
        [...pages].sort((a, b) => a - b),
        level,
        school,
        classes,
        fields as Record<FieldLabel, string>,
        blocks,
      ),
    );
  }
  return {
    spells,
    firstPage,
    lastPage: Math.max(...spells.flatMap((s) => s.pages)),
    hyphenation: dehyph.decisions,
    pageText,
    unusedHyphenationExceptions: [
      ...(opts.hyphenation?.keep ?? []),
      ...(opts.hyphenation?.join ?? []),
    ].filter((k) => !dehyph.usedExceptions.has(k.toLowerCase())),
    warnings,
  };
}

function columnGeometry(lines: Line[]): ColumnGeometry {
  const result: number[][] = [];
  for (const col of [0, 1] as const) {
    const body = lines.filter(
      (l) => l.col === col && isCambria(firstGlyph(l).font) && near(firstGlyph(l).size, 10),
    );
    const xs = new Map<number, number>();
    for (const l of body) xs.set(Math.round(l.x), (xs.get(Math.round(l.x)) ?? 0) + 1);
    const left = [...xs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (col === 0 ? 63 : 313);
    const ends = body.map((l) => l.xEnd).sort((a, b) => a - b);
    const right = ends[Math.floor(ends.length * 0.99)] ?? left + 225;
    result.push([left, right]);
  }
  return { left: result[0] as [number, number], right: result[1] as [number, number] };
}

function assembleSpell(
  name: string,
  page: number,
  pages: number[],
  level: number,
  school: string,
  classes: string[],
  fields: Record<FieldLabel, string>,
  blocks: Block[],
): PdfSpell {
  let higherLevels: PdfSpell["higherLevels"];
  let cantripUpgrade: PdfSpell["cantripUpgrade"];
  const kept: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "para") {
      const first = b.runs[0];
      const label = first?.b && first.i ? first.text.trim() : "";
      if (label === "Using a Higher-Level Spell Slot." || label === "Cantrip Upgrade.") {
        const rest = normalizeRuns([{ ...first!, text: "" }, ...b.runs.slice(1)]);
        const value = { md: runsToMarkdown(rest), plain: runsToPlain(rest) };
        if (label === "Cantrip Upgrade.") cantripUpgrade = value;
        else higherLevels = value;
        continue;
      }
    }
    kept.push(b);
  }
  const md: string[] = [];
  const prose: string[] = [];
  const extra: string[] = [];
  kept.forEach((b, idx) => {
    const prevKind = idx > 0 ? kept[idx - 1]!.kind : null;
    switch (b.kind) {
      case "para":
        md.push(runsToMarkdown(b.runs));
        prose.push(runsToPlain(b.runs));
        break;
      case "bullet": {
        const item = `- ${runsToMarkdown(b.runs)}`;
        if (prevKind === "bullet") md[md.length - 1] += `\n${item}`;
        else md.push(item);
        prose.push(runsToPlain(b.runs));
        break;
      }
      case "table":
        md.push(tableToMarkdown(b));
        extra.push(tableToPlain(b));
        break;
      case "statblock":
        md.push(b.md);
        extra.push(b.plain);
        break;
    }
  });
  const spell: PdfSpell = {
    name,
    id: slugify(name),
    page,
    pages,
    level,
    school,
    classes,
    header: {
      castingTime: fields["Casting Time"],
      range: fields.Range,
      components: fields.Components,
      duration: fields.Duration,
    },
    blocks: kept,
    text: md.join("\n\n"),
    prose: prose.join("\n"),
    extraPlain: extra.join("\n"),
  };
  if (higherLevels) spell.higherLevels = higherLevels;
  if (cantripUpgrade) spell.cantripUpgrade = cantripUpgrade;
  return spell;
}

if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const pdf =
    args.find((a) => !a.startsWith("--") && a.endsWith(".pdf")) ?? join(CACHE_DIR, SRD_PDF.fileName);
  const dumpIdx = args.indexOf("--dump");
  const result = await parseSrdPdf(pdf);
  if (dumpIdx >= 0) {
    const ids = (args[dumpIdx + 1] ?? "").split(",");
    for (const s of result.spells.filter((x) => ids.includes(x.id))) {
      const { blocks: _blocks, ...rest } = s;
      console.log(toJson(rest));
      console.log(s.text);
    }
  } else {
    const perLevel = Array.from({ length: 10 }, (_, l) => result.spells.filter((s) => s.level === l).length);
    console.log(
      `pages ${result.firstPage}–${result.lastPage}; ${result.spells.length} spells; per level ${perLevel.join("/")}`,
    );
    for (const w of result.warnings) console.log(`warning: ${w}`);
  }
}
