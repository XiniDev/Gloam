import { Matrix4, type Mesh, type Object3D, Plane, Vector3 } from "three";
import { INTERSECTED, MeshBVH, NOT_INTERSECTED } from "three-mesh-bvh";

/**
 * Generate walls from a 3D map (SPEC §8.3 3D maps; AC-SCN-04).
 *
 * 1. Slice every mesh with the plane y = sliceFt: a three-mesh-bvh shapecast finds the triangles crossing it and
 *    each gives one segment, oriented by the triangle's winding (glTF front faces are counter-clockwise) so the
 *    solid lies on its left.
 * 2. Segments on closed cycles bound solid regions; the rest (bridges: single planes, open surfaces) are thin walls.
 * 3. The solid regions are unioned with the non-zero fill rule on a fine raster (≤ 0.1 ft cells), so overlapping
 *    kit pieces merge, coincident faces of abutting pieces cancel, and holes stay holes. A mesh that comes out
 *    inside-out (negative area) is flipped first.
 * 4. The union's outline is traced along cell edges and simplified with Ramer–Douglas–Peucker at 0.25 ft, which
 *    also merges collinear runs. Lattice-aligned walls are exact; elsewhere the raster adds at most ~0.07 ft
 *    (half a cell diagonal), well inside that tolerance.
 *
 * Output is in table coordinates: x = world X, y = world Z.
 */
export interface P2 {
  x: number;
  y: number;
}
export interface Seg {
  a: P2;
  b: P2;
}
interface OSeg extends Seg {
  mesh: number;
}

export const RDP_TOLERANCE_FT = 0.25;
/** Endpoints closer than this are the same point (slices of a shared triangle edge agree up to float error). */
const WELD_FT = 0.01;
/** Pieces shorter than this after simplification are noise (bevels, trim). */
const MIN_LENGTH_FT = 0.25;
const MIN_CELL_FT = 0.1;
const MAX_CELLS = 16_000_000;

/** The segment where triangle (a, b, c) crosses the plane y = h, if it does (world space). */
export function triangleSlice(a: Vector3, b: Vector3, c: Vector3, h: number): Seg | null {
  const pts: P2[] = [];
  const da = a.y - h;
  const db = b.y - h;
  const dc = c.y - h;
  const edge = (p: Vector3, q: Vector3, dp: number, dq: number) => {
    if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
      const t = dp / (dp - dq);
      pts.push({ x: p.x + (q.x - p.x) * t, y: p.z + (q.z - p.z) * t });
    } else if (dp === 0) pts.push({ x: p.x, y: p.z });
  };
  edge(a, b, da, db);
  edge(b, c, db, dc);
  edge(c, a, dc, da);
  // A triangle lying in the plane (a floor at exactly this height) or touching it at one vertex makes no wall.
  if (pts.length !== 2) return null;
  const [p, q] = pts as [P2, P2];
  if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-6) return null;
  return { a: p, b: q };
}

const bvhs = new WeakMap<object, MeshBVH>();

/** Slices every mesh under `root` (with its current world transform) at world height `h`; solid on the left. */
function sliceOriented(root: Object3D, h: number): OSeg[] {
  root.updateWorldMatrix(true, true);
  const out: OSeg[] = [];
  const inv = new Matrix4();
  const localPlane = new Plane();
  const worldPlane = new Plane(new Vector3(0, 1, 0), -h);
  const va = new Vector3();
  const vb = new Vector3();
  const vc = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  let meshIndex = 0;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    const id = meshIndex++;
    const geometry = mesh.geometry;
    let bvh = bvhs.get(geometry);
    if (!bvh) {
      bvh = new MeshBVH(geometry);
      bvhs.set(geometry, bvh);
    }
    inv.copy(mesh.matrixWorld).invert();
    localPlane.copy(worldPlane).applyMatrix4(inv);
    const m = mesh.matrixWorld;
    // A mirrored transform reverses the winding of every triangle.
    const mirror = m.determinant() < 0 ? -1 : 1;
    bvh.shapecast({
      intersectsBounds: (box) => (localPlane.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED),
      intersectsTriangle: (tri) => {
        va.copy(tri.a).applyMatrix4(m);
        vb.copy(tri.b).applyMatrix4(m);
        vc.copy(tri.c).applyMatrix4(m);
        const s = triangleSlice(va, vb, vc, h);
        if (!s) return false;
        // Outward normal (x, z) → direction (−nz, nx) keeps the solid on the left in table coordinates.
        e1.subVectors(vb, va);
        e2.subVectors(vc, va);
        const n = e1.cross(e2).multiplyScalar(mirror);
        const dx = -n.z;
        const dy = n.x;
        const forward = (s.b.x - s.a.x) * dx + (s.b.y - s.a.y) * dy >= 0;
        out.push(forward ? { a: s.a, b: s.b, mesh: id } : { a: s.b, b: s.a, mesh: id });
        return false;
      },
    });
  });
  return out;
}

