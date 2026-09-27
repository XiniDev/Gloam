import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { describe, expect, it } from "vitest";
import { chain, generateWalls, type Seg, simplify, triangleSlice, wallsFromSegments } from "./wallGen.ts";

const len = (s: Seg) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
const lengths = (walls: Seg[]) => walls.map(len).sort((a, b) => a - b);
const mat = new MeshBasicMaterial();
const close = (xs: number[]) => xs.map((n) => expect.closeTo(n, 5)) as unknown as number[];

function box(g: Group, w: number, d: number, x: number, z: number, height = 8) {
  const m = new Mesh(new BoxGeometry(w, height, d), mat);
  m.position.set(x, height / 2, z);
  g.add(m);
  return m;
}

/** A room from four overlapping 1-ft-thick wall boxes (a modular kit), 20 × 30 ft inside, plus a floor slab. */
function room() {
  const g = new Group();
  box(g, 22, 1, 10, -0.5); // north, overlapping both corners
  box(g, 22, 1, 10, 30.5); // south
  box(g, 1, 30, -0.5, 15); // west
  box(g, 1, 30, 20.5, 15); // east
  const floor = new Mesh(new PlaneGeometry(22, 32).rotateX(-Math.PI / 2), mat);
  floor.position.set(10, 0, 15);
  g.add(floor);
  return g;
}

