import { ICON_CATEGORIES, STATUS_ICONS } from "@gloam/shared/icons";
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from "three";
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
    const x = (i % COLS) * ATLAS_CELL;
    const y = Math.floor(i / COLS) * ATLAS_CELL;
    // Half a texel in, so mipmaps never bleed a neighbour's badge.
    cells.set(icon.id, {
      u0: (x + 0.5) / W,
      u1: (x + ATLAS_CELL - 0.5) / W,
      v0: 1 - (y + ATLAS_CELL - 0.5) / H,
      v1: 1 - (y + 0.5) / H,
    });
    const pad = 2;
    g.beginPath();
    g.roundRect(x + pad, y + pad, ATLAS_CELL - 2 * pad, ATLAS_CELL - 2 * pad, 10);
    g.fillStyle = ICON_CATEGORIES[icon.category];
    g.fill();
    const svg = icon.svg
      .replaceAll("currentColor", C.bone100)
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
  });
  const ready = Promise.all(loads).then(() => {
    texture.needsUpdate = true;
  });
  atlas = { canvas, texture, cells, ready };
  return atlas;
}

/** A cell's place (a "custom:…" marker or an unknown id: the custom marker's glyph). */
export function atlasCell(id: string): AtlasCell {
  const a = statusAtlas();
  return a.cells.get(id) ?? (a.cells.get("custom") as AtlasCell);
}