/** The unoriented slice (for tools and tests that only need the raw pieces). */
export function sliceObject(root: Object3D, h: number): Seg[] {
  return sliceOriented(root, h).map(({ a, b }) => ({ a, b }));
}

const key = (p: P2) => `${Math.round(p.x / WELD_FT)},${Math.round(p.y / WELD_FT)}`;

/**
 * Marks the segments that lie on a cycle of the welded segment graph (Tarjan's bridge finding, iterative;
 * parallel segments between the same two points form a cycle of their own).
 */
function onCycles(segs: Seg[]): boolean[] {
  const ids = new Map<string, number>();
  const nodeOf = (p: P2) => {
    const k = key(p);
    let n = ids.get(k);
    if (n === undefined) {
      n = ids.size;
      ids.set(k, n);
    }
    return n;
  };
  const ends = segs.map((s) => [nodeOf(s.a), nodeOf(s.b)] as const);
  const adj: number[][] = Array.from({ length: ids.size }, () => []);
  ends.forEach(([u, v], e) => {
    if (u === v) return;
    adj[u]?.push(e);
    adj[v]?.push(e);
  });
  const disc = new Int32Array(ids.size).fill(-1);
  const low = new Int32Array(ids.size);
  const bridge = new Uint8Array(segs.length);
  let time = 0;
  for (let root = 0; root < ids.size; root++) {
    if (disc[root] !== -1) continue;
    // Stack frames: node, the edge we came in by, next adjacency index.
    const stack: [number, number, number][] = [[root, -1, 0]];
    disc[root] = low[root] = time++;
    while (stack.length) {
      const top = stack[stack.length - 1] as [number, number, number];
      const [u, inEdge] = top;
      const list = adj[u] as number[];
      if (top[2] < list.length) {
        const e = list[top[2]++] as number;
        if (e === inEdge) continue;
        const [a, b] = ends[e] as readonly [number, number];
        const v = a === u ? b : a;
        if (disc[v] === -1) {
          disc[v] = low[v] = time++;
          stack.push([v, e, 0]);
        } else low[u] = Math.min(low[u] as number, disc[v] as number);
      } else {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) {
          const p = parent[0];
          low[p] = Math.min(low[p] as number, low[u] as number);
          if ((low[u] as number) > (disc[p] as number)) bridge[inEdge] = 1;
        }
      }
    }
  }
  return segs.map((_, e) => {
    const [u, v] = ends[e] as readonly [number, number];
    return u !== v && !bridge[e];
  });
}

interface Raster {
  ox: number;
  oy: number;
  c: number;
  w: number;
  h: number;
  inside: Uint8Array;
}