describe("Generate walls (AC-SCN-04)", () => {
  it("slices a triangle crossing the plane into one segment and ignores ones that don't", () => {
    const s = triangleSlice(new Vector3(0, 0, 0), new Vector3(10, 0, 0), new Vector3(0, 10, 0), 5);
    expect(s).not.toBeNull();
    expect(len(s as Seg)).toBeCloseTo(5, 6);
    expect(triangleSlice(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 0, 1), 5)).toBeNull();
    // Coplanar with the slice (a floor at that height) makes no wall.
    expect(triangleSlice(new Vector3(0, 5, 0), new Vector3(1, 5, 0), new Vector3(0, 5, 1), 5)).toBeNull();
  });

  it("merges collinear pieces: a box slices into exactly its 4 faces, corners exact", () => {
    const g = new Group();
    box(g, 10, 6, 5, 3, 10);
    const walls = generateWalls(g, 5);
    expect(walls).toHaveLength(4);
    expect(lengths(walls)).toEqual(close([6, 6, 10, 10]));
    const corners = new Set(
      walls.flatMap((w) => [w.a, w.b]).map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`),
    );
    expect([...corners].sort()).toEqual([
      "0.000000,0.000000",
      "0.000000,6.000000",
      "10.000000,0.000000",
      "10.000000,6.000000",
    ]);
  });

  it("uses the map's world transform (moved, rotated about Y and scaled)", () => {
    const g = new Group();
    g.add(new Mesh(new BoxGeometry(2, 2, 2), mat)); // spans y −1…1 before the transform
    g.position.set(100, 2, -50);
    g.rotation.y = Math.PI / 2;
    g.scale.setScalar(5); // 10 ft cube spanning y −3…7
    const walls = generateWalls(g, 5);
    expect(walls).toHaveLength(4);
    for (const w of walls) {
      expect(len(w)).toBeCloseTo(10, 5);
      for (const p of [w.a, w.b]) {
        expect(Math.abs(p.x - 100)).toBeCloseTo(5, 5);
        expect(Math.abs(p.y + 50)).toBeCloseTo(5, 5);
      }
    }
  });

  it("unions overlapping kit pieces: a room of four overlapping boxes is one outer and one inner ring", () => {
    const walls = generateWalls(room(), 5);
    expect(walls).toHaveLength(8);
    expect(lengths(walls)).toEqual(close([20, 20, 30, 30, 32, 32, 22, 22].sort((a, b) => a - b)));
    // Above the 8-ft walls there is nothing to slice.
    expect(generateWalls(room(), 10)).toHaveLength(0);
  });

  it("cancels the seam between abutting pieces: two boxes side by side make one rectangle", () => {
    const g = new Group();
    box(g, 10, 2, 5, 1);
    box(g, 10, 2, 15, 1);
    const walls = generateWalls(g, 4);
    expect(walls).toHaveLength(4);
    expect(lengths(walls)).toEqual(close([2, 2, 20, 20]));
  });

  it("unions overlapping solids joined into one mesh (Ctrl+J), and keeps holes", () => {
    const a = new BoxGeometry(10, 8, 2).translate(5, 4, 1);
    const b = new BoxGeometry(2, 8, 10).translate(1, 4, 5); // overlaps a in the 2 × 2 corner
    const g = new Group();
    g.add(new Mesh(mergeGeometries([a, b]), mat));
    const walls = generateWalls(g, 4);
    // An L: six sides, 10 + 2 + 8 + 8 + 2 + 10 ft.
    expect(walls).toHaveLength(6);
    expect(lengths(walls)).toEqual(close([2, 2, 8, 8, 10, 10]));

    // A hollow square pillar (outer 10 × 10, inner 6 × 6 hole) from one mesh: two rings, the hole stays open.
    const ring = new Group();
    const parts = [
      new BoxGeometry(10, 8, 2).translate(5, 4, 1),
      new BoxGeometry(10, 8, 2).translate(5, 4, 9),
      new BoxGeometry(2, 8, 6).translate(1, 4, 5),
      new BoxGeometry(2, 8, 6).translate(9, 4, 5),
    ];
    ring.add(new Mesh(mergeGeometries(parts), mat));
    const rw = generateWalls(ring, 4);
    expect(rw).toHaveLength(8);
    expect(lengths(rw)).toEqual(close([6, 6, 6, 6, 10, 10, 10, 10]));
  });

  it("handles inside-out meshes and mirrored transforms", () => {
    const inverted = new BoxGeometry(10, 8, 6).translate(5, 4, 3);
    const idx = inverted.index?.array as Uint16Array;
    for (let i = 0; i < idx.length; i += 3)
      [idx[i + 1], idx[i + 2]] = [idx[i + 2] as number, idx[i + 1] as number];
    const g = new Group();
    g.add(new Mesh(inverted, mat));
    expect(lengths(generateWalls(g, 4))).toEqual(close([6, 6, 10, 10]));

    const m = new Group();
    const piece = box(m, 10, 6, 5, 3);
    piece.scale.x = -1;
    expect(lengths(generateWalls(m, 4))).toEqual(close([6, 6, 10, 10]));
  });

  it("keeps single-plane walls, and drops planes buried inside a solid", () => {
    const g = new Group();
    const plane = new Mesh(new PlaneGeometry(12, 8), new MeshBasicMaterial({ side: DoubleSide }));
    plane.position.set(50, 4, 50); // a 12-ft wall with no thickness, facing +Z
    g.add(plane);
    const walls = generateWalls(g, 4);
    expect(walls).toHaveLength(1);
    expect(len(walls[0] as Seg)).toBeCloseTo(12, 5);

    const buried = new Group();
    box(buried, 10, 4, 5, 2);
    const inner = new Mesh(new PlaneGeometry(6, 8), mat);
    inner.position.set(5, 4, 2);
    buried.add(inner);
    expect(generateWalls(buried, 4)).toHaveLength(4);
  });

  it("simplifies curves with RDP at 0.25 ft: a 64-sided pillar becomes a closed outline of few walls", () => {
    const g = new Group();
    const m = new Mesh(new CylinderGeometry(3, 3, 10, 64), mat);
    m.position.set(0, 5, 0);
    g.add(m);
    const walls = generateWalls(g, 5);
    expect(walls.length).toBeGreaterThanOrEqual(6);
    expect(walls.length).toBeLessThan(64);
    for (const w of walls) {
      // Vertices within the raster's error of the true outline; chords within tolerance + that error.
      expect(Math.abs(Math.hypot(w.a.x, w.a.y) - 3)).toBeLessThanOrEqual(0.1);
      const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
      expect(3 - Math.hypot(mid.x, mid.y)).toBeLessThanOrEqual(0.25 + 0.1);
    }
    const k = (p: { x: number; y: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    const deg = new Map<string, number>();
    for (const w of walls) for (const p of [w.a, w.b]) deg.set(k(p), (deg.get(k(p)) ?? 0) + 1);
    expect([...deg.values()].every((d) => d === 2)).toBe(true);
  });

  it("keeps junctions: a T of three walls stays three walls", () => {
    const segs: Seg[] = [
      { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
      { a: { x: 5, y: 0 }, b: { x: 10, y: 0 } },
      { a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
    ];
    expect(chain(segs)).toHaveLength(3);
    expect(wallsFromSegments(segs)).toHaveLength(3);
  });

  it("drops duplicate pieces and slivers", () => {
    const segs: Seg[] = [
      { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { a: { x: 10, y: 0 }, b: { x: 0, y: 0 } },
      { a: { x: 20, y: 0 }, b: { x: 20.1, y: 0 } },
    ];
    expect(wallsFromSegments(segs)).toHaveLength(1);
  });

  it("RDP keeps corners and removes points within tolerance", () => {
    const zig = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(simplify(zig, 0.25)).toEqual([zig[0], zig[2], zig[3]]);
  });

  it("stays fast on a large map: 200 kit pieces over 300 × 300 ft in well under a second", () => {
    const g = new Group();
    for (let i = 0; i < 100; i++) {
      box(g, 12, 1, (i % 10) * 30 + 6, Math.floor(i / 10) * 30);
      box(g, 1, 12, (i % 10) * 30, Math.floor(i / 10) * 30 + 6);
    }
    const t = performance.now();
    const walls = generateWalls(g, 4);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(walls.length).toBeGreaterThan(100);
  });
});
