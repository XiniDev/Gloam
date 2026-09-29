import { contains, type Footprint } from "@gloam/shared/aoe";
import {
  CylinderGeometry,
  IcosahedronGeometry,
  type Mesh,
  type Object3D,
  type ShaderMaterial,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { PRESETS } from "./palette.ts";
import { areaBurst, areaLoop, whereOf } from "./presets.ts";
import { footprintGeometry } from "./shapes.ts";

/**
 * The VFX follow an area's footprint (SPEC §17, §24.5): a cone, a line, a cube or a wall draws its flashes, scorches,
 * webs and mists over its own shape — never a disc round its middle that spills past its edges, nor a sphere of fire
 * round a line. And a wall stands as tall as the wall is.
 */

const O = { x: 40, y: 30 };
const SHAPES: Record<string, Record<string, unknown>> = {
  cone: { kind: "cone", origin: O, dirDeg: 30, length: 15 },
  line: { kind: "line", origin: O, dirDeg: 250, length: 100, width: 5 },
  cube: { kind: "cube", origin: O, dirDeg: 0, size: 20, originOnFace: false },
  wall: {
    kind: "wall",
    points: [
      { x: 20, y: 20 },
      { x: 50, y: 35 },
      { x: 60, y: 60 },
    ],
    closed: false,
    height: 20,
    thickness: 1,
  },
};
const noBody = () => null;

/** Every floor piece's vertices on the map plane (x, z of the world). */
function floorPoints(root: Object3D): { x: number; y: number }[] {
  root.updateMatrixWorld(true);
  const out: { x: number; y: number }[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    const u = (m.material as ShaderMaterial | undefined)?.uniforms;
    // Floor pieces: rings and decals (flat, turned to lie on the floor).
    if (!m.isMesh || !u || !("uRunes" in u || "uKind" in u)) return;
    const pos = m.geometry.getAttribute("position");
    const v = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push({ x: v.x, y: v.z });
    }
  });
  return out;
}

/** Inside the footprint, give or take `slack` ft (a wall's burnt ground reaches 2 ft either side of its line). */
function within(f: Footprint, q: { x: number; y: number }, slack: number): boolean {
  if (contains(f, q)) return true;
  if (f.kind === "strip") return contains({ ...f, halfWidth: Math.max(f.halfWidth, slack) + 1e-3 }, q);
  if (f.kind === "poly") {
    // Near an edge (float error on a vertex).
    return f.points.some((a, i) => {
      const b = f.points[(i + 1) % f.points.length] as { x: number; y: number };
      const t = Math.max(
        0,
        Math.min(
          1,
          ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2),
        ),
      );
      return Math.hypot(a.x + (b.x - a.x) * t - q.x, a.y + (b.y - a.y) * t - q.y) < 1e-3 + slack;
    });
  }
  return false;
}

describe("P9 — the VFX follow an area's footprint", () => {
  it("footprintGeometry: a fan from the middle (edge 1) to the rim (edge 0); a wall a ribbon (1 on its line, 0 at its sides)", () => {
    const poly: Footprint = {
      kind: "poly",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    };
    const g = footprintGeometry(poly, { x: 5, y: 5 });
    const e = g.getAttribute("edge");
    const pos = g.getAttribute("position");
    expect(e.getX(0)).toBe(1);
    expect([pos.getX(0), pos.getY(0)]).toEqual([0, -0]);
    for (let i = 1; i < e.count; i++) expect(e.getX(i)).toBe(0);
    // Placed about (5, 5), the plane's y is the map's −y: (10, 0) is at (5, 5).
    expect([pos.getX(2), pos.getY(2)]).toEqual([5, 5]);
    const strip: Footprint = {
      kind: "strip",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      closed: false,
      halfWidth: 0.5,
    };
    const w = footprintGeometry(strip, { x: 0, y: 0 }, 2);
    const we = w.getAttribute("edge");
    const wp = w.getAttribute("position");
    expect([we.getX(0), we.getX(1), we.getX(2)]).toEqual([0, 1, 0]);
    // At least 2 ft either side of the line (the burnt ground), not the wall's 1-ft thickness.
    expect(Math.abs(wp.getY(0) - wp.getY(2))).toBeCloseTo(4, 5);
  });

  for (const [name, shape] of Object.entries(SHAPES))
    it(`a ${name}: every preset's cast burst and lasting look keep their floor pieces to its footprint, with no sphere or pillar round it`, () => {
      const w = whereOf(shape, null, noBody);
      expect(w).not.toBeNull();
      if (!w?.f) return;
      for (const preset of PRESETS) {
        const burst = areaBurst(preset, w, 1, 7).root;
        const loop = areaLoop(
          preset,
          w,
          {},
          "Test",
          name,
          1,
          7,
          name === "wall" ? (shape.points as never) : undefined,
          {
            height: 20,
          },
        );
        for (const root of [burst, loop]) {
          const pts = floorPoints(root);
          const out = pts.filter((q) => !within(w.f as Footprint, q, 2));
          expect(out, `${preset} ${name}: ${out.length} of ${pts.length} floor vertices outside`).toEqual([]);
          root.traverse((o) => {
            const g = (o as Mesh).geometry;
            expect(g instanceof IcosahedronGeometry, `${preset} ${name}: a shell round a ${name}`).toBe(
              false,
            );
            expect(g instanceof CylinderGeometry, `${preset} ${name}: a pillar round a ${name}`).toBe(false);
          });
        }
      }
    });

  it("lasting looks over a cube follow it: Web's strands, a light haze, a heavy cloud and darkness", () => {
    const w = whereOf(SHAPES.cube, null, noBody);
    if (!w?.f) throw new Error("no footprint");
    for (const props of [
      { difficult: true, obscurement: "light" },
      { obscurement: "heavy" },
      { magicalDarkness: true },
    ]) {
      const root = areaLoop("arcane", w, props, "Test", "cube", 1, 7);
      const pts = floorPoints(root);
      expect(pts.length).toBeGreaterThan(0);
      expect(pts.filter((q) => !within(w.f as Footprint, q, 0))).toEqual([]);
    }
  });

  it("a wall stands as tall as it is: Wall of Fire's flames and every other wall's pane", () => {
    const w = whereOf(SHAPES.wall, null, noBody);
    if (!w) throw new Error("no where");
    for (const preset of ["fire", "cold", "force"] as const) {
      const root = areaLoop(preset, w, {}, "Wall", "wall", 1, 7, SHAPES.wall?.points as never, {
        height: 20,
      });
      let top = 0;
      root.traverse((o) => {
        const pos = (o as Mesh).geometry?.getAttribute("position");
        if (pos && (o as Mesh).isMesh) for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
      });
      expect(top, preset).toBe(20);
    }
  });
});
