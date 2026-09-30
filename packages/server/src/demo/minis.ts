import { Document, NodeIO } from "@gltf-transform/core";

/**
 * Three miniatures made by code for the benchmark scene (SPEC §37: "10 GLB minis ≤ 20 k triangles each sharing 3
 * models"): figures turned on a lathe — a profile of (radius, height) points revolved about the up axis — with a
 * painted colour each, standing on their own base, 1.6–2.2 units tall, in metres as minis are. Their triangle counts
 * are set by the lathe's resolution, so the benchmark carries the geometry it names.
 */

type Profile = [r: number, y: number][];

interface Figure {
  name: string;
  /** Profiles turned about the axis, each its own part (body, head, weapon…) at an offset. */
  parts: { profile: Profile; at: [number, number, number]; color: [number, number, number] }[];
  /** Segments around (and the profile's resolution along its length): the triangle budget. */
  around: number;
  along: number;
}

/** Smooths a coarse profile into `n` points along it (Catmull–Rom through the given ones). */
function refine(profile: Profile, n: number): Profile {
  const out: Profile = [];
  const m = profile.length - 1;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * m;
    const k = Math.min(m - 1, Math.floor(t));
    const u = t - k;
    const p0 = profile[Math.max(0, k - 1)] as [number, number];
    const p1 = profile[k] as [number, number];
    const p2 = profile[k + 1] as [number, number];
    const p3 = profile[Math.min(m, k + 2)] as [number, number];
    const cr = (a: number, b: number, c: number, d: number) =>
      0.5 *
      (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
    out.push([Math.max(0, cr(p0[0], p1[0], p2[0], p3[0])), cr(p0[1], p1[1], p2[1], p3[1])]);
  }
  return out;
}

/** A profile turned about the up axis: positions, normals and indices (a closed surface of revolution). */
function lathe(profile: Profile, around: number, at: [number, number, number]) {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const rows = profile.length;
  for (let i = 0; i < rows; i++) {
    const [r, y] = profile[i] as [number, number];
    // The profile's slope at this point: the normal leans out and up or down with it.
    const prev = profile[Math.max(0, i - 1)] as [number, number];
    const next = profile[Math.min(rows - 1, i + 1)] as [number, number];
    const dr = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dr, dy) || 1;
    const [nr, ny] = [dy / len, -dr / len];
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      p.push(at[0] + r * c, at[1] + y, at[2] + r * s);
      n.push(nr * c, ny, nr * s);
    }
  }
  const w = around + 1;
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < around; j++) {
      const a = i * w + j;
      const b = a + w;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { p, n, idx };
}

const FIGURES: Figure[] = [
  {
    // A hooded sentinel with a tall shield: ~8 k triangles.
    name: "Sentinel",
    around: 48,
    along: 40,
    parts: [
      {
        profile: [
          [0, 0],
          [0.42, 0],
          [0.44, 0.06],
          [0.36, 0.12],
          [0.3, 0.5],
          [0.34, 0.95],
          [0.4, 1.2],
          [0.22, 1.32],
          [0.2, 1.45],
          [0.24, 1.62],
          [0.16, 1.78],
          [0, 1.82],
        ],
        at: [0, 0, 0],
        color: [0.46, 0.48, 0.52],
      },
      {
        profile: [
          [0, 0],
          [0.3, 0.02],
          [0.32, 0.6],
          [0.26, 1.05],
          [0, 1.1],
        ],
        at: [0.42, 0.18, 0],
        color: [0.55, 0.42, 0.22],
      },
    ],
  },
  {
    // A hulking brute: ~18 k triangles.
    name: "Brute",
    around: 80,
    along: 56,
    parts: [
      {
        profile: [
          [0, 0],
          [0.6, 0],
          [0.62, 0.08],
          [0.5, 0.14],
          [0.44, 0.55],
          [0.62, 0.9],
          [0.7, 1.3],
          [0.66, 1.55],
          [0.36, 1.7],
          [0.3, 1.82],
          [0.34, 2.02],
          [0.22, 2.16],
          [0, 2.2],
        ],
        at: [0, 0, 0],
        color: [0.36, 0.44, 0.3],
      },
      {
        profile: [
          [0, 0],
          [0.12, 0.05],
          [0.1, 0.9],
          [0.24, 1.0],
          [0.26, 1.25],
          [0, 1.32],
        ],
        at: [0.7, 0.3, 0.1],
        color: [0.4, 0.3, 0.2],
      },
    ],
  },
  {
    // A drifting shade: ~5 k triangles.
    name: "Shade",
    around: 40,
    along: 30,
    parts: [
      {
        profile: [
          [0, 0.1],
          [0.5, 0.12],
          [0.3, 0.4],
          [0.22, 0.9],
          [0.26, 1.2],
          [0.2, 1.4],
          [0.22, 1.55],
          [0, 1.62],
        ],
        at: [0, 0, 0],
        color: [0.24, 0.22, 0.34],
      },
    ],
  },
];

/** A figure's GLB and its triangle count. */
export async function miniGlb(i: number): Promise<{ name: string; glb: Uint8Array; triangles: number }> {
  const f = FIGURES[i % FIGURES.length] as Figure;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(f.name);
  let triangles = 0;
  f.parts.forEach((part, k) => {
    const { p, n, idx } = lathe(refine(part.profile, f.along), f.around, part.at);
    triangles += idx.length / 3;
    const material = doc
      .createMaterial(`${f.name}-${k}`)
      .setBaseColorFactor([...part.color, 1])
      .setRoughnessFactor(0.7)
      .setMetallicFactor(0.1);
    const acc = (a: number[]) =>
      doc.createAccessor().setType("VEC3").setArray(new Float32Array(a)).setBuffer(buffer);
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", acc(p))
      .setAttribute("NORMAL", acc(n))
      .setIndices(
        doc
          .createAccessor()
          .setType("SCALAR")
          .setArray(p.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx))
          .setBuffer(buffer),
      )
      .setMaterial(material);
    scene.addChild(
      doc.createNode(`${f.name}-${k}`).setMesh(doc.createMesh(`${f.name}-${k}`).addPrimitive(prim)),
    );
  });
  return { name: f.name, glb: await new NodeIO().writeBinary(doc), triangles };
}

export const MINI_COUNT = FIGURES.length;
