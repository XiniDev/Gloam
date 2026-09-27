import { type Document, NodeIO, type Primitive } from "@gltf-transform/core";
import { weld } from "@gltf-transform/functions";
import { describe, expect, it } from "vitest";
import { glb, insideOutGlb, statueGlb } from "../test/assetFixtures.ts";
import { orientShells } from "./orient.ts";

const read = async (bytes: Uint8Array) => {
  const doc = await new NodeIO().readBinary(bytes);
  await doc.transform(weld());
  return doc;
};

/** Signed volume of every primitive together (> 0: faces point out). */
function volume(doc: Document): number {
  let v = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) v += primVolume(prim);
  return v;
}
function primVolume(prim: Primitive): number {
  const pos = prim.getAttribute("POSITION");
  const idx = prim.getIndices()?.getArray();
  if (!pos || !idx) return 0;
  const [a, b, c] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ] as number[][] as [number[], number[], number[]];
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    pos.getElement(idx[t] as number, a);
    pos.getElement(idx[t + 1] as number, b);
    pos.getElement(idx[t + 2] as number, c);
    const [ax, ay, az] = a as [number, number, number];
    const [bx, by, bz] = b as [number, number, number];
    const [cx, cy, cz] = c as [number, number, number];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

describe("GLB orientation repair (minis)", () => {
  it("turns an inside-out box (every triangle inward) outward", async () => {
    const doc = await read(await insideOutGlb());
    expect(volume(doc)).toBeCloseTo(-2, 6);
    expect(orientShells(doc)).toEqual({ shells: 1, flipped: 1 });
    expect(volume(doc)).toBeCloseTo(2, 6);
  });

  it("makes inconsistent winding consistent and outward", async () => {
    const doc = await read(await insideOutGlb({ mixed: true }));
    orientShells(doc);
    // Every triangle outward: the volume is the box's, and each face's winding agrees with its outward direction.
    expect(volume(doc)).toBeCloseTo(2, 6);
    const prim = doc.getRoot().listMeshes()[0]?.listPrimitives()[0] as Primitive;
    const pos = prim.getAttribute("POSITION");
    const idx = prim.getIndices()?.getArray() as Uint16Array;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => pos?.getElement(idx[t + k] as number, [0, 0, 0]) as number[]);
      const u = (b as number[]).map((x, i) => x - (a as number[])[i]!);
      const w = (c as number[]).map((x, i) => x - (a as number[])[i]!);
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      const centre = [0, 1, 0];
      const mid = [0, 1, 2].map((i) => ((a as number[])[i]! + (b as number[])[i]! + (c as number[])[i]!) / 3);
      const out = mid.map((x, i) => x - centre[i]!);
      expect(n[0]! * out[0]! + n[1]! * out[1]! + n[2]! * out[2]!).toBeGreaterThan(0);
    }
  });

  it("leaves well-made models alone (the box, the 26-part statue)", async () => {
    for (const bytes of [await glb(), await statueGlb()]) {
      const doc = await read(bytes);
      const before = volume(doc);
      expect(before).toBeGreaterThan(0);
      expect(orientShells(doc).flipped).toBe(0);
      expect(volume(doc)).toBeCloseTo(before, 9);
    }
  });

  it("keeps a deliberate inward shell next to outward ones (an inverted-hull outline)", async () => {
    const doc = await read(await glb());
    const hull = await read(await insideOutGlb());
    // Move the inside-out box into the same document as a second mesh.
    const src = hull.getRoot().listMeshes()[0]?.listPrimitives()[0] as Primitive;
    const buffer = doc.getRoot().listBuffers()[0];
    const copy = doc
      .createPrimitive()
      .setAttribute(
        "POSITION",
        doc
          .createAccessor()
          .setType("VEC3")
          .setArray(src.getAttribute("POSITION")?.getArray()?.slice() as Float32Array)
          .setBuffer(buffer ?? null),
      )
      .setIndices(
        doc
          .createAccessor()
          .setType("SCALAR")
          .setArray(src.getIndices()?.getArray()?.slice() as Uint16Array)
          .setBuffer(buffer ?? null),
      );
    doc
      .getRoot()
      .listScenes()[0]
      ?.addChild(doc.createNode("hull").setMesh(doc.createMesh("hull").addPrimitive(copy)));
    expect(orientShells(doc)).toEqual({ shells: 2, flipped: 0 });
    expect(primVolume(copy)).toBeCloseTo(-2, 6);
  });

  it("leaves open surfaces alone, and stored normals follow the repaired faces", async () => {
    const doc = await read(await insideOutGlb());
    const prim = doc.getRoot().listMeshes()[0]?.listPrimitives()[0] as Primitive;
    // Inward normals, as an exporter that wrote the faces inward would: each vertex's points at the centre.
    const pos = prim.getAttribute("POSITION");
    const count = pos?.getCount() ?? 0;
    const normals: number[] = [];
    for (let i = 0; i < count; i++) {
      const p = pos?.getElement(i, [0, 0, 0]) as number[];
      const d = [0 - p[0]!, 1 - p[1]!, 0 - p[2]!];
      const l = Math.hypot(...d);
      normals.push(...d.map((x) => x / l));
    }
    prim.setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(normals)));
    orientShells(doc);
    const n = prim.getAttribute("NORMAL")?.getElement(0, [0, 0, 0]) as number[];
    const p = pos?.getElement(0, [0, 0, 0]) as number[];
    // Now pointing away from the centre.
    expect(n[0]! * (p[0]! - 0) + n[1]! * (p[1]! - 1) + n[2]! * (p[2]! - 0)).toBeGreaterThan(0);

    // An open box (one face missing) has no inside: untouched.
    const open = await read(await insideOutGlb());
    const op = open.getRoot().listMeshes()[0]?.listPrimitives()[0] as Primitive;
    const idx = op.getIndices()?.getArray() as Uint16Array;
    op.getIndices()?.setArray(idx.slice(6));
    const before = primVolume(op);
    expect(orientShells(open)).toEqual({ shells: 0, flipped: 0 });
    expect(primVolume(op)).toBeCloseTo(before, 9);
  });
});
