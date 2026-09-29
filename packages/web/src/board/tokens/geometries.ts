import {
  type BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  LatheGeometry,
  PlaneGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { C } from "../colors.ts";

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
/**
 * A base's top (§8.5): a quarter-round bevel `b` high rising from its rim over the outer `w` of it to a flat, faintly
 * crowned middle — lit across the bevel like a coin's rim (critic P7 r2 #13: flat, the base read as a hole). Its
 * profile runs from the rim in (so the lathe's normals face out and up).
 */
export const baseTop = (r: number, w: number, b: number) =>
  get(`btop:${key(r, w, b)}`, () => {
    const pts: Vector2[] = [];
    const n = 8;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * (Math.PI / 2);
      pts.push(new Vector2(r - w + w * Math.cos(a), b * Math.sin(a)));
    }
    pts.push(new Vector2((r - w) * 0.5, b * 1.04), new Vector2(1e-4, b * 1.06));
    const g = new LatheGeometry(pts, 48);
    // Mapped from above (a disc's texture laid flat on it: baseTopTexture's gradient runs out from its middle).
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    if (pos && uv)
      for (let i = 0; i < pos.count; i++)
        uv.setXY(i, pos.getX(i) / (2 * r) + 0.5, pos.getZ(i) / (2 * r) + 0.5);
    return g;
  });

let topTexture: CanvasTexture | null = null;
/**
 * A base top's lacquer (critic P7 r2 #13: the dark disc, flat and unlit, read as a hole): lit slate in the middle
 * darkening to its rim (ink-500 → ink-600 → ink-700), and a thin sheen where the flat middle turns down into the bevel.
 * Symmetric, so it turns with its token unchanged; one texture for every base.
 */
export function baseTopTexture(): CanvasTexture {
  if (topTexture) return topTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, C.ink500);
  grad.addColorStop(0.62, C.ink600);
  grad.addColorStop(1, C.baseInk);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  g.globalAlpha = 0.45;
  g.strokeStyle = C.fog400;
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(64, 64, 64 * 0.83, 0, Math.PI * 2);
  g.stroke();
  topTexture = new CanvasTexture(c);
  topTexture.colorSpace = SRGBColorSpace;
  topTexture.anisotropy = 4;
  return topTexture;
}
/** A standee's foot (§8.5 "a small base"): a low slab the card stands in, rounded at its ends. */
export const standeeFoot = (w: number, d: number, h: number) =>
  get(`foot:${key(w, d, h)}`, () => {
    const g = new CylinderGeometry(d / 2, d / 2, h, 24, 1, false);
    // A stadium: the round slab stretched to the foot's width (ends stay round, the long sides flat enough).
    g.scale(w / d, 1, 1);
    return g;
  });

/** A standee card's thickness (SPEC §24: a 0.15-ft cardboard edge). */
export const CARD_T = 0.15;
const CARD_LAYERS = 10;
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
