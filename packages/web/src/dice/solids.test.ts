import { Quaternion, type Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { type DieKind, landedMarker, markerFor, remap, solid } from "./solids.ts";

const KINDS: [DieKind, number, number, number[]][] = [
  // kind, faces, rotation group order, values
  ["d4", 4, 12, [1, 2, 3, 4]],
  ["d6", 6, 24, [1, 2, 3, 4, 5, 6]],
  ["d8", 8, 24, [1, 2, 3, 4, 5, 6, 7, 8]],
  ["d10", 10, 10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ["d12", 12, 60, Array.from({ length: 12 }, (_, i) => i + 1)],
  ["d20", 20, 60, Array.from({ length: 20 }, (_, i) => i + 1)],
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRotation(r: () => number): Quaternion {
  // Uniform on SO(3) (Shoemake).
  const u1 = r();
  const u2 = r() * 2 * Math.PI;
  const u3 = r() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return new Quaternion(a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3));
}

describe("dice solids (SPEC §18.4)", () => {
  it.each(KINDS)(
    "the %s: its faces, planar and convex; its values, opposite ones summing as on real dice; its whole rotation group",
    (kind, nFaces, order, values) => {
      const s = solid(kind);
      expect(s.faces).toHaveLength(nFaces);
      expect(s.group).toHaveLength(order);
      expect([...s.labels].sort((a, b) => a - b)).toEqual(values);
      for (let f = 0; f < s.faces.length; f++) {
        const n = s.normals[f] as Vector3;
        const p0 = s.vertices[(s.faces[f] as number[])[0] as number] as Vector3;
        const d = n.dot(p0);
        // Planar: every corner on the face's plane; convex: every vertex on the inner side.
        for (const i of s.faces[f] as number[])
          expect(Math.abs(n.dot(s.vertices[i] as Vector3) - d)).toBeLessThan(1e-9);
        for (const q of s.vertices) expect(n.dot(q)).toBeLessThanOrEqual(d + 1e-9);
      }
      // Every rotation of the group maps the solid onto itself.
      for (const g of s.group)
        for (const p of s.vertices) {
          const q = p.clone().applyQuaternion(g);
          expect(s.vertices.some((o) => o.distanceTo(q) < 1e-9)).toBe(true);
        }
      // Opposite markers sum like real dice (the d4 reads vertices, which have no opposites).
      if (kind !== "d4") {
        const sum = kind === "d10" ? 9 : nFaces + 1;
        for (let i = 0; i < s.markers.length; i++) {
          const j = s.markers.findIndex((m) => m.dot(s.markers[i] as Vector3) < -0.99);
          expect((s.labels[i] as number) + (s.labels[j] as number)).toBe(sum);
        }
      }
    },
  );

  it.each(KINDS)(
    "the %s lands on any wanted value from any resting rotation: the mesh at q·S shows it",
    (kind, _n, _o, values) => {
      const s = solid(kind);
      const r = rng(kind.length * 101 + values.length);
      for (let trial = 0; trial < 200; trial++) {
        const q = randomRotation(r);
        const landed = landedMarker(s, q);
        const want = values[Math.floor(r() * values.length)] as number;
        const S = remap(s, landed, markerFor(s, want));
        const shown = landedMarker(s, q.clone().multiply(S));
        expect(s.labels[shown]).toBe(kind === "d10" ? want % 10 : want);
        // S is a symmetry, so the mesh occupies exactly the body's space.
        for (const p of s.vertices) {
          const a = p.clone().applyQuaternion(q.clone().multiply(S));
          expect(s.vertices.some((o) => o.clone().applyQuaternion(q).distanceTo(a) < 1e-9)).toBe(true);
        }
      }
    },
  );

  it("a d10 reads 0 as 10", () => {
    const s = solid("d10");
    expect(s.labels[markerFor(s, 10)]).toBe(0);
  });
});
