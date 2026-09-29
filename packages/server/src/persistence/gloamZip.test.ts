import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { openZip, readEntry, writeZip, ZIP_LIMITS } from "./gloamZip.ts";

const dir = mkdtempSync(join(tmpdir(), "gloam-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (bytes: Uint8Array) => {
  const p = join(dir, `z${n++}.gloam`);
  writeFileSync(p, bytes);
  return p;
};
const hex = (c: string) => c.repeat(64);
const asset = (c: string) => `assets/${hex(c)}-image.webp`;
const read = (p: string) => {
  const z = openZip(p);
  try {
    return z.entries.map((e) => [e.name, readEntry(z.fd, e).toString("utf8")] as const);
  } finally {
    z.close();
  }
};

describe("reading a .gloam safely (SPEC §20.5)", () => {
  it("writes and reads back its manifest, document and assets", async () => {
    const p = join(dir, "ok.gloam");
    const bytes = await writeZip(p, [
      { name: "manifest.json", read: () => Buffer.from('{"format":"gloam-export"}') },
      { name: "campaign.json", read: () => Buffer.from("x".repeat(10_000)) },
      { name: asset("a"), read: () => Buffer.from("webp bytes"), store: true },
    ]);
    expect(bytes).toBe(readFileSync(p).length);
    expect(read(p)).toEqual([
      ["manifest.json", '{"format":"gloam-export"}'],
      ["campaign.json", "x".repeat(10_000)],
      [asset("a"), "webp bytes"],
    ]);
  });

  it("refuses names a campaign file never holds: a way out of its folder, an absolute path, anything else", () => {
    for (const name of [
      "../escape.json",
      "assets/../../x",
      "/etc/passwd",
      "C:/x.json",
      "notes.txt",
      "assets/evil.sh",
    ]) {
      const p = file(zipSync({ [name]: new Uint8Array([1]) }));
      expect(() => openZip(p), name).toThrow(/never does/);
    }
  });

  it("refuses a symbolic link, whatever it's named", () => {
    const p = file(
      zipSync({ [asset("b")]: [Buffer.from("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }),
    );
    expect(() => openZip(p)).toThrow(/symbolic link/);
  });

  it("stops at the size an entry declares (a zip bomb lying about it), and checks each entry's CRC", () => {
    const bomb = Buffer.from(zipSync({ [asset("c")]: new Uint8Array(1_000_000) }, { level: 9 }));
    // Its central directory claims 1 000 bytes: the inflate stops there, and says why.
    const cd = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(1000, cd + 24);
    const z = openZip(file(bomb));
    try {
      expect(() => readEntry(z.fd, z.entries[0] as never)).toThrow(/size it declares/);
    } finally {
      z.close();
    }
    const stored = Buffer.from(zipSync({ [asset("d")]: Buffer.from("hello world") }, { level: 0 }));
    stored[stored.indexOf("hello")] = "j".charCodeAt(0);
    const y = openZip(file(stored));
    try {
      expect(() => readEntry(y.fd, y.entries[0] as never)).toThrow(/checksum/);
    } finally {
      y.close();
    }
  });

  it("refuses too many entries, a name twice, and what isn't a zip", () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i <= ZIP_LIMITS.entries; i++)
      many[`assets/${i.toString(16).padStart(64, "0")}-x.png`] = new Uint8Array(0);
    expect(() => openZip(file(zipSync(many, { level: 0 })))).toThrow(/entries/);
    const one = Buffer.from(zipSync({ "campaign.json": Buffer.from("{}") }, { level: 0 }));
    // The same entry listed twice: its central record repeated, the count bumped.
    const cd = one.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const eocd = one.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const rec = one.subarray(cd, eocd);
    const twice = Buffer.concat([one.subarray(0, eocd), rec, one.subarray(eocd)]);
    twice.writeUInt16LE(2, twice.length - 22 + 10);
    twice.writeUInt32LE(rec.length * 2, twice.length - 22 + 12);
    expect(() => openZip(file(twice))).toThrow(/twice/);
    expect(() => openZip(file(Buffer.from("not a zip at all, just text")))).toThrow(/no zip directory/);
  });
});
