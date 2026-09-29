import { type BufferGeometry, CylinderGeometry, PlaneGeometry, TorusGeometry } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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

/** A standee card's thickness (SPEC §24: a 0.15-ft cardboard edge). */
export const CARD_T = 0.15;
const CARD_LAYERS = 6;
/**
 * A standee card's edge: the card's shape stacked through its thickness (alpha-tested with the art's alpha, so a
 * cut-out drawing's edge follows its outline, not a rectangle), both ways round — one mesh, one draw call. The front
 * and back faces cover all but the edge; seen from above, its top edge reads as cardboard.
 */
export const cardEdge = (w: number, h: number) =>
  get(`edge:${key(w, h)}`, () => {
    const parts: BufferGeometry[] = [];
    for (let i = 0; i < CARD_LAYERS; i++) {
      const z = -CARD_T / 2 + (CARD_T * (i + 0.5)) / CARD_LAYERS;
      const front = new PlaneGeometry(w, h).translate(0, 0, z);
      const back = new PlaneGeometry(w, h).rotateY(Math.PI).translate(0, 0, z);
      parts.push(front, back);
    }
    const g = mergeGeometries(parts) as BufferGeometry;
    for (const p of parts) p.dispose();
    return g;
  });
