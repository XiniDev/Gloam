import type { Accessor, Document, Primitive } from "@gltf-transform/core";

/**
 * Winding repair for minis (DECISIONS: "GLB orientation repair"). glTF draws only the counter-clockwise side of a
 * triangle, so a mini whose triangles face inward (a common export or STL-conversion fault) renders inside out: the
 * near faces vanish and the far ones show their backs. Per closed shell (a connected, manifold, orientable set of
 * triangles — the only shape whose inside is defined):
 *
 * - a shell with **inconsistent** winding is made consistent and turned outward (never intentional);
 * - consistent shells are turned outward only when **every** closed shell in the model faces inward (the whole
 *   model was exported inside out). A model that mixes outward and inward shells keeps them: an inward shell can be
 *   deliberate (an inverted-hull outline).
 *
 * Open or non-manifold surfaces (capes, planes, kitbashed intersections) are left alone. Stored normals follow the
 * repaired faces when they agreed with the old winding. Maps are never repaired: inward rooms are a cut-away
 * technique there.
 */
export function orientShells(doc: Document): { shells: number; flipped: number } {
  const shells: Shell[] = [];
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) if (prim.getMode() === 4) shells.push(...findShells(prim));
  const closed = shells.filter((s) => s.volume !== 0);
  const allInward = closed.length > 0 && closed.every((s) => s.volume < 0);
  let flipped = 0;
  const byPrim = new Map<Primitive, { shell: Shell; flipAll: boolean }[]>();
  for (const s of closed) {
    const turnOut = s.volume < 0 && (allInward || s.inconsistent);
    if (!turnOut && !s.inconsistent) continue;
    const list = byPrim.get(s.prim) ?? [];
    list.push({ shell: s, flipAll: turnOut });
    byPrim.set(s.prim, list);
    flipped++;
  }
  for (const [prim, list] of byPrim) apply(prim, list);
  return { shells: closed.length, flipped };
}

interface Shell {
  prim: Primitive;
  /** Triangle indices in this shell. */
  tris: number[];
  /** Per triangle of the shell: flip it to make the shell's winding consistent. */
  fix: Uint8Array;
  inconsistent: boolean;
  /** Signed volume with the consistent winding (0: not a closed, orientable, manifold shell). */
  volume: number;
}

