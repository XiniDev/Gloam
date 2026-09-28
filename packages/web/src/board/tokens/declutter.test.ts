import { BoxGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, Scene } from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  layoutOverlays,
  overlayClear,
  overlayDiagnostics,
  overlayOffset,
  registerOverlay,
  setOverlayBody,
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
/** A token with no plate on screen (off to the side of the scene): only its body counts. */
function bodyOnly(id: string) {
  const g = new Group();
  const m = new Mesh(new BoxGeometry(1, 1, 1), mat);
  m.position.set(-500, 0, -500);
  g.add(m);
  scene.add(g);
  undo.push(registerOverlay(id, g, () => 0));
  undo.push(() => scene.remove(g));
}

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

  it("moves a plate aside onto a spot clear of other tokens, not onto one of them", () => {
    plate("hero", 100, 60, 3);
    plate("goblin", 110, 60, 1);
    // The spot to the goblin plate's right is free of plates, but another token stands there.
    setOverlayBody("hero", { x0: 125, y0: 55, x1: 150, y1: 80 });
    setOverlayBody("goblin", { x0: 98, y0: 65, x1: 122, y1: 90 });
    layoutOverlays(camera, W, H);
    const g = rect("goblin");
    expect(overlayClear("goblin")).toBe(1);
    expect(g && g.x0 < 150 && g.x1 > 125 && g.y0 < 80 && g.y1 > 55).toBe(false);
  });

  it("moves a plate off a neighbour it would bury, but not off one whose edge it only clips", () => {
    plate("south", 100, 60, 1);
    plate("west", 40, 60, 1);
    // A token just above the south plate's own spot, nearly all under it; another only clipped at its corner.
    bodyOnly("north");
    setOverlayBody("north", { x0: 85, y0: 52, x1: 115, y1: 70 });
    bodyOnly("rim");
    setOverlayBody("rim", { x0: 55, y0: 62, x1: 80, y1: 90 });
    layoutOverlays(camera, W, H);
    expect(overlayClear("south")).toBe(1);
    expect(overlayOffset("south")).not.toEqual({ dx: 0, dy: 0 });
    expect(overlayOffset("west")).toEqual({ dx: 0, dy: 0 });
  });

  it("never hides a plate to keep a token clear: in a corner with nowhere else to go, it stays over the token", () => {
    // Top-left corner: every spot aside is off the screen or covers most of the neighbour.
    plate("mira", 20, 12, 2);
    bodyOnly("ash");
    setOverlayBody("ash", { x0: 5, y0: 5, x1: 45, y1: 20 });
    layoutOverlays(camera, W, H);
    expect(overlayClear("mira")).toBe(1);
  });

  it("keeps plates out from under the HUD: one there moves beside it; a token under it shows none", () => {
    plate("edge", 100, 50, 1);
    plate("under", 180, 50, 1);
    setOverlayBody("under", { x0: 170, y0: 55, x1: 190, y1: 75 });
    // A panel over the right of the board, covering the edge plate's own spot's right end and all of "under".
    const panel = [{ x0: 115, y0: 0, x1: W, y1: H }];
    layoutOverlays(camera, W, H, panel);
    expect(overlayClear("edge")).toBe(1);
    const r = rect("edge");
    expect(r && r.x1 <= 115).toBe(true);
    expect(overlayClear("under")).toBe(0);
  });

  it("still shows a plate over a token when that's the only room left", () => {
    plate("hero", 100, 50, 3);
    plate("goblin", 100, 50, 1);
    // Every other spot is on some token.
    setOverlayBody("hero", { x0: 0, y0: 0, x1: W, y1: H });
    layoutOverlays(camera, W, H);
    expect(overlayClear("goblin")).toBe(1);
  });
});
