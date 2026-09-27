#!/usr/bin/env node
// Generates packages/web/src/assets/noise.png: the 128 × 128 grain tile overlaid on chrome panels (SPEC §27.4).
// Deterministic (seeded PRNG) and dependency-free (hand-rolled PNG: IHDR + one zlib IDAT + IEND), so the file is
// reproducible and the browser never generates it at startup (a GPU readback that stalled software-GL machines).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { ROOT } from "./features-lib.mjs";

const SIZE = 128;
const OUT = join(ROOT, "packages", "web", "src", "assets", "noise.png");

/** mulberry32 — small, fast, good enough for visual grain. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const rand = prng(0x6a0a4d);
// Grey + alpha (colour type 4), 8 bits; each scanline starts with filter byte 0.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 2));
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 2);
  raw[row] = 0;
  for (let x = 0; x < SIZE; x++) {
    raw[row + 1 + x * 2] = 110 + Math.floor(rand() * 40);
    raw[row + 2 + x * 2] = 10; // ≈ 4 % opacity
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 4; // grey + alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);