function findShells(prim: Primitive): Shell[] {
  const pos = prim.getAttribute("POSITION");
  const indices = prim.getIndices();
  if (!pos || !indices) return [];
  const idx = indices.getArray();
  if (!idx) return [];
  const T = Math.floor(indices.getCount() / 3);
  // Vertices at the same position are one corner (UV and normal seams split vertices without opening the surface).
  const corner = new Int32Array(pos.getCount());
  const ids = new Map<string, number>();
  const p = [0, 0, 0];
  const xyz: number[] = [];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, p);
    const key = `${p[0]},${p[1]},${p[2]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
      xyz.push(p[0] as number, p[1] as number, p[2] as number);
    }
    corner[i] = id;
  }
  const N = ids.size;
  const c = (t: number, k: number) => corner[idx[t * 3 + k] as number] as number;
  // Undirected edge → the triangles on it.
  const edges = new Map<number, number[]>();
  const degenerate = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    const a = c(t, 0);
    const b = c(t, 1);
    const d = c(t, 2);
    if (a === b || b === d || a === d) {
      degenerate[t] = 1;
      continue;
    }
    for (const [u, v] of [
      [a, b],
      [b, d],
      [d, a],
    ] as const) {
      const key = Math.min(u, v) * N + Math.max(u, v);
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  }
  /** Does triangle t (unflipped) run u→v along one of its edges? */
  const runs = (t: number, u: number, v: number) => {
    for (let k = 0; k < 3; k++) if (c(t, k) === u && c(t, (k + 1) % 3) === v) return true;
    return false;
  };
  const seen = new Uint8Array(T);
  const flip = new Uint8Array(T);
  const out: Shell[] = [];
  for (let s = 0; s < T; s++) {
    if (seen[s] || degenerate[s]) continue;
    const tris: number[] = [];
    let manifold = true;
    let orientable = true;
    let inconsistent = false;
    const queue = [s];
    seen[s] = 1;
    while (queue.length) {
      const t = queue.pop() as number;
      tris.push(t);
      for (let k = 0; k < 3; k++) {
        // Triangle t, as currently oriented, runs u→v here; a consistent neighbour runs v→u.
        let u = c(t, k);
        let v = c(t, (k + 1) % 3);
        if (flip[t]) [u, v] = [v, u];
        const list = edges.get(Math.min(u, v) * N + Math.max(u, v)) as number[];
        if (list.length !== 2) {
          manifold = false;
          continue;
        }
        const n = list[0] === t ? (list[1] as number) : (list[0] as number);
        const nFlip = runs(n, u, v) ? 1 : 0;
        if (!seen[n]) {
          seen[n] = 1;
          flip[n] = nFlip;
          if (nFlip) inconsistent = true;
          queue.push(n);
        } else if (flip[n] !== nFlip) orientable = false;
      }
    }
    let volume = 0;
    if (manifold && orientable) {
      for (const t of tris) {
        const [a, b, d] = flip[t] ? [c(t, 0), c(t, 2), c(t, 1)] : [c(t, 0), c(t, 1), c(t, 2)];
        const ax = xyz[a * 3] as number;
        const ay = xyz[a * 3 + 1] as number;
        const az = xyz[a * 3 + 2] as number;
        const bx = xyz[b * 3] as number;
        const by = xyz[b * 3 + 1] as number;
        const bz = xyz[b * 3 + 2] as number;
        const dx = xyz[d * 3] as number;
        const dy = xyz[d * 3 + 1] as number;
        const dz = xyz[d * 3 + 2] as number;
        volume += ax * (by * dz - bz * dy) - ay * (bx * dz - bz * dx) + az * (bx * dy - by * dx);
      }
      volume /= 6;
    }
    const fix = new Uint8Array(tris.length);
    tris.forEach((t, i) => {
      fix[i] = flip[t] as number;
    });
    out.push({ prim, tris, fix, inconsistent: inconsistent && manifold && orientable, volume });
  }
  return out;
}

/** Rewrites a primitive's triangle order (and its normals where they followed the old winding). */
function apply(prim: Primitive, list: { shell: Shell; flipAll: boolean }[]): void {
  const indices = own(prim, prim.getIndices() as Accessor, (a) => prim.setIndices(a));
  const idx = indices.getArray() as Uint16Array | Uint32Array;
  const pos = prim.getAttribute("POSITION") as Accessor;
  let normals = prim.getAttribute("NORMAL");
  const tangents = prim.getAttribute("TANGENT");
  const negate = new Set<number>();
  const keep = new Set<number>();
  const pa = [0, 0, 0];
  const pb = [0, 0, 0];
  const pc = [0, 0, 0];
  const n = [0, 0, 0];
  for (const { shell, flipAll } of list) {
    // Final winding per triangle: the consistent orientation, then turned out if the whole shell flips.
    let agree = 0;
    shell.tris.forEach((t, i) => {
      if (!((shell.fix[i] as number) ^ (flipAll ? 1 : 0))) return;
      const b = idx[t * 3 + 1] as number;
      idx[t * 3 + 1] = idx[t * 3 + 2] as number;
      idx[t * 3 + 2] = b;
    });
    if (!normals) continue;
    // Do the stored normals agree with the repaired faces? If most point against them, they were written for the
    // old winding: negate them too.
    for (const t of shell.tris) {
      const [a, b, c] = [idx[t * 3] as number, idx[t * 3 + 1] as number, idx[t * 3 + 2] as number];
      pos.getElement(a, pa);
      pos.getElement(b, pb);
      pos.getElement(c, pc);
      const ux = (pb[0] as number) - (pa[0] as number);
      const uy = (pb[1] as number) - (pa[1] as number);
      const uz = (pb[2] as number) - (pa[2] as number);
      const vx = (pc[0] as number) - (pa[0] as number);
      const vy = (pc[1] as number) - (pa[1] as number);
      const vz = (pc[2] as number) - (pa[2] as number);
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      for (const v of [a, b, c]) {
        normals.getElement(v, n);
        agree += fx * (n[0] as number) + fy * (n[1] as number) + fz * (n[2] as number);
      }
    }
    const into = agree < 0 ? negate : keep;
    for (const t of shell.tris) for (let k = 0; k < 3; k++) into.add(idx[t * 3 + k] as number);
  }
  if (!normals || !negate.size) return;
  normals = own(prim, normals, (a) => prim.setAttribute("NORMAL", a));
  const tan = tangents ? own(prim, tangents, (a) => prim.setAttribute("TANGENT", a)) : null;
  const t4 = [0, 0, 0, 0];
  for (const v of negate) {
    // A vertex shared with a shell whose normals are right stays as it is.
    if (keep.has(v)) continue;
    normals.getElement(v, n);
    normals.setElement(v, [-(n[0] as number), -(n[1] as number), -(n[2] as number)]);
    if (tan) {
      tan.getElement(v, t4);
      tan.setElement(v, [t4[0] as number, t4[1] as number, t4[2] as number, -(t4[3] as number)]);
    }
  }
  for (const target of prim.listTargets()) {
    const tn = target.getAttribute("NORMAL");
    if (!tn) continue;
    const owned = own(prim, tn, (a) => target.setAttribute("NORMAL", a));
    for (const v of negate) {
      if (keep.has(v)) continue;
      owned.getElement(v, n);
      owned.setElement(v, [-(n[0] as number), -(n[1] as number), -(n[2] as number)]);
    }
  }
}

/** An accessor this primitive alone uses (dedup() shares identical accessors): cloned if anything else holds it. */
function own(prim: Primitive, acc: Accessor, set: (a: Accessor) => void): Accessor {
  const others = acc.listParents().filter((p) => p !== prim && p.propertyType !== "Root");
  if (!others.length) return acc;
  const copy = acc.clone();
  set(copy);
  return copy;
}
