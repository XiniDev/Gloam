import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { audioProblem, glbJson, hasActiveContent, imageEnd, polyglotReason } from "./sniff.ts";

const img = (format: "png" | "jpeg" | "gif" | "webp" | "avif") =>
  sharp({ create: { width: 24, height: 16, channels: 3, background: { r: 120, g: 80, b: 40 } } })
    .toFormat(format)
    .toBuffer();

const MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
} as const;

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length);
  h.write(type, 4, "latin1");
  return Buffer.concat([h, body]);
}
const hdlr = (handler: string) =>
  box("hdlr", Buffer.alloc(8), Buffer.from(handler, "latin1"), Buffer.alloc(12));
const trak = (handler: string) => box("trak", box("mdia", hdlr(handler)));

describe("asset sniffing (SPEC §21.2, AC-AST-01/07)", () => {
  it("finds the end of every allowed image format exactly", async () => {
    for (const f of ["png", "jpeg", "gif", "webp", "avif"] as const) {
      const b = await img(f);
      expect(imageEnd(b, MIME[f]), f).toBe(b.length);
      expect(polyglotReason(b, MIME[f]), f).toBeNull();
    }
  });

  it("rejects polyglots: archives, documents, programs or markup after the image; script anywhere", async () => {
    const png = await img("png");
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    expect(polyglotReason(Buffer.concat([png, zip]), "image/png")).toMatch(/ZIP/);
    const jpeg = await img("jpeg");
    expect(polyglotReason(Buffer.concat([jpeg, Buffer.from("\n<html><body>hi")]), "image/jpeg")).toMatch(
      /web page|markup/,
    );
    expect(polyglotReason(Buffer.concat([jpeg, Buffer.from("%PDF-1.7")]), "image/jpeg")).toMatch(/PDF/);
    const gif = await img("gif");
    expect(polyglotReason(Buffer.concat([gif, Buffer.from("MZ\x90\x00")]), "image/gif")).toMatch(/Windows/);
    // A GIF/JS polyglot hides script inside the file, not after it.
    const withScript = Buffer.concat([
      gif.subarray(0, 13),
      Buffer.from("<script>alert(1)</script>"),
      gif.subarray(13),
    ]);
    expect(polyglotReason(withScript, "image/gif")).toMatch(/script/);
    expect(hasActiveContent(Buffer.from("xx javascript:alert(1)"))).toBe(true);
  });

  it("allows harmless trailing data (a phone motion photo's MP4 after the JPEG)", async () => {
    const jpeg = await img("jpeg");
    const mp4 = box("ftyp", Buffer.from("mp42\0\0\0\0isom", "latin1"));
    expect(polyglotReason(Buffer.concat([jpeg, mp4]), "image/jpeg")).toBeNull();
  });

  it("reports truncated images as structurally broken (the decoder then rejects them)", async () => {
    const png = await img("png");
    expect(imageEnd(png.subarray(0, png.length - 20), "image/png")).toBeNull();
    const jpeg = await img("jpeg");
    expect(imageEnd(jpeg.subarray(0, jpeg.length - 2), "image/jpeg")).toBeNull();
  });

  it("extracts a GLB's JSON chunk and refuses malformed containers", () => {
    const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }).padEnd(28, " "));
    const header = Buffer.alloc(20);
    header.write("glTF", 0, "latin1");
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + json.length, 8);
    header.writeUInt32LE(json.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    const glb = Buffer.concat([header, json]);
    expect(JSON.parse(glbJson(glb) as string)).toEqual({ asset: { version: "2.0" } });
    expect(glbJson(Buffer.from("PK\x03\x04 not a glb at all............"))).toBeNull();
    expect(glbJson(glb.subarray(0, 24))).toBeNull();
  });

  it("checks audio containers (SPEC §21.5)", () => {
    // WAV: RIFF/WAVE with a PCM fmt chunk and a data chunk.
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0, "latin1");
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    const data = Buffer.concat([Buffer.from("data", "latin1"), Buffer.from([4, 0, 0, 0]), Buffer.alloc(4)]);
    const riff = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE", "latin1"), fmt, data]);
    expect(audioProblem(riff, "audio/wav")).toBeNull();
    expect(audioProblem(Buffer.from("RIFF\0\0\0\0WAVEjunk", "latin1"), "audio/wav")).toMatch(/no audio/);
    // MP3: two consecutive MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz → 417 bytes each).
    const frame = Buffer.alloc(417);
    frame.set([0xff, 0xfb, 0x90, 0x64]);
    expect(audioProblem(Buffer.concat([frame, frame]), "audio/mpeg")).toBeNull();
    expect(audioProblem(Buffer.from("ID3\x03\0\0\0\0\0\0garbage garbage", "latin1"), "audio/mpeg")).toMatch(
      /frames/,
    );
    // Ogg: first page carries the Vorbis identification header.
    const page = Buffer.concat([
      Buffer.from("OggS", "latin1"),
      Buffer.alloc(22),
      Buffer.from([1, 30]),
      Buffer.from("\x01vorbis", "latin1"),
      Buffer.alloc(23),
    ]);
    expect(audioProblem(page, "audio/ogg")).toBeNull();
    // FLAC: STREAMINFO first.
    expect(audioProblem(Buffer.from([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]), "audio/flac")).toBeNull();
    // MP4: audio-only moov accepted; a video track is refused.
    const ftyp = box("ftyp", Buffer.from("M4A \0\0\0\0isom", "latin1"));
    expect(audioProblem(Buffer.concat([ftyp, box("moov", trak("soun"))]), "audio/x-m4a")).toBeNull();
    expect(audioProblem(Buffer.concat([ftyp, box("moov", trak("soun"), trak("vide"))]), "video/mp4")).toMatch(
      /video/,
    );
  });
});