/** Non-zero winding fill of oriented closed boundaries, sampled at cell centres. */
function rasterize(segs: Seg[]): Raster | null {
  if (!segs.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const s of segs)
    for (const p of [s.a, s.b]) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  const c = Math.max(MIN_CELL_FT, Math.sqrt(((maxX - minX) * (maxY - minY)) / MAX_CELLS));
  // The origin sits on the cell lattice (multiples of c), so axis-aligned walls land exactly on cell edges.
  const ox = (Math.floor(minX / c) - 2) * c;
  const oy = (Math.floor(minY / c) - 2) * c;
  const w = Math.ceil((maxX - ox) / c) + 3;
  const h = Math.ceil((maxY - oy) / c) + 3;
  const rows: { x: number; w: number }[][] = Array.from({ length: h }, () => []);
  for (const s of segs) {
    if (s.a.y === s.b.y) continue;
    const up = s.b.y > s.a.y;
    const lo = up ? s.a : s.b;
    const hi = up ? s.b : s.a;
    // Rows whose centre y lies in [lo.y, hi.y) — half-open so a shared endpoint counts once.
    const j0 = Math.max(0, Math.ceil((lo.y - oy) / c - 0.5));
    const j1 = Math.min(h - 1, Math.ceil((hi.y - oy) / c - 0.5) - 1);
    for (let j = j0; j <= j1; j++) {
      const y = oy + (j + 0.5) * c;
      const t = (y - lo.y) / (hi.y - lo.y);
      rows[j]?.push({ x: lo.x + (hi.x - lo.x) * t, w: up ? 1 : -1 });
    }
  }
  const inside = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const xs = (rows[j] as { x: number; w: number }[]).sort((p, q) => p.x - q.x);
    let wind = 0;
    for (let k = 0; k < xs.length; k++) {
      const cur = xs[k] as { x: number; w: number };
      wind += cur.w;
      const next = xs[k + 1];
      if (!next || wind === 0) continue;
      const i0 = Math.max(0, Math.ceil((cur.x - ox) / c - 0.5));
      const i1 = Math.min(w - 1, Math.ceil((next.x - ox) / c - 0.5) - 1);
      for (let i = i0; i <= i1; i++) inside[j * w + i] = 1;
    }
  }
  return { ox, oy, c, w, h, inside };
}

/**
 * The union's exact outline on the cell lattice: every edge between an inside and an outside cell. Corners of
 * lattice-aligned walls come out exact; diagonals come out as stairs that RDP straightens.
 */
function outline(r: Raster): Seg[] {
  const { ox, oy, c, w, h, inside } = r;
  const out: Seg[] = [];
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < w && j < h ? inside[j * w + i] : 0);
  for (let j = 0; j <= h; j++) {
    for (let i = 0; i <= w; i++) {
      const here = at(i, j);
      // Vertical edge on the left of cell (i, j), horizontal edge below it.
      if (here !== at(i - 1, j))
        out.push({ a: { x: ox + i * c, y: oy + j * c }, b: { x: ox + i * c, y: oy + (j + 1) * c } });
      if (here !== at(i, j - 1))
        out.push({ a: { x: ox + i * c, y: oy + j * c }, b: { x: ox + (i + 1) * c, y: oy + j * c } });
    }
  }
  return out;
}

/**
 * Joins segments into polylines through shared endpoints. A point where exactly two pieces meet continues the line;
 * junctions (three or more) and loose ends break it. Duplicates (the same piece from two coincident triangles) are
 * dropped.
 */
export function chain(segs: Seg[]): P2[][] {
  const nodes = new Map<string, { p: P2; edges: number[] }>();
  const edges: [string, string][] = [];
  const seen = new Set<string>();
  const node = (p: P2) => {
    const k = key(p);
    if (!nodes.has(k)) nodes.set(k, { p, edges: [] });
    return k;
  };
  for (const s of segs) {
    const ka = node(s.a);
    const kb = node(s.b);
    if (ka === kb) continue;
    const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const i = edges.length;
    edges.push([ka, kb]);
    nodes.get(ka)?.edges.push(i);
    nodes.get(kb)?.edges.push(i);
  }
  const used = new Uint8Array(edges.length);
  const other = (e: number, k: string) => {
    const [a, b] = edges[e] as [string, string];
    return a === k ? b : a;
  };
  const walk = (start: string, e0: number): string[] => {
    const path = [start];
    let k = start;
    let e = e0;
    for (;;) {
      used[e] = 1;
      k = other(e, k);
      path.push(k);
      const n = nodes.get(k);
      if (n?.edges.length !== 2 || k === start) break;
      const next = n.edges.find((x) => !used[x]);
      if (next === undefined) break;
      e = next;
    }
    return path;
  };
  const lines: P2[][] = [];
  const toPoints = (ks: string[]) => ks.map((k) => (nodes.get(k) as { p: P2 }).p);
  // Start from ends and junctions first, so each open line is walked whole.
  for (const [k, n] of nodes) {
    if (n.edges.length === 2) continue;
    for (const e of n.edges) if (!used[e]) lines.push(toPoints(walk(k, e)));
  }
  // What's left are closed loops through degree-2 points.
  for (let e = 0; e < edges.length; e++) {
    if (used[e]) continue;
    const start = (edges[e] as [string, string])[0];
    lines.push(toPoints(walk(start, e)));
  }
  return lines;
}

