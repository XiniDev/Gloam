/**
 * Content inspection that never trusts the input (SPEC §21.2): where an image really ends, whether a file is a
 * polyglot (an image that is also an active document), the GLB JSON chunk, and minimal audio container checks
 * (§21.5). Pure functions over a Buffer; the processor child runs them.
 */

/**
 * Active-content signatures rejected anywhere in an uploaded image or GLB JSON. Seven-plus specific bytes, so a
 * random match inside compressed data is astronomically unlikely (≈ 2⁻⁵⁶ per position).
 */
const ACTIVE =
  /<script|<html|<svg|<\?php|<iframe|<object|<embed|javascript:|vbscript:|onload\s*=|onerror\s*=/i;

/** Formats that must not ride along after an image's end marker (checked only there: short signatures such as
 * ZIP's 4 bytes would match by chance anywhere in a large compressed file). */
const TRAILING_BINARY: { name: string; sig: number[] }[] = [
  { name: "a ZIP/JAR archive", sig: [0x50, 0x4b, 0x03, 0x04] },
  { name: "a ZIP/JAR archive", sig: [0x50, 0x4b, 0x05, 0x06] },
  { name: "a PDF document", sig: [0x25, 0x50, 0x44, 0x46] },
  { name: "a Windows program", sig: [0x4d, 0x5a] },
  { name: "a Linux program", sig: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "a script", sig: [0x23, 0x21] },
  { name: "a RAR archive", sig: [0x52, 0x61, 0x72, 0x21] },
  { name: "a 7-Zip archive", sig: [0x37, 0x7a, 0xbc, 0xaf] },
];

export function hasActiveContent(buf: Buffer): boolean {
  // latin1 maps bytes 1:1, so the regex sees the raw bytes.
  return ACTIVE.test(buf.toString("latin1"));
}

/** Byte offset just past the image data (its end marker), or null if the structure is broken/truncated. */
export function imageEnd(buf: Buffer, mime: string): number | null {
  try {
    switch (mime) {
      case "image/png":
        return pngEnd(buf);
      case "image/jpeg":
        return jpegEnd(buf);
      case "image/gif":
        return gifEnd(buf);
      case "image/webp":
        return riffEnd(buf);
      case "image/avif":
        return isoBmffEnd(buf);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function pngEnd(b: Buffer): number | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!SIG.every((v, i) => b[i] === v)) return null;
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    const next = i + 12 + len;
    if (next > b.length) return null;
    if (type === "IEND") return next;
    i = next;
  }
  return null;
}

function jpegEnd(b: Buffer): number | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++; // fill bytes
    const m = b[i];
    i++;
    if (m === undefined) return null;
    if (m === 0xd9) return i; // EOI
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) continue; // markers without a length
    if (i + 2 > b.length) return null;
    const segEnd = i + b.readUInt16BE(i);
    if (segEnd > b.length) return null;
    i = segEnd;
    if (m === 0xda) {
      // Entropy-coded data until the next real marker (FF followed by something other than 00 or RSTn).
      while (i + 1 < b.length) {
        if (b[i] === 0xff) {
          const n = b[i + 1] as number;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
            i += n === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        i++;
      }
      if (i + 1 >= b.length) return null;
    }
  }
  return null;
}

function gifEnd(b: Buffer): number | null {
  const h = b.toString("latin1", 0, 6);
  if (h !== "GIF87a" && h !== "GIF89a") return null;
  const packed = b[10] as number;
  let i = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  const subBlocks = () => {
    for (;;) {
      const s = b[i];
      if (s === undefined) throw new Error("truncated");
      i++;
      if (s === 0) return;
      i += s;
    }
  };
  while (i < b.length) {
    const t = b[i];
    if (t === 0x3b) return i + 1; // trailer
    if (t === 0x21) {
      i += 2;
      subBlocks();
    } else if (t === 0x2c) {
      const p = b[i + 9] as number;
      i += 10 + (p & 0x80 ? 3 * 2 ** ((p & 7) + 1) : 0);
      i++; // LZW minimum code size
      subBlocks();
    } else return null;
  }
  return null;
}

function riffEnd(b: Buffer): number | null {
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const size = b.readUInt32LE(4);
  const end = 8 + size + (size % 2);
  return end <= b.length ? end : null;
}

/** ISOBMFF (AVIF, MP4/M4A): the end of the last well-formed top-level box. */
function isoBmffEnd(b: Buffer): number | null {
  let i = 0;
  let sawFtyp = false;
  while (i + 8 <= b.length) {
    let size = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    if (type === "ftyp") sawFtyp = true;
    if (size === 1) {
      if (i + 16 > b.length) return null;
      size = Number(b.readBigUInt64BE(i + 8));
    } else if (size === 0) size = b.length - i;
    if (size < 8 || i + size > b.length) return null;
    i += size;
  }
  return sawFtyp ? i : null;
}

/**
 * Why an image upload is a polyglot, or null. Rejected: active content anywhere; an executable/archive/document
 * or markup starting where the image ends. Not rejected: other trailing bytes (e.g. the MP4 a phone "motion photo"
 * appends after its JPEG) — re-encoding drops them.
 */
export function polyglotReason(buf: Buffer, mime: string): string | null {
  if (hasActiveContent(buf)) return "It contains web page or script code.";
  const end = imageEnd(buf, mime);
  if (end === null) return null; // structure errors are the decoder's to report ("damaged or incomplete")
  let j = end;
  while (j < buf.length && (buf[j] === 0x00 || buf[j] === 0x0a || buf[j] === 0x0d || buf[j] === 0x20)) j++;
  if (j >= buf.length) return null;
  for (const t of TRAILING_BINARY) {
    if (t.sig.every((v, k) => buf[j + k] === v)) return `It has ${t.name} hidden after the image.`;
  }
  if (buf[j] === 0x3c /* "<" */) return "It has markup hidden after the image.";
  return null;
}

