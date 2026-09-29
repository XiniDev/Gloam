import { BoxGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, Scene } from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  bodyDepth,
  crosses,
  layoutOverlays,
  leaderFor,
  leaderSegment,
  NAMES_FROM_PX,
  overlayClear,
  overlayCompact,
  overlayDiagnostics,
  overlayOffset,
  PRIORITY,
  registerOverlay,
  rimEntry,
  seenPart,
  setBoardMarks,
  setOverlayBody,
  setOverlaySpots,
  without,
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

  it("moves a plate off an effect's handle it would sit on (the board's marks count as bodies)", () => {
    plate("south", 100, 60, 1);
    // A handle (28 px square) right under the plate's own spot.
    setBoardMarks("effect-handles", [{ x0: 86, y0: 46, x1: 114, y1: 74 }]);
    layoutOverlays(camera, W, H);
    setBoardMarks("effect-handles", []);
    const r = rect("south");
    expect(overlayClear("south")).toBe(1);
    expect(r && r.x0 < 114 && r.x1 > 86 && r.y0 < 74 && r.y1 > 46).toBe(false);
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

  it("nudges a plate whose side just touches the HUD sideways off it, instead of hiding or moving it far", () => {
    plate("rail", 100, 50, 1);
    // A rail over the right of the screen, 0.2 px into the plate's own spot (80–120).
    layoutOverlays(camera, W, H, [{ x0: 119.8, y0: 0, x1: W, y1: H }]);
    expect(overlayClear("rail")).toBe(1);
    const dx = overlayOffset("rail").dx;
    expect(dx).toBeLessThan(0);
    expect(dx).toBeGreaterThan(-2);
  });

  it("moves a plate whose own spot sits on another token's face under its own base (critic P6 r2 #5)", () => {
    // Thorin in front, Mira's tall standee right behind him: his plate's own spot lands on her art — a small share
    // of her body, but its centre is on her, so it reads as hers.
    plate("thorin", 100, 40, 3);
    setOverlayBody("thorin", { x0: 75, y0: 46, x1: 125, y1: 80 });
    bodyOnly("mira");
    setOverlayBody("mira", { x0: 70, y0: 0, x1: 130, y1: 45 });
    layoutOverlays(camera, W, H);
    expect(overlayClear("thorin")).toBe(1);
    const r = rect("thorin");
    // Under his base, centred on him.
    expect(r?.y0).toBeCloseTo(80 + 6, 3);
    expect(overlayOffset("thorin").dx).toBe(0);
  });

  it("slides a plate under its base onto the screen for a token at the edge", () => {
    // Thorin at the left edge, Mira behind him: his own spot (half off the screen) and its slide are on her.
    plate("thorin", 10, 40, 3);
    setOverlayBody("thorin", { x0: -15, y0: 46, x1: 35, y1: 80 });
    bodyOnly("mira");
    setOverlayBody("mira", { x0: -20, y0: 0, x1: 60, y1: 45 });
    layoutOverlays(camera, W, H);
    expect(overlayClear("thorin")).toBe(1);
    expect(rect("thorin")?.y0).toBeCloseTo(86, 3);
    expect(rect("thorin")?.x0).toBeCloseTo(4, 3);
  });

  it("nudges the plate under a base sideways off a HUD piece beside it", () => {
    // As above, but a toolbar stands where the left of the spot under his base would be.
    plate("thorin", 100, 40, 3);
    setOverlayBody("thorin", { x0: 75, y0: 46, x1: 125, y1: 80 });
    bodyOnly("mira");
    setOverlayBody("mira", { x0: 70, y0: 0, x1: 130, y1: 45 });
    layoutOverlays(camera, W, H, [{ x0: 0, y0: 60, x1: 90, y1: H }]);
    expect(overlayClear("thorin")).toBe(1);
    const r = rect("thorin");
    expect(r?.y0).toBeCloseTo(86, 3);
    expect(r && r.x0 >= 90).toBe(true);
  });

  it("puts a plate whose own spot is off the top or under the HUD under its base, not over its own token", () => {
    // Mira's standee reaches past the top of the screen: her plate's own spot is above it.
    plate("mira", 100, -3, 2);
    setOverlayBody("mira", { x0: 70, y0: -20, x1: 130, y1: 60 });
    layoutOverlays(camera, W, H);
    expect(overlayClear("mira")).toBe(1);
    expect(rect("mira")?.y0).toBeCloseTo(60 + 6, 3);
    expect(overlayOffset("mira").dx).toBe(0);
    // A card over her plate's spot (the DM's prompt, a request): under her base too — never pushed onto her face.
    layoutOverlays(camera, W, H, [{ x0: 60, y0: 0, x1: 140, y1: 12 }]);
    expect(overlayClear("mira")).toBe(1);
    expect(rect("mira")?.y0).toBeCloseTo(66, 3);
  });

  it("puts a plate beside its token at mid-height when its own spot and under its base are taken, before rows above (critic P7 r2 #1)", () => {
    // As above, with a bar along the bottom of the screen where the spot under her base would be.
    plate("mira", 100, -3, 2);
    setOverlayBody("mira", { x0: 70, y0: -20, x1: 130, y1: 60 });
    layoutOverlays(camera, W, H, [{ x0: 0, y0: 62, x1: W, y1: H }]);
    expect(overlayClear("mira")).toBe(1);
    const r = rect("mira");
    // Right of her, 8 px off, centred on the height of what shows of her (0–60).
    expect(r?.x0).toBeCloseTo(138, 3);
    expect(((r?.y0 ?? 0) + (r?.y1 ?? 0)) / 2).toBeCloseTo(30, 3);
    // Its leader runs straight back to her.
    const l = overlayDiagnostics().find((d) => d.id === "mira")?.leaderLine;
    expect(l?.sx).toBeCloseTo(138, 3);
    expect(l && l.ex < 130 && l.ex > 70).toBe(true);
  });

  it("brings a visible token's plate down onto the free board when its own spot is off the top and under and beside it are taken", () => {
    // As above, with the HUD down both sides of her too.
    plate("mira", 100, -3, 2);
    setOverlayBody("mira", { x0: 70, y0: -20, x1: 130, y1: 60 });
    const bottom = { x0: 0, y0: 62, x1: W, y1: H };
    const sides = [
      { x0: 0, y0: 0, x1: 66, y1: H },
      { x0: 134, y0: 0, x1: W, y1: H },
    ];
    layoutOverlays(camera, W, H, [bottom, ...sides]);
    expect(overlayClear("mira")).toBe(1);
    expect(rect("mira")?.y0).toBeCloseTo(4, 3);
    // With a top bar over its column: just under the bar.
    layoutOverlays(camera, W, H, [{ x0: 0, y0: 0, x1: W, y1: 14 }, bottom, ...sides]);
    expect(overlayClear("mira")).toBe(1);
    expect(rect("mira")?.y0).toBeCloseTo(17, 3);
    // Its token wholly above the free board: nothing to bring it down onto.
    setOverlayBody("mira", { x0: 70, y0: -40, x1: 130, y1: 12 });
    layoutOverlays(camera, W, H, [{ x0: 0, y0: 0, x1: W, y1: 14 }]);
    expect(overlayClear("mira")).toBe(0);
  });

  it("keeps a plate off a neighbour's footprint even where it would cover only a little of it (critic P7 r2 #1)", () => {
    // The front token's own spot reaches 9 px into the corner of the one behind it: under a tenth of that token, but
    // a plate on a creature reads as its.
    plate("front", 100, 40, 1);
    setOverlayBody("front", { x0: 85, y0: 46, x1: 115, y1: 70 });
    bodyOnly("back");
    setOverlayBody("back", { x0: 110, y0: 20, x1: 150, y1: 44 });
    layoutOverlays(camera, W, H);
    expect(overlayClear("front")).toBe(1);
    // Under its base.
    expect(rect("front")?.y0).toBeCloseTo(76, 3);
    expect(overlayDiagnostics().find((x) => x.id === "front")?.tier).toBe(0);
  });

  it("a standee behind a lying creature: each plate by its own creature, none on the other, no leader across either (critic P7 r2 #1)", () => {
    // Thorin lies in front; Mira's card stands behind him, its foot under his body. His own spot is on her card; hers
    // is off the top of the screen, and under her base is his body.
    plate("thorin", 100, 44, 3);
    setOverlayBody("thorin", { x0: 60, y0: 50, x1: 140, y1: 80 });
    plate("mira", 90, 4, 2);
    setOverlayBody("mira", { x0: 70, y0: 10, x1: 110, y1: 55 });
    layoutOverlays(camera, W, H);
    const t = rect("thorin");
    const m = rect("mira");
    expect(overlayClear("thorin")).toBe(1);
    expect(overlayClear("mira")).toBe(1);
    // His under his base; hers beside her card — on neither creature.
    expect(t?.y0).toBeCloseTo(86, 3);
    expect(m?.x0).toBeCloseTo(118, 3);
    const on = (a: typeof t, b: { x0: number; y0: number; x1: number; y1: number }) =>
      !!a &&
      Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 4 &&
      Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 4;
    expect(on(t, { x0: 70, y0: 10, x1: 110, y1: 55 })).toBe(false);
    expect(on(m, { x0: 60, y0: 50, x1: 140, y1: 80 })).toBe(false);
    // Her leader ends on the part of her card his body doesn't cover, and crosses neither him nor his plate.
    const l = overlayDiagnostics().find((x) => x.id === "mira")?.leaderLine;
    expect(l).toBeTruthy();
    expect(l && Math.max(l.sy, l.ey) < 50).toBe(true);
  });

  it("never moves a plate to where it stands nearer another creature than its own", () => {
    // Its own spot is under the HUD; under its base is 2 px above another creature (6 px under its own): it would
    // read as that one's. Beside it instead.
    plate("a", 100, 34, 1);
    setOverlayBody("a", { x0: 80, y0: 40, x1: 120, y1: 60 });
    bodyOnly("c");
    setOverlayBody("c", { x0: 80, y0: 78, x1: 120, y1: 98 });
    layoutOverlays(camera, W, H, [{ x0: 60, y0: 0, x1: 140, y1: 39 }]);
    expect(overlayClear("a")).toBe(1);
    expect(rect("a")?.x0).toBeCloseTo(128, 3);
  });

  it("keeps the plate of a token mostly on the free board though its centre is under the HUD, its leader to the part that shows (critic P7 r2 #6)", () => {
    // 60 px wide, 25 of them left of a panel: 42 % of it shows; its centre (130) is under the panel.
    plate("half", 130, 50, 1);
    setOverlayBody("half", { x0: 100, y0: 55, x1: 160, y1: 75 });
    // Hardly any of this one shows: 8 of 40 px.
    plate("sliver", 60, 20, 1);
    setOverlayBody("sliver", { x0: 32, y0: 25, x1: 72, y1: 45 });
    const panel = { x0: 125, y0: 0, x1: W, y1: H };
    const rail = { x0: 0, y0: 0, x1: 64, y1: H };
    layoutOverlays(camera, W, H, [panel, rail]);
    expect(overlayClear("half")).toBe(1);
    expect(overlayClear("sliver")).toBe(0);
    const r = rect("half");
    expect(r && r.x1 <= 125).toBe(true);
    // Its leader, drawn from where the plate is now, ends on the part left of the panel.
    const l = leaderFor("half", r as NonNullable<typeof r>, { x0: 100, y0: 55, x1: 160, y1: 75 });
    expect(l).toBeTruthy();
    expect(l?.ex).toBeLessThan(125);
  });

  it("leader geometry: from the plate's nearest edge to a point well inside the token; a segment crossing a box", () => {
    const l = leaderSegment({ x0: 0, y0: 0, x1: 40, y1: 10 }, { x0: 60, y0: 20, x1: 100, y1: 60 });
    // Inset by 14 (0.35 × 40): the end at (74, 34), the start on the plate's edge nearest it.
    expect(l).toEqual({ sx: 40, sy: 10, ex: 74, ey: 34 });
    expect(crosses(l, { x0: 50, y0: 10, x1: 60, y1: 30 })).toBe(true);
    expect(crosses(l, { x0: 0, y0: 30, x1: 30, y1: 60 })).toBe(false);
    // The largest part of a box beside a cut, and what of a body shows.
    expect(without({ x0: 0, y0: 0, x1: 100, y1: 40 }, { x0: 70, y0: -10, x1: 120, y1: 50 })).toEqual({
      x0: 0,
      y0: 0,
      x1: 70,
      y1: 40,
    });
    expect(
      seenPart({ x0: -20, y0: 10, x1: 80, y1: 50 }, [{ x0: 60, y0: 0, x1: 200, y1: 100 }], 200, 100),
    ).toEqual({ x0: 0, y0: 10, x1: 60, y1: 50 });
  });

  it("shows a compact plate — its bar alone — above its token, or low on its own face, before a full plate on another creature (critic P7 r2 #1)", () => {
    // A goblin with another creature right behind it; the HUD takes the spots under and beside it.
    plate("g", 100, 30, 1);
    setOverlaySpots("g", { x0: 70, y0: 25, x1: 130, y1: 38 }, { x0: 88, y0: 32, x1: 112, y1: 38 });
    setOverlayBody("g", { x0: 80, y0: 40, x1: 120, y1: 60 });
    bodyOnly("n");
    setOverlayBody("n", { x0: 60, y0: 10, x1: 140, y1: 35 });
    const hud = [
      { x0: 0, y0: 62, x1: W, y1: H },
      { x0: 0, y0: 0, x1: 66, y1: H },
      { x0: 134, y0: 0, x1: W, y1: H },
    ];
    layoutOverlays(camera, W, H, hud);
    // The full plate has nowhere clear of the creature behind; the compact one fits above the goblin (its bottom 2 px
    // into the gap, clear of the other's box).
    expect(overlayClear("g")).toBe(1);
    expect(overlayCompact("g")).toBe(true);
    expect(rect("g")).toEqual({ x0: 88, y0: 32, x1: 112, y1: 38 });
    // The creature behind reaches further down: above is taken too — onto its own face, low on it, with no leader.
    setOverlayBody("n", { x0: 60, y0: 10, x1: 140, y1: 41 });
    layoutOverlays(camera, W, H, hud);
    expect(overlayCompact("g")).toBe(true);
    const r = rect("g");
    expect(r?.x0).toBeCloseTo(88, 3);
    expect(((r?.y0 ?? 0) + (r?.y1 ?? 0)) / 2).toBeCloseTo(53, 3);
    expect(overlayDiagnostics().find((d) => d.id === "g")?.leaderLine).toBeNull();
    // With room again, the full plate comes back.
    setOverlayBody("n", { x0: 60, y0: 0, x1: 140, y1: 10 });
    layoutOverlays(camera, W, H, hud);
    expect(overlayCompact("g")).toBe(false);
    expect(rect("g")).toEqual({ x0: 70, y0: 25, x1: 130, y1: 38 });
  });

  it("zoomed out, a small creature shows its bar alone and its name only on hover, selection or its turn (critic P9 r1 #19)", () => {
    // A 20-px goblin with room all round: at a wide view, its bar alone, in its own spot.
    let p: number = PRIORITY.other;
    const g = new Group();
    const m = new Mesh(new BoxGeometry(40, 1, 10), mat);
    m.position.set(100, 0, 30);
    g.add(m);
    scene.add(g);
    undo.push(registerOverlay("far", g, () => p));
    undo.push(() => scene.remove(g));
    setOverlaySpots("far", { x0: 70, y0: 25, x1: 130, y1: 38 }, { x0: 90, y0: 32, x1: 110, y1: 38 });
    setOverlayBody("far", { x0: 90, y0: 40, x1: 110, y1: 60 });
    layoutOverlays(camera, W, H);
    expect(overlayCompact("far")).toBe(true);
    expect(rect("far")).toEqual({ x0: 90, y0: 32, x1: 110, y1: 38 });
    // Its turn (or hovered, selected): its name comes back.
    p = PRIORITY.turn;
    layoutOverlays(camera, W, H);
    expect(overlayCompact("far")).toBe(false);
    p = PRIORITY.other;
    layoutOverlays(camera, W, H);
    expect(overlayCompact("far")).toBe(true);
    // Zoomed in (the creature NAMES_FROM_PX across or more): the full plate.
    setOverlayBody("far", { x0: 100 - NAMES_FROM_PX / 2, y0: 40, x1: 100 + NAMES_FROM_PX / 2, y1: 60 });
    layoutOverlays(camera, W, H);
    expect(overlayCompact("far")).toBe(false);
  });

  it("measures a round token as the ellipse it is: a plate in the corner of its box (air) keeps its spot; the same corner of a card doesn't", () => {
    // A goblin's plate reaching 10 px into the corner of the box round an ogre's coin, clear of the coin itself.
    plate("gob", 100, 55, 1);
    setOverlayBody("gob", { x0: 85, y0: 61, x1: 115, y1: 90 });
    bodyOnly("ogre");
    const box = { x0: 110, y0: 0, x1: 190, y1: 60 };
    setOverlayBody("ogre", box, [{ kind: "ellipse", ...box }]);
    layoutOverlays(camera, W, H);
    expect(overlayOffset("gob")).toEqual({ dx: 0, dy: 0 });
    expect(overlayDiagnostics().find((d) => d.id === "gob")?.tier).toBe(0);
    // A standee's card there instead: that corner is card, and the plate moves off it.
    setOverlayBody("ogre", box, [{ kind: "box", ...box }]);
    layoutOverlays(camera, W, H);
    expect(overlayOffset("gob")).not.toEqual({ dx: 0, dy: 0 });
    expect(bodyDepth({ x0: 80, y0: 50, x1: 120, y1: 60 }, [{ kind: "ellipse", ...box }])).toBe(0);
    expect(bodyDepth({ x0: 80, y0: 50, x1: 120, y1: 60 }, [{ kind: "box", ...box }])).toBe(10);
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

describe("a leader's end (critic P9 r1 #23: drawn to the rim, not onto the token's face)", () => {
  const body = { x0: 100, y0: 100, x1: 140, y1: 120 };
  it("meets the ellipse its body's box holds, coming from the plate", () => {
    // From the left, level with the centre: the rim's leftmost point.
    const p = rimEntry({ sx: 40, sy: 110, ex: 125, ey: 110 }, body);
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(110, 6);
    // From above: its top.
    const q = rimEntry({ sx: 120, sy: 20, ex: 120, ey: 112 }, body);
    expect(q.x).toBeCloseTo(120, 6);
    expect(q.y).toBeCloseTo(100, 6);
    // Diagonally: on the ellipse.
    const r = rimEntry({ sx: 60, sy: 60, ex: 118, ey: 108 }, body);
    expect(((r.x - 120) / 20) ** 2 + ((r.y - 110) / 10) ** 2).toBeCloseTo(1, 6);
  });
  it("keeps its end when the line never reaches the rim, and its start when it starts inside", () => {
    expect(rimEntry({ sx: 0, sy: 0, ex: 50, ey: 50 }, body)).toEqual({ x: 50, y: 50 });
    expect(rimEntry({ sx: 120, sy: 110, ex: 160, ey: 110 }, body)).toEqual({ x: 120, y: 110 });
  });
});
