import { ICON_CATEGORIES, STATUS_ICONS } from "@gloam/shared/icons";
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from "three";
import { glyphInk } from "../../icons/badgeInk.ts";
import { C } from "../colors.ts";

/**
 * The condition and status icons for the board (SPEC §30, Appendix G, AC-DS-03): every icon on its category's badge,
 * in one texture — 64-px cells, mipmapped, so a token's icons draw crisply at 16–24 px from one material. Drawn from
 * the same generated source as the DOM's icons (`@gloam/shared/icons`), each SVG rasterised by the browser (a data
 * URL: no network).
 */
export const ATLAS_CELL = 64;
const COLS = 8;
/** The glyph inside its badge (the badge's inset, as the DOM's). */
const GLYPH = 48;

export interface AtlasCell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

interface Atlas {
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  cells: Map<string, AtlasCell>;
  /** Resolves once every glyph is drawn (the badges are there from the start). */
  ready: Promise<void>;
  /** The cells after Appendix G's, for DM's custom markers: "glyph|#colour" → its cell, drawn once. */
  custom: Map<string, { cell: AtlasCell; ready: Promise<void> }>;
}

let atlas: Atlas | null = null;

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** The atlas (made once per page). */
export function statusAtlas(): Atlas {
  if (atlas) return atlas;
  const rows = Math.ceil(STATUS_ICONS.length / COLS);
  const canvas = document.createElement("canvas");
  canvas.width = COLS * ATLAS_CELL;
  canvas.height = pow2(rows * ATLAS_CELL);
  const g = canvas.getContext("2d") as CanvasRenderingContext2D;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  const W = canvas.width;
  const H = canvas.height;
  const cells = new Map<string, AtlasCell>();
  const loads = STATUS_ICONS.map((icon, i) => {
    const cell = cellAt(i, W, H);
    cells.set(icon.id, cell);
    return drawCell(g, i, icon.svg, ICON_CATEGORIES[icon.category], C.bone100);
  });
  const ready = Promise.all(loads).then(() => {
    texture.needsUpdate = true;
  });
  atlas = { canvas, texture, cells, ready, custom: new Map() };
  return atlas;
}

/** Cell i's place — half a texel in, so mipmaps never bleed a neighbour's badge. */
function cellAt(i: number, W: number, H: number): AtlasCell {
  const x = (i % COLS) * ATLAS_CELL;
  const y = Math.floor(i / COLS) * ATLAS_CELL;
  return {
    u0: (x + 0.5) / W,
    u1: (x + ATLAS_CELL - 0.5) / W,
    v0: 1 - (y + ATLAS_CELL - 0.5) / H,
    v1: 1 - (y + 0.5) / H,
  };
}

/** Draws cell i: the badge in its colour now, the glyph (the project's own SVG) in its ink once the browser has it. */
function drawCell(g: CanvasRenderingContext2D, i: number, glyphSvg: string, badge: string, ink: string) {
  const x = (i % COLS) * ATLAS_CELL;
  const y = Math.floor(i / COLS) * ATLAS_CELL;
  const pad = 2;
  g.clearRect(x, y, ATLAS_CELL, ATLAS_CELL);
  g.beginPath();
  g.roundRect(x + pad, y + pad, ATLAS_CELL - 2 * pad, ATLAS_CELL - 2 * pad, 10);
  g.fillStyle = badge;
  g.fill();
  const svg = glyphSvg
    .replaceAll("currentColor", ink)
    .replace('width="24" height="24"', `width="${GLYPH}" height="${GLYPH}"`);
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      g.drawImage(img, x + (ATLAS_CELL - GLYPH) / 2, y + (ATLAS_CELL - GLYPH) / 2, GLYPH, GLYPH);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A DM's custom marker on the board (SPEC §8.11): the glyph it borrows on a badge of its own colour, its ink by
 * contrast (as the DOM draws it), in one of the atlas's spare cells — made once per glyph and colour. With every
 * spare cell taken (dozens of distinct markers on one page), the glyph's own cell.
 */
export function customCell(glyph: string, color: string): { cell: AtlasCell; ready: Promise<void> } {
  const a = statusAtlas();
  const icon = STATUS_ICONS.find((i) => i.id === glyph) ?? STATUS_ICONS.find((i) => i.id === "custom");
  if (!icon || !HEX.test(color)) return { cell: atlasCell(glyph), ready: a.ready };
  const key = `${icon.id}|${color.toLowerCase()}`;
  const known = a.custom.get(key);
  if (known) return known;
  const i = STATUS_ICONS.length + a.custom.size;
  const capacity = COLS * (a.canvas.height / ATLAS_CELL);
  if (i >= capacity) return { cell: atlasCell(icon.id), ready: a.ready };
  const g = a.canvas.getContext("2d") as CanvasRenderingContext2D;
  const ink = glyphInk(color) === "ink" ? C.ink950 : C.bone100;
  const ready = drawCell(g, i, icon.svg, color, ink).then(() => {
    a.texture.needsUpdate = true;
  });
  const entry = { cell: cellAt(i, a.canvas.width, a.canvas.height), ready };
  a.custom.set(key, entry);
  return entry;
}

/** A cell's place (a "custom:…" marker or an unknown id: the custom marker's glyph). */
export function atlasCell(id: string): AtlasCell {
  const a = statusAtlas();
  return a.cells.get(id) ?? (a.cells.get("custom") as AtlasCell);
}