// ── GLB ────────────────────────────────────────────────────────────────────────────────────────────────

/** The GLB's JSON chunk as text, or null when the container is malformed. */
export function glbJson(buf: Buffer): string | null {
  if (buf.length < 20 || buf.toString("latin1", 0, 4) !== "glTF") return null;
  const total = buf.readUInt32LE(8);
  if (total > buf.length) return null;
  const len = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a /* "JSON" */) return null;
  if (20 + len > total) return null;
  return buf.toString("utf8", 20, 20 + len);
}

// ── audio (SPEC §21.5) ──────────────────────────────────────────────────────────────────────────────────

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

function mp3FrameAt(b: Buffer, i: number): number | null {
  if (i + 4 > b.length || b[i] !== 0xff || ((b[i + 1] as number) & 0xe0) !== 0xe0) return null;
  const version = ((b[i + 1] as number) >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = ((b[i + 1] as number) >> 1) & 3; // 1 = Layer III
  const brIdx = ((b[i + 2] as number) >> 4) & 15;
  const srIdx = ((b[i + 2] as number) >> 2) & 3;
  const pad = ((b[i + 2] as number) >> 1) & 1;
  if (version === 1 || layer === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  if (version !== 3 || layer !== 1) return 4; // a valid header of another MPEG version/layer: accept the sync
  const rates = [44100, 48000, 32000];
  return Math.floor((144000 * (MP3_BITRATES_V1_L3[brIdx] as number)) / (rates[srIdx] as number)) + pad;
}

function mp3Ok(b: Buffer): boolean {
  let i = 0;
  if (b.toString("latin1", 0, 3) === "ID3" && b.length > 10) {
    const sz =
      (((b[6] as number) & 0x7f) << 21) |
      (((b[7] as number) & 0x7f) << 14) |
      (((b[8] as number) & 0x7f) << 7) |
      ((b[9] as number) & 0x7f);
    i = 10 + sz;
  }
  // Allow a little padding before the first frame, then require two consecutive valid frame headers.
  for (let k = 0; k < 4096 && i + k + 4 < b.length; k++) {
    const len = mp3FrameAt(b, i + k);
    if (len !== null && (len <= 4 || mp3FrameAt(b, i + k + len) !== null)) return true;
  }
  return false;
}

function oggOk(b: Buffer): boolean {
  if (b.toString("latin1", 0, 4) !== "OggS" || b[4] !== 0) return false;
  const segs = b[26] as number;
  const body = 27 + segs;
  if (body + 8 > b.length) return false;
  const head = b.toString("latin1", body, body + 8);
  return head.startsWith("\x01vorbis") || head.startsWith("OpusHead");
}

function wavOk(b: Buffer): boolean {
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return false;
  let i = 12;
  let fmt = false;
  while (i + 8 <= b.length) {
    const id = b.toString("latin1", i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === "fmt ") {
      const format = b.readUInt16LE(i + 8);
      fmt = format === 1 || format === 3 || format === 0xfffe;
    }
    if (id === "data") return fmt;
    i += 8 + size + (size % 2);
  }
  return false;
}

function flacOk(b: Buffer): boolean {
  return b.toString("latin1", 0, 4) === "fLaC" && ((b[4] as number) & 0x7f) === 0; // STREAMINFO first
}

/** Handler types of an MP4's tracks (moov → trak → mdia → hdlr). */
function mp4Handlers(b: Buffer): string[] {
  const out: string[] = [];
  const walk = (start: number, end: number, path: string[]) => {
    let i = start;
    while (i + 8 <= end) {
      let size = b.readUInt32BE(i);
      const type = b.toString("latin1", i + 4, i + 8);
      let header = 8;
      if (size === 1) {
        size = Number(b.readBigUInt64BE(i + 8));
        header = 16;
      } else if (size === 0) size = end - i;
      if (size < header || i + size > end) return;
      if (type === "moov" || type === "trak" || type === "mdia") walk(i + header, i + size, [...path, type]);
      else if (type === "hdlr" && path.at(-1) === "mdia")
        out.push(b.toString("latin1", i + header + 8, i + header + 12));
      i += size;
    }
  };
  walk(0, b.length, []);
  return out;
}

/** Why an audio file fails its container check, or null when it passes (SPEC §21.5; R3 note 25 for MP4). */
export function audioProblem(buf: Buffer, mime: string): string | null {
  switch (mime) {
    case "audio/mpeg":
      return mp3Ok(buf) ? null : "This MP3 has no valid audio frames.";
    case "audio/ogg":
    case "audio/ogg; codecs=opus":
      return oggOk(buf) ? null : "This Ogg file isn't Vorbis or Opus audio.";
    case "audio/wav":
      return wavOk(buf) ? null : "This WAV file has no audio data.";
    case "audio/flac":
      return flacOk(buf) ? null : "This FLAC file is damaged.";
    case "audio/x-m4a":
    case "video/mp4": {
      if (isoBmffEnd(buf) === null) return "This M4A file is damaged.";
      const h = mp4Handlers(buf);
      if (!h.includes("soun")) return "This file has no audio track.";
      if (h.some((x) => x !== "soun")) return "Only audio files are accepted — this one contains video.";
      return null;
    }
    default:
      return "That audio format isn't supported.";
  }
}