function distToSegment(p: P2, a: P2, b: P2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker. A closed loop (first = last) is split at its farthest point, simplified in two halves, and
 * its seam vertex is dropped too when it lies within tolerance (a loop has no real start).
 */
export function simplify(line: P2[], tol: number): P2[] {
  if (line.length < 3) return line;
  const first = line[0] as P2;
  const last = line[line.length - 1] as P2;
  if (Math.hypot(first.x - last.x, first.y - last.y) >= WELD_FT) return rdp(line, tol);
  let far = 0;
  let best = -1;
  for (let i = 1; i < line.length - 1; i++) {
    const p = line[i] as P2;
    const d = Math.hypot(p.x - first.x, p.y - first.y);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  if (far === 0) return [first];
  const ring = [...rdp(line.slice(0, far + 1), tol), ...rdp(line.slice(far), tol).slice(1)];
  // ring is closed (last = first); drop the seam if it's just a point along a straight run.
  if (ring.length > 4) {
    const prev = ring[ring.length - 2] as P2;
    const next = ring[1] as P2;
    if (distToSegment(ring[0] as P2, prev, next) <= tol) {
      ring.shift();
      ring[ring.length - 1] = ring[0] as P2;
    }
  }
  return ring;
}

function rdp(pts: P2[], tol: number): P2[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() as [number, number];
    let far = -1;
    let best = tol;
    for (let k = i + 1; k < j; k++) {
      const d = distToSegment(pts[k] as P2, pts[i] as P2, pts[j] as P2);
      if (d > best) {
        best = d;
        far = k;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Chain → simplify → segments, dropping slivers. */
export function wallsFromSegments(segs: Seg[], tol = RDP_TOLERANCE_FT): Seg[] {
  const out: Seg[] = [];
  for (const line of chain(segs)) {
    const pts = simplify(line, tol);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i] as P2;
      const b = pts[i + 1] as P2;
      if (Math.hypot(b.x - a.x, b.y - a.y) >= MIN_LENGTH_FT) out.push({ a, b });
    }
  }
  return out;
}

const signedArea = (segs: Seg[]) => segs.reduce((s, g) => s + (g.a.x * g.b.y - g.b.x * g.a.y), 0) / 2;

/** Everything after the slice: split solids from thin walls, union, trace, simplify (see the file comment). */
export function wallsFromSlice(oriented: OSeg[], tol = RDP_TOLERANCE_FT): Seg[] {
  const cyc = onCycles(oriented);
  const solids: OSeg[] = [];
  const thin: Seg[] = [];
  oriented.forEach((s, i) => {
    if (cyc[i]) solids.push(s);
    else thin.push(s);
  });
  // Inside-out meshes (normals pointing in) enclose the outside; flip them so every solid has positive area.
  const byMesh = new Map<number, OSeg[]>();
  for (const s of solids) {
    const list = byMesh.get(s.mesh);
    if (list) list.push(s);
    else byMesh.set(s.mesh, [s]);
  }
  const fill: Seg[] = [];
  for (const list of byMesh.values()) {
    const flip = signedArea(list) < 0;
    for (const s of list) fill.push(flip ? { a: s.b, b: s.a } : s);
  }
  const r = rasterize(fill);
  const walls = r ? wallsFromSegments(outline(r), tol) : [];
  // Thin walls (open surfaces) — except those buried inside a solid.
  for (const s of wallsFromSegments(thin, tol)) {
    if (r) {
      const mx = (s.a.x + s.b.x) / 2;
      const my = (s.a.y + s.b.y) / 2;
      const i = Math.floor((mx - r.ox) / r.c);
      const j = Math.floor((my - r.oy) / r.c);
      if (i >= 0 && j >= 0 && i < r.w && j < r.h && r.inside[j * r.w + i]) continue;
    }
    walls.push(s);
  }
  return walls;
}

export function generateWalls(root: Object3D, sliceFt: number, tol = RDP_TOLERANCE_FT): Seg[] {
  return wallsFromSlice(sliceOriented(root, sliceFt), tol);
}
