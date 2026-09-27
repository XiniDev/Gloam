import { type Camera, Plane, Raycaster, Vector2, Vector3 } from "three";

/**
 * A small bridge from the DOM (HUD, drag-and-drop, keyboard) into the canvas: turn screen points into table
 * coordinates (feet; x = world X, y = world Z) and back. Filled in by the Board once the canvas exists.
 */
const ground = new Plane(new Vector3(0, 1, 0), 0);
const ray = new Raycaster();
const ndc = new Vector2();
const hit = new Vector3();

export const boardApi: {
  camera: Camera | null;
  element: HTMLElement | null;
  /** Last known cursor position on the table (for paste, Quick Unit, spotlight). */
  cursor: { x: number; y: number } | null;
  groundAt(clientX: number, clientY: number): { x: number; y: number } | null;
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
  snapshot: () => null,
  frames: 0,
  camera: null,
  element: null,
  cursor: null,
  groundAt(clientX, clientY) {
    const cam = boardApi.camera;
    const el = boardApi.element;
    if (!cam || !el) return null;
    const r = el.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    return ray.ray.intersectPlane(ground, hit) ? { x: hit.x, y: hit.z } : null;
  },
  project(x, y, elevation = 0) {
    const cam = boardApi.camera;
    const el = boardApi.element;
    if (!cam || !el) return null;
    const v = new Vector3(x, elevation, y).project(cam);
    if (v.z > 1) return null;
    const r = el.getBoundingClientRect();
    return { sx: r.left + ((v.x + 1) / 2) * r.width, sy: r.top + ((1 - v.y) / 2) * r.height };
  },
};
