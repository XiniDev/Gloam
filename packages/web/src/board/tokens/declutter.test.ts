import { BoxGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, Scene } from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  layoutOverlays,
  overlayClear,
  overlayDiagnostics,
  overlayOffset,
  registerOverlay,
} from "./declutter.ts";

// A 200 × 100 px screen over a top-down orthographic camera: one foot is one pixel, x right, z down.
const W = 200;
const H = 100;
const camera = new OrthographicCamera(0, W, 0, -H, 0.1, 100);
camera.position.set(0, 50, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
camera.updateProjectionMatrix();

const scene = new Scene();
const mat = new MeshBasicMaterial();
const undo: (() => void)[] = [];

/** An overlay (a plate 40 × 10 px) whose own spot is centred at screen (x, y). */
function plate(id: string, x: number, y: number, priority = 1) {
  const g = new Group();
  const m = new Mesh(new BoxGeometry(40, 1, 10), mat);
  m.position.set(x, 0, y);
  g.add(m);
  scene.add(g);
  undo.push(registerOverlay(id, g, () => priority));
  undo.push(() => scene.remove(g));
  return g;
}
const rect = (id: string) => overlayDiagnostics().find((d) => d.id === id)?.rect;

afterEach(() => {
  for (const u of undo.splice(0)) u();
});

describe("overlay declutter", () => {
  it("keeps a plate in its own spot when it's free", () => {
    plate("a", 100, 50);
    layoutOverlays(camera, W, H);
    expect(overlayClear("a")).toBe(1);
    expect(overlayOffset("a")).toEqual({ dx: 0, dy: 0 });
  });

  it("slides a plate cut off by the screen's edge back onto it, and hides one whose token is off it", () => {
    plate("left", 5, 50);
    plate("right", 190, 20);
    plate("gone", 260, 80);
    layoutOverlays(camera, W, H);
    expect(overlayClear("left")).toBe(1);
    expect(overlayOffset("left").dy).toBe(0);
    expect(rect("left")?.x0).toBeCloseTo(4, 3);
    expect(overlayClear("right")).toBe(1);
    expect(rect("right")?.x1).toBeCloseTo(W - 4, 3);
    // More than its own width off the screen: its token isn't on it.
    expect(overlayClear("gone")).toBe(0);
  });

  it("moves the lower-priority plate of two that collide beside the other, not away", () => {
    plate("hero", 100, 60, 3);
    plate("goblin", 110, 60, 1);
    layoutOverlays(camera, W, H);
    expect(overlayOffset("hero")).toEqual({ dx: 0, dy: 0 });
    expect(overlayClear("goblin")).toBe(1);
    const a = rect("hero");
    const b = rect("goblin");
    expect(a && b).toBeTruthy();
    const overlap = a && b && a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    expect(overlap).toBe(false);
  });
});
