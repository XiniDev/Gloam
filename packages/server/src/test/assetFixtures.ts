import { crc32, deflateSync } from "node:zlib";
import { Document, type Buffer as GltfBuffer, type Material, NodeIO } from "@gltf-transform/core";
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

type V3 = [number, number, number];

/**
 * A box as glTF expects it: 24 vertices (4 per face, so every face has its own normal and UVs), counter-clockwise
 * outward triangles, UVs in world units × `uvScale` so textures tile at the same density on every face.
 */
function boxArrays(min: V3, max: V3, uvScale = 0.5) {
  const p: number[] = [];
  const n: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // Each face: its outward normal and two in-plane axes (u, v) with u × v = normal (so u→v is counter-clockwise).
  const faces: { axis: 0 | 1 | 2; sign: 1 | -1; u: 0 | 1 | 2; v: 0 | 1 | 2 }[] = [
    { axis: 0, sign: 1, u: 1, v: 2 }, // +x: y × z = x
    { axis: 0, sign: -1, u: 2, v: 1 }, // −x: z × y = −x
    { axis: 1, sign: 1, u: 2, v: 0 }, // +y: z × x = y
    { axis: 1, sign: -1, u: 0, v: 2 }, // −y: x × z = −y
    { axis: 2, sign: 1, u: 0, v: 1 }, // +z: x × y = z
    { axis: 2, sign: -1, u: 1, v: 0 }, // −z: y × x = −z
  ];
  for (const f of faces) {
    const base = p.length / 3;
    for (const [a, b] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const) {
      const q: V3 = [0, 0, 0];
      q[f.axis] = f.sign > 0 ? max[f.axis] : min[f.axis];
      q[f.u] = a ? max[f.u] : min[f.u];
      q[f.v] = b ? max[f.v] : min[f.v];
      p.push(...q);
      const nn: V3 = [0, 0, 0];
      nn[f.axis] = f.sign;
      n.push(...nn);
      uv.push(q[f.u] * uvScale, q[f.v] * uvScale);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { p, n, uv, idx };
}

function boxPrimitive(
  doc: Document,
  buffer: GltfBuffer,
  min: V3,
  max: V3,
  material: Material,
  uvScale?: number,
) {
  const { p, n, uv, idx } = boxArrays(min, max, uvScale);
  const acc = (type: "VEC2" | "VEC3", a: number[]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(a)).setBuffer(buffer);
  return doc
    .createPrimitive()
    .setAttribute("POSITION", acc("VEC3", p))
    .setAttribute("NORMAL", acc("VEC3", n))
    .setAttribute("TEXCOORD_0", acc("VEC2", uv))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buffer))
    .setMaterial(material);
}

/**
 * Weathered grey stone: soft blotches (upscaled low-frequency noise) under a fine grain. Not a solid colour, which
 * prune() would fold into a factor.
 */
export async function stonePng(size = 256): Promise<Buffer> {
  const noise = (w: number, sigma: number) =>
    sharp({
      create: {
        width: w,
        height: w,
        channels: 3,
        background: "#000",
        noise: { type: "gaussian", mean: 128, sigma },
      },
    })
      .greyscale()
      .png()
      .toBuffer();
  const mottle = await sharp(await noise(12, 26))
    .resize(size, size, { kernel: "cubic" })
    .blur(size / 48)
    .png()
    .toBuffer();
  const grain = await noise(size, 22);
  return sharp(mottle)
    .composite([{ input: grain, blend: "soft-light" }])
    .linear(0.42, 72)
    .tint({ r: 146, g: 138, b: 124 })
    .png()
    .toBuffer();
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
    .setImage(new Uint8Array(await stonePng(128)))
    .setMimeType("image/png");
  const material = doc
    .createMaterial("paint")
    .setBaseColorTexture(texture)
    .setExtras({ secret: "extras-payload" });
  const scene = doc.createScene("root");
  const n = opts.boxes ?? 1;
  for (let k = 0; k < n; k++) {
    const x = k * 1.5;
    const prim = boxPrimitive(doc, buffer, [x - 0.5, y0, -0.5], [x + 0.5, y0 + height, 0.5], material);
    scene.addChild(doc.createNode(`box${k}`).setMesh(doc.createMesh(`box${k}`).addPrimitive(prim)));
  }
  scene.addChild(doc.createNode("cam").setCamera(doc.createCamera("cam").setType("perspective")));
  const lights = doc.createExtension(KHRLightsPunctual);
  scene.addChild(
    doc.createNode("lamp").setExtension("KHR_lights_punctual", lights.createLight("lamp").setType("point")),
  );
  return new NodeIO().registerExtensions([KHRLightsPunctual]).writeBinary(doc);
}

