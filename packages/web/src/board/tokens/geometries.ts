import { type BufferGeometry, CylinderGeometry, PlaneGeometry, TorusGeometry } from "three";

/**
 * Token part geometries, shared by every token of the same size (bases, rings, coins, standee cards), so the GPU
 * holds one set per size rather than one per token (SPEC §24.8; AC-TOK-10 counts renderer geometries).
 */
const cache = new Map<string, BufferGeometry>();
const key = (...n: number[]) => n.map((x) => x.toFixed(3)).join(":");

function get(k: string, make: () => BufferGeometry): BufferGeometry {
  let g = cache.get(k);
  if (!g) {
    g = make();
    cache.set(k, g);
  }
  return g;
}

export const cylinder = (top: number, bottom: number, h: number, seg = 48) =>
  get(`cyl:${key(top, bottom, h, seg)}`, () => new CylinderGeometry(top, bottom, h, seg));
export const torus = (r: number, tube: number, seg = 64) =>
  get(`tor:${key(r, tube, seg)}`, () => new TorusGeometry(r, tube, 10, seg));
export const plane = (w: number, h: number) => get(`pln:${key(w, h)}`, () => new PlaneGeometry(w, h));
