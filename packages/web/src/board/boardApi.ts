import { type Camera, type Object3D, Plane, Raycaster, Vector2, Vector3 } from "three";

/**
 * A small bridge from the DOM (HUD, drag-and-drop, keyboard) into the canvas: turn screen points into table
 * coordinates (feet; x = world X, y = world Z) and back. Filled in by the Board once the canvas exists.
 */
const ground = new Plane(new Vector3(0, 1, 0), 0);
const ray = new Raycaster();
const ndc = new Vector2();
const hit = new Vector3();
const scratch = new Vector3();

/**
 * The canvas's box on screen, cached: it changes only when the board is resized (a ResizeObserver and window resizes
 * keep it current), and asking the DOM on every pointer event forces a synchronous style and layout pass whenever
 * anything on the page changed since the last frame — tens of milliseconds inside a pointer handler.
 */
let rectCache: { el: HTMLElement; r: DOMRect } | null = null;
let observed: { el: HTMLElement; off: () => void } | null = null;
export function elementRect(el: HTMLElement): DOMRect {
  if (rectCache?.el === el) return rectCache.r;
  const r = el.getBoundingClientRect();
  rectCache = { el, r };
  if (observed?.el !== el) {
    observed?.off();
    const drop = () => {
      rectCache = null;
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(drop) : null;
    ro?.observe(el);
    window.addEventListener("resize", drop);
    window.addEventListener("scroll", drop, true);
    observed = {
      el,
      off: () => {
        ro?.disconnect();
        window.removeEventListener("resize", drop);
        window.removeEventListener("scroll", drop, true);
      },
    };
  }
  return r;
}

export const boardApi: {
  camera: Camera | null;
  element: HTMLElement | null;
  /** Last known cursor position on the table (for paste, Quick Unit, spotlight). */
  cursor: { x: number; y: number } | null;
  groundAt(clientX: number, clientY: number): { x: number; y: number } | null;
  /** The token drawn under a screen point (its id), or null. */
  tokenAt(clientX: number, clientY: number): string | null;
  /** The board's tokens group (set by TokensLayer), for picking. */
  tokens: Object3D | null;
  project(x: number, y: number, elevation?: number): { sx: number; sy: number } | null;
  /** A still of the board as it is now (for the travel freeze-frame), or null without a board. */
  snapshot(): HTMLCanvasElement | null;
  /** Frames the board has rendered (on-demand rendering: it stops counting while idle). */
  frames: number;
  /**
   * The pointer a token just took (its press handler runs before the board's): the board then knows the press was
   * on a token, whatever the hover state says (a quick move-and-click can beat the hover update).
   */
  claimedPointer: number | null;
} = {
  claimedPointer: null,
  tokens: null,
  tokenAt(clientX, clientY) {
    const cam = boardApi.camera;
    const el = boardApi.element;
    const root = boardApi.tokens;
    if (!cam || !el || !root) return null;
    const r = elementRect(el);
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    for (const hit of ray.intersectObject(root, true)) {
      // Plates, rings and ghosts don't count; the token's own parts carry its id up the tree.
      let o: Object3D | null = hit.object;
      while (o && !o.userData.tokenId) o = o.parent;
      if (o) return o.userData.tokenId as string;
    }
    return null;
  },
  snapshot: () => null,
  frames: 0,
  camera: null,
  element: null,
  cursor: null,
  groundAt(clientX, clientY) {
    const cam = boardApi.camera;
    const el = boardApi.element;
    if (!cam || !el) return null;
    const r = elementRect(el);
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    return ray.ray.intersectPlane(ground, hit) ? { x: hit.x, y: hit.z } : null;
  },
  project(x, y, elevation = 0) {
    const cam = boardApi.camera;
    const el = boardApi.element;
    if (!cam || !el) return null;
    const v = scratch.set(x, elevation, y).project(cam);
    if (v.z > 1) return null;
    const r = elementRect(el);
    return { sx: r.left + ((v.x + 1) / 2) * r.width, sy: r.top + ((1 - v.y) / 2) * r.height };
  },
};
