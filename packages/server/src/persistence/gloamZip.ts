import { once } from "node:events";
import { closeSync, createWriteStream, fstatSync, openSync, readSync, renameSync, rmSync } from "node:fs";
import { crc32, inflateRawSync } from "node:zlib";
import { GloamError } from "@gloam/shared/protocol";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

/**
 * A `.gloam` file is a zip (SPEC §20.5). Reading one is an attack surface — it comes from another machine — so this
 * reader trusts nothing in it: the central directory is parsed here (fflate's reader doesn't expose an entry's file
 * attributes), every name must be one a `.gloam` can hold (a strict allow-list: no absolute paths, no `..`, nothing
 * else), symlinks, encrypted and ZIP64 entries are refused, and each entry is inflated on its own with its output
 * capped at the size it declares — a size that lies (a zip bomb) fails, as does a CRC that doesn't match.
 */
export const ZIP_LIMITS = {
  /** Entries in one file. */
  entries: 10_000,
  /** Everything it inflates to (SPEC §20.5: 4 GB). */
  total: 4 * 1024 ** 3,
  /** One entry (the largest asset or the campaign document), inflated. */
  entry: 512 * 1024 ** 2,
};

/** What a `.gloam` may contain: its manifest, its campaign document, and its assets by file id. */
const NAME =
  /^(?:manifest\.json|campaign\.json|assets\/[0-9a-f]{64}-[a-z0-9]{1,16}\.[a-z0-9]{1,5}|assets\/)$/;

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  compressed: number;
  size: number;
  crc: number;
  /** Where its local header starts. */
  offset: number;
}

const bad = (why: string): never => {
  throw new GloamError("INVALID", `That isn't a campaign file Gloam can import: ${why}.`);
};

/** A name as it may be quoted back in an error (printable, short). */
const quote = (n: string) => JSON.stringify(n.replace(/[^\x20-\x7e]/g, "?").slice(0, 80));

/** The entries of an open zip, checked (see above). */
export function readCentralDirectory(fd: number): ZipEntry[] {
  const size = fstatSync(fd).size;
  if (size < 22) bad("it's too short to be a zip");
  // The end-of-central-directory record: within the last 64 KiB + 22 bytes (its comment is at most 65 535 bytes).
  const tailLen = Math.min(size, 65_557);
  const tail = Buffer.alloc(tailLen);
  readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) bad("no zip directory at its end");
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    bad("it's a ZIP64 archive (too large)");
  if (count > ZIP_LIMITS.entries) bad(`it has ${count} entries (at most ${ZIP_LIMITS.entries})`);
  if (cdOffset + cdSize > size) bad("its directory runs past its end");
  const cd = Buffer.alloc(cdSize);
  readSync(fd, cd, 0, cdSize, cdOffset);
  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) bad("its directory is damaged");
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressed = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const external = cd.readUInt32LE(p + 38);
    const offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!NAME.test(name)) bad(`it holds ${quote(name)}, which a campaign file never does`);
    if (seen.has(name)) bad(`${quote(name)} appears twice`);
    seen.add(name);
    // A symbolic link (made on a Unix host, its mode a link) — never followed, never written: refused.
    const host = madeBy >> 8;
    if (host === 3 && ((external >>> 16) & 0o170000) === 0o120000) bad(`${quote(name)} is a symbolic link`);
    if (flags & 0x1) bad(`${quote(name)} is encrypted`);
    if (method !== 0 && method !== 8) bad(`${quote(name)} uses a compression Gloam doesn't read`);
    if (compressed === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff)
      bad("it's a ZIP64 archive");
    if (usize > ZIP_LIMITS.entry) bad(`${quote(name)} is larger than ${ZIP_LIMITS.entry / 1024 ** 2} MB`);
    if (method === 0 && compressed !== usize) bad(`${quote(name)}'s sizes disagree`);
    total += usize;
    if (total > ZIP_LIMITS.total) bad("it unpacks to more than 4 GB");
    if (offset + 30 + compressed > size) bad(`${quote(name)} runs past the end of the file`);
    if (name.endsWith("/")) continue;
    out.push({ name, method: method as 0 | 8, compressed, size: usize, crc, offset });
  }
  return out;
}

/** An entry's bytes: inflated to no more than it declares, its length and CRC checked. */
export function readEntry(fd: number, e: ZipEntry): Buffer {
  const head = Buffer.alloc(30);
  readSync(fd, head, 0, 30, e.offset);
  if (head.readUInt32LE(0) !== 0x04034b50) bad(`${quote(e.name)} has no local header`);
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const raw = Buffer.alloc(e.compressed);
  if (e.compressed) readSync(fd, raw, 0, e.compressed, start);
  let data: Buffer;
  if (e.method === 0) data = raw;
  else
    try {
      // `maxOutputLength` stops inflating past the declared size: a lie about it is an error, not memory.
      data = e.size === 0 ? Buffer.alloc(0) : inflateRawSync(raw, { maxOutputLength: e.size });
    } catch {
      return bad(`${quote(e.name)} doesn't unpack to the size it declares`);
    }
  if (data.length !== e.size) bad(`${quote(e.name)} doesn't unpack to the size it declares`);
  if (crc32(data) >>> 0 !== e.crc >>> 0) bad(`${quote(e.name)} is damaged (its checksum doesn't match)`);
  return data;
}

/** Opens a zip for reading entry by entry; the caller closes it. */
export function openZip(path: string): { fd: number; entries: ZipEntry[]; close: () => void } {
  const fd = openSync(path, "r");
  try {
    return { fd, entries: readCentralDirectory(fd), close: () => closeSync(fd) };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/**
 * Writes a zip as it goes (fflate's streaming Zip to a file): JSON deflated, already-compressed assets stored as they
 * are. Each entry is read only when it's written, and the file stream drains between entries — memory holds one entry,
 * not the export. Written beside `dest` and renamed into place once whole: a failed export leaves no half file.
 */
export async function writeZip(
  dest: string,
  entries: Iterable<{ name: string; read: () => Uint8Array; store?: boolean }>,
): Promise<number> {
  const tmp = `${dest}.part`;
  const out = createWriteStream(tmp, { mode: 0o600 });
  let bytes = 0;
  let failure: Error | null = null;
  let full = false;
  const finished = new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    out.on("finish", () => resolve());
  });
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failure = err;
      return;
    }
    bytes += chunk.length;
    if (!out.write(chunk)) full = true;
    if (final) out.end();
  });
  try {
    for (const e of entries) {
      const f = e.store ? new ZipPassThrough(e.name) : new ZipDeflate(e.name, { level: 6 });
      zip.add(f);
      f.push(e.read(), true);
      if (failure) throw failure;
      if (full) {
        full = false;
        await once(out, "drain");
      }
    }
    zip.end();
    await finished;
    if (failure) throw failure;
    renameSync(tmp, dest);
  } catch (err) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw err;
  }
  return bytes;
}