/**
 * A 1 × 2 × 1 box as some exporters (and STL conversions) ship them: 8 shared vertices, no normals, every triangle
 * wound inward — a renderer culls the outside and shows the inside. `mixed` flips only every other triangle
 * (inconsistent winding). Input for the pipeline's orientation repair (§21.4; DECISIONS).
 */
export async function insideOutGlb(opts: { mixed?: boolean } = {}): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const p: number[] = [];
  for (const [dx, dy, dz] of [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ] as const)
    p.push(dx - 0.5, dy * 2, dz - 0.5);
  // roomGlb's outward triangles, reversed.
  const out = [
    0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7,
    3,
  ];
  const idx: number[] = [];
  for (let t = 0; t < out.length; t += 3) {
    const [a, b, c] = [out[t] as number, out[t + 1] as number, out[t + 2] as number];
    const flip = !opts.mixed || t % 6 === 0;
    idx.push(...(flip ? [a, c, b] : [a, b, c]));
  }
  const prim = doc
    .createPrimitive()
    .setAttribute(
      "POSITION",
      doc.createAccessor().setType("VEC3").setArray(new Float32Array(p)).setBuffer(buffer),
    )
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buffer))
    .setMaterial(doc.createMaterial("clay"));
  doc.createScene("root").addChild(doc.createNode("box").setMesh(doc.createMesh("box").addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

/**
 * A stone guardian mini for screenshots and visual journeys: a blocky golem of weathered stone (feet, legs, hips,
 * torso, chest plate, shoulders, arms, fists, neck, head, brow) with two glowing amber eye slits. About 2 units
 * tall, facing +z (glTF's forward).
 */
export async function statueGlb(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const texture = doc
    .createTexture("stone")
    .setImage(new Uint8Array(await stonePng(256)))
    .setMimeType("image/png");
  const stone = doc
    .createMaterial("stone")
    .setBaseColorTexture(texture)
    .setRoughnessFactor(0.92)
    .setMetallicFactor(0);
  const glow = doc
    .createMaterial("glow")
    .setBaseColorFactor([0.2, 0.12, 0.04, 1])
    .setEmissiveFactor([1, 0.62, 0.22])
    .setRoughnessFactor(0.6)
    .setMetallicFactor(0);
  const mesh = doc.createMesh("guardian");
  const part = (min: V3, max: V3, mat = stone) =>
    mesh.addPrimitive(boxPrimitive(doc, buffer, min, max, mat, 1.6));
  // A part and its mirror across x = 0.
  const pair = (min: V3, max: V3, mat = stone) => {
    part(min, max, mat);
    part([-max[0], min[1], min[2]], [-min[0], max[1], max[2]], mat);
  };
  pair([0.12, 0, -0.14], [0.44, 0.15, 0.28]); // feet
  pair([0.14, 0.15, -0.14], [0.4, 0.78, 0.14]); // legs
  part([-0.46, 0.74, -0.21], [0.46, 0.99, 0.21]); // hips
  part([-0.52, 0.97, -0.27], [0.52, 1.63, 0.27]); // torso
  part([-0.38, 1.1, 0.26], [0.38, 1.5, 0.33]); // chest plate
  pair([0.47, 1.4, -0.25], [0.86, 1.74, 0.25]); // shoulders
  pair([0.53, 0.98, -0.17], [0.81, 1.42, 0.17]); // upper arms
  pair([0.47, 0.64, -0.22], [0.88, 1.0, 0.22]); // fists
  part([-0.14, 1.61, -0.12], [0.14, 1.71, 0.12]); // neck
  part([-0.25, 1.69, -0.21], [0.25, 2.03, 0.22]); // head
  part([-0.27, 1.87, 0.19], [0.27, 1.94, 0.27]); // brow
  pair([0.05, 1.8, 0.215], [0.17, 1.845, 0.24], glow); // eyes
  doc.createScene("root").addChild(doc.createNode("guardian").setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

type PortraitKind = "knight" | "owl" | "goblin" | "mage";
const PORTRAIT_BG: Record<PortraitKind, [string, string]> = {
  knight: ["#3b5f7a", "#15222e"],
  owl: ["#4d6b4a", "#16211a"],
  goblin: ["#7a5a2e", "#231a0e"],
  mage: ["#5b3f7a", "#1b1226"],
};
const PORTRAIT_FIGURE: Record<PortraitKind, string> = {
  knight: `
    <path d="M40 256 C44 196 84 176 128 176 C172 176 212 196 216 256 Z" fill="#6e7780"/>
    <path d="M58 256 C62 206 92 190 128 190 C164 190 194 206 198 256 Z" fill="#8a2f2a"/>
    <path d="M128 176 L150 256 L106 256 Z" fill="#c9a24a" opacity="0.9"/>
    <path d="M78 150 C74 92 96 58 128 58 C160 58 182 92 178 150 C178 168 160 180 128 180 C96 180 78 168 78 150 Z" fill="#9aa3ab"/>
    <path d="M86 150 C84 104 102 74 128 72 C154 74 172 104 170 150 Z" fill="#b8c0c7" opacity="0.55"/>
    <rect x="90" y="112" width="76" height="11" rx="4" fill="#141a20"/>
    <path d="M128 72 L128 176" stroke="#6b737b" stroke-width="5"/>
    <path d="M124 60 C112 30 140 12 170 18 C150 26 144 40 142 62 Z" fill="#b8322b"/>
    <circle cx="102" cy="148" r="3" fill="#6b737b"/><circle cx="154" cy="148" r="3" fill="#6b737b"/>`,
  owl: `
    <path d="M52 256 C50 170 84 104 128 104 C172 104 206 170 204 256 Z" fill="#8a6a45"/>
    <path d="M86 256 C86 190 104 160 128 160 C152 160 170 190 170 256 Z" fill="#d7c29a"/>
    <path d="M78 110 L92 62 L112 100 Z M178 110 L164 62 L144 100 Z" fill="#6f5334"/>
    <circle cx="102" cy="132" r="26" fill="#f1e6c8"/><circle cx="154" cy="132" r="26" fill="#f1e6c8"/>
    <circle cx="102" cy="132" r="15" fill="#e0a526"/><circle cx="154" cy="132" r="15" fill="#e0a526"/>
    <circle cx="102" cy="132" r="7" fill="#121212"/><circle cx="154" cy="132" r="7" fill="#121212"/>
    <path d="M120 150 L136 150 L128 170 Z" fill="#c98b2b"/>`,
  goblin: `
    <path d="M50 256 C54 196 88 178 128 178 C168 178 202 196 206 256 Z" fill="#5a4630"/>
    <path d="M40 110 L96 124 L90 146 Z M216 110 L160 124 L166 146 Z" fill="#7da35a"/>
    <ellipse cx="128" cy="130" rx="50" ry="56" fill="#86ad60"/>
    <ellipse cx="108" cy="122" rx="10" ry="8" fill="#f4e04d"/><ellipse cx="148" cy="122" rx="10" ry="8" fill="#f4e04d"/>
    <circle cx="108" cy="123" r="4" fill="#1a1a1a"/><circle cx="148" cy="123" r="4" fill="#1a1a1a"/>
    <path d="M104 160 Q128 176 152 160" stroke="#2d3b1f" stroke-width="5" fill="none"/>
    <path d="M112 162 L116 172 L120 164 Z M136 164 L140 172 L144 162 Z" fill="#f2efe4"/>`,
  mage: `
    <path d="M44 256 C48 190 86 170 128 170 C170 170 208 190 212 256 Z" fill="#3f2d63"/>
    <path d="M128 170 L128 256" stroke="#c9a24a" stroke-width="6"/>
    <ellipse cx="128" cy="134" rx="40" ry="46" fill="#e2b894"/>
    <path d="M88 150 C92 196 164 196 168 150 C150 170 106 170 88 150 Z" fill="#d9d4cc"/>
    <path d="M64 108 L192 108 L150 92 L128 20 L106 92 Z" fill="#4c3678"/>
    <circle cx="113" cy="130" r="4" fill="#2a1d14"/><circle cx="143" cy="130" r="4" fill="#2a1d14"/>
    <path d="M150 40 l6 -10 l6 10 l-6 10 Z" fill="#f4e04d"/>`,
};

/**
 * Illustrated token art (an SVG rendered by sharp): a knight, an owl familiar, a goblin or a mage on a vignetted
 * background. `hue` rotates the colours, so several distinct files (no dedup) can share a figure.
 */
export async function portraitPng(
  kind: PortraitKind,
  opts: { size?: number; hue?: number } = {},
): Promise<Buffer> {
  const size = opts.size ?? 256;
  const [inner, outer] = PORTRAIT_BG[kind];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs><radialGradient id="g" cx="50%" cy="40%" r="70%">
      <stop offset="0" stop-color="${inner}"/><stop offset="1" stop-color="${outer}"/>
    </radialGradient></defs>
    <rect width="256" height="256" fill="url(#g)"/>${PORTRAIT_FIGURE[kind]}
  </svg>`;
  const png = sharp(Buffer.from(svg)).resize(size, size);
  return (opts.hue ? png.modulate({ hue: opts.hue }) : png).png().toBuffer();
}

/**
 * A drawn dungeon map for screenshots (an SVG rendered by sharp): flagstone rooms joined by corridors on dark rock,
 * a 5-ft flagstone pattern, walls (stroked under the floors, so rooms and corridors open into each other), wooden
 * doors, a pool and rubble. `pxPer5ft` pixels per square.
 */
export async function dungeonPng(
  opts: { cols?: number; rows?: number; pxPer5ft?: number } = {},
): Promise<Buffer> {
  const cols = opts.cols ?? 28;
  const rows = opts.rows ?? 18;
  const g = opts.pxPer5ft ?? 50;
  const W = cols * g;
  const H = rows * g;
  // Laid out on a 28 × 18 grid, scaled to whole squares of this one.
  const sx = cols / 28;
  const sy = rows / 18;
  type Area = { x: number; y: number; w: number; h: number };
  const fit = (x: number, y: number, w: number, h: number): Area => {
    const x0 = Math.round(x * sx);
    const y0 = Math.round(y * sy);
    return {
      x: x0,
      y: y0,
      w: Math.max(1, Math.round((x + w) * sx) - x0),
      h: Math.max(1, Math.round((y + h) * sy) - y0),
    };
  };
  const rooms = [fit(2, 2, 8, 6), fit(14, 1, 10, 7), fit(3, 11, 7, 5), fit(15, 11, 10, 6)];
  const corridors = {
    east: fit(10, 4, 4, 2),
    west: fit(5, 8, 2, 3),
    north: fit(19, 8, 2, 3),
    south: fit(10, 13, 5, 2),
  };
  const areas = [...rooms, ...Object.values(corridors)];
  const rect = (a: Area) => `<rect x="${a.x * g}" y="${a.y * g}" width="${a.w * g}" height="${a.h * g}"/>`;
  // A door where each corridor meets its first room: across the shared edge, as wide as the corridor.
  const { east, west, north, south } = corridors;
  const doors: Area[] = [
    { x: east.x - 0.1, y: east.y, w: 0.2, h: east.h },
    { x: west.x, y: west.y - 0.1, w: west.w, h: 0.2 },
    { x: north.x, y: north.y - 0.1, w: north.w, h: 0.2 },
    { x: south.x - 0.1, y: south.y, w: 0.2, h: south.h },
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <pattern id="flag" width="${g}" height="${g}" patternUnits="userSpaceOnUse">
        <rect width="${g}" height="${g}" fill="#8d8374"/>
        <rect x="2" y="2" width="${g / 2 - 3}" height="${g / 2 - 3}" fill="#978d7d"/>
        <rect x="${g / 2 + 1}" y="${g / 2 + 1}" width="${g / 2 - 3}" height="${g / 2 - 3}" fill="#857b6c"/>
        <path d="M0 0 H${g} V${g}" fill="none" stroke="#5e564b" stroke-width="1.5"/>
      </pattern>
      <pattern id="rock" width="40" height="40" patternUnits="userSpaceOnUse">
        <rect width="40" height="40" fill="#2b2622"/>
        <circle cx="10" cy="12" r="6" fill="#322c27"/><circle cx="30" cy="30" r="8" fill="#26211d"/>
      </pattern>
      <radialGradient id="pool"><stop offset="0" stop-color="#3f7f8f"/><stop offset="1" stop-color="#1e4250"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#rock)"/>
    <g fill="none" stroke="#1b1612" stroke-width="${g * 0.3}">${areas.map(rect).join("")}</g>
    <g fill="url(#flag)">${areas.map(rect).join("")}</g>
    <ellipse cx="${19 * sx * g}" cy="${4.5 * sy * g}" rx="${2.4 * sx * g}" ry="${1.6 * sy * g}" fill="url(#pool)" stroke="#5e564b" stroke-width="6"/>
    <g fill="#5b5247">
      <circle cx="${6 * sx * g}" cy="${13 * sy * g}" r="${g * 0.3}"/><circle cx="${6.6 * sx * g}" cy="${13.4 * sy * g}" r="${g * 0.2}"/>
      <circle cx="${22 * sx * g}" cy="${15 * sy * g}" r="${g * 0.35}"/><circle cx="${21.4 * sx * g}" cy="${15.5 * sy * g}" r="${g * 0.18}"/>
    </g>
    <g fill="#6b4a2b" stroke="#2a1b10" stroke-width="3">${doors.map(rect).join("")}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * A small 3D map (SPEC §8.3 3D maps; AC-SCN-04): a floor slab and four 1-ft-thick, 8-ft-high walls (overlapping at
 * the corners, like modular kit pieces) around a 20 × 30 ft room whose inner corner is at the origin.
 */
export async function roomGlb(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const texture = doc
    .createTexture("stone")
    .setImage(new Uint8Array(await stonePng(128)))
    .setMimeType("image/png");
  const material = doc
    .createMaterial("stone")
    .setBaseColorTexture(texture)
    .setRoughnessFactor(0.9)
    .setMetallicFactor(0);
  const scene = doc.createScene("crypt");
  const box = (name: string, min: V3, max: V3) =>
    scene.addChild(
      doc
        .createNode(name)
        .setMesh(doc.createMesh(name).addPrimitive(boxPrimitive(doc, buffer, min, max, material, 0.25))),
    );
  box("floor", [-1, -0.2, -1], [21, 0, 31]);
  box("north", [-1, 0, -1], [21, 8, 0]);
  box("south", [-1, 0, 30], [21, 8, 31]);
  box("west", [-1, 0, -1], [0, 8, 31]);
  box("east", [20, 0, -1], [21, 8, 31]);
  return new NodeIO().writeBinary(doc);
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
