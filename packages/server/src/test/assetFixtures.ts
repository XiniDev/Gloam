import { crc32, deflateSync } from "node:zlib";
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRLightsPunctual } from "@gltf-transform/extensions";
import sharp from "sharp";

/** Test files for the asset pipeline (AC-AST-01…07, AC-TOK-03, AC-BRD-06). */

export const image = (
  format: "png" | "jpeg" | "webp" | "gif" | "avif",
  w = 64,
  h = 48,
  opts: { exif?: string; alpha?: boolean } = {},
) => {
  let p = sharp({
    create: {
      width: w,
      height: h,
      channels: opts.alpha ? 4 : 3,
      background: opts.alpha ? { r: 200, g: 60, b: 40, alpha: 0.5 } : { r: 200, g: 60, b: 40 },
    },
  });
  if (opts.exif) p = p.withExif({ IFD0: { Copyright: opts.exif, Artist: opts.exif } });
  return p.toFormat(format).toBuffer();
};

/** Random-noise PNG (incompressible), about `w*h*3` bytes. */
export const noisePng = (w: number, h: number) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: "#000",
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A tiny PNG that declares an enormous canvas (a decompression bomb). */
export function bombPng(w = 60_000, h = 60_000): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((1 + w * 3) * 4); // just a few rows of zeros
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A real PNG with a processor test-hook marker right after IHDR (hang / oom / crash; test builds only). */
export async function hookFile(kind: "hang" | "oom" | "crash"): Promise<Buffer> {
  const png = await image("png", 8, 8);
  const afterIhdr = 8 + 25;
  return Buffer.concat([
    png.subarray(0, afterIhdr),
    pngChunk("tEXt", Buffer.from(`c\0__gloam_test_${kind}__`, "latin1")),
    png.subarray(afterIhdr),
  ]);
}

/** A minimal but real ZIP archive with one stored file. */
export function zip(name = "model.gltf", content = "{}"): Buffer {
  const data = Buffer.from(content);
  const fname = Buffer.from(name);
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fname.length, 28);
  const localSize = 30 + fname.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + fname.length, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([local, fname, data, central, fname, end]);
}

/** PCM WAV with `ms` of silence. */
export function wav(ms = 400): Buffer {
  const rate = 8000;
  const samples = Math.floor((rate * ms) / 1000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

/**
 * A textured box GLB, `height` tall with its base at `baseY`, plus the things §21.4 strips: a camera, a punctual
 * light and extras. `boxes` repeats the geometry to raise the triangle count.
 */
export async function glb(
  opts: { height?: number; baseY?: number; boxes?: number } = {},
): Promise<Uint8Array> {
  const height = opts.height ?? 2;
  const y0 = opts.baseY ?? -1;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const texture = doc
    .createTexture("skin")
    .setImage(new Uint8Array(await noisePng(256, 256))) // not a solid colour: prune() would fold that into a factor
    .setMimeType("image/png");
  const material = doc
    .createMaterial("paint")
    .setBaseColorTexture(texture)
    .setExtras({ secret: "extras-payload" });
  const scene = doc.createScene("root");
  const n = opts.boxes ?? 1;
  for (let k = 0; k < n; k++) {
    const x = k * 1.5;
    const p: number[] = [];
    const uv: number[] = [];
    for (const [dx, dy, dz] of [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ] as const) {
      p.push(x + dx - 0.5, y0 + dy * height, dz - 0.5);
      uv.push(dx, dy);
    }
    const idx = [
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7,
      4,
    ];
    const prim = doc
      .createPrimitive()
      .setAttribute(
        "POSITION",
        doc.createAccessor().setType("VEC3").setArray(new Float32Array(p)).setBuffer(buffer),
      )
      .setAttribute(
        "TEXCOORD_0",
        doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv)).setBuffer(buffer),
      )
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buffer))
      .setMaterial(material);
    scene.addChild(doc.createNode(`box${k}`).setMesh(doc.createMesh(`box${k}`).addPrimitive(prim)));
  }
  scene.addChild(doc.createNode("cam").setCamera(doc.createCamera("cam").setType("perspective")));
  const lights = doc.createExtension(KHRLightsPunctual);
  scene.addChild(
    doc.createNode("lamp").setExtension("KHR_lights_punctual", lights.createLight("lamp").setType("point")),
  );
  return new NodeIO().registerExtensions([KHRLightsPunctual]).writeBinary(doc);
}

/** One wavy grid mesh of `2·n²` triangles (a dense, simplifiable sculpt). */
export async function denseGlb(n: number): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const p = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const k = (j * (n + 1) + i) * 3;
      p[k] = i / n - 0.5;
      p[k + 1] = 0.08 * Math.sin(i / 7) * Math.cos(j / 9);
      p[k + 2] = j / n - 0.5;
    }
  const idx = new Uint32Array(n * n * 6);
  let q = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      idx.set([a, c, b, b, c, d], q);
      q += 6;
    }
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(p).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(idx).setBuffer(buffer))
    .setMaterial(doc.createMaterial("clay"));
  doc
    .createScene("root")
    .addChild(doc.createNode("sculpt").setMesh(doc.createMesh("sculpt").addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

/** Rewrites a GLB's JSON chunk (keeps the BIN chunk). */
export function editGlbJson(bytes: Uint8Array, fn: (json: Record<string, unknown>) => void): Buffer {
  const b = Buffer.from(bytes);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString("utf8", 20, 20 + jsonLen)) as Record<string, unknown>;
  fn(json);
  let text = Buffer.from(JSON.stringify(json));
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const rest = b.subarray(20 + jsonLen);
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + rest.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, text, rest]);
}
