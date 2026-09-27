/** Test files for the asset pipeline (AC-AST-01…07, AC-TOK-03, AC-BRD-06). */
export declare const image: (
  format: "png" | "jpeg" | "webp" | "gif" | "avif",
  w?: number,
  h?: number,
  opts?: {
    exif?: string;
    alpha?: boolean;
  },
) => Promise<Buffer<ArrayBuffer>>;
/** Random-noise PNG (incompressible), about `w*h*3` bytes. */
export declare const noisePng: (w: number, h: number) => Promise<Buffer<ArrayBuffer>>;
/** A tiny PNG that declares an enormous canvas (a decompression bomb). */
export declare function bombPng(w?: number, h?: number): Buffer;
/** A real PNG with a processor test-hook marker right after IHDR (hang / oom / crash; test builds only). */
export declare function hookFile(kind: "hang" | "oom" | "crash"): Promise<Buffer>;
/** A minimal but real ZIP archive with one stored file. */
export declare function zip(name?: string, content?: string): Buffer;
/** PCM WAV with `ms` of silence. */
export declare function wav(ms?: number): Buffer;
/**
 * A textured box GLB, `height` tall with its base at `baseY`, plus the things §21.4 strips: a camera, a punctual
 * light and extras. `boxes` repeats the geometry to raise the triangle count.
 */
export declare function glb(opts?: { height?: number; baseY?: number; boxes?: number }): Promise<Uint8Array>;
/** One wavy grid mesh of `2·n²` triangles (a dense, simplifiable sculpt). */
export declare function denseGlb(n: number): Promise<Uint8Array>;
/** Rewrites a GLB's JSON chunk (keeps the BIN chunk). */
export declare function editGlbJson(bytes: Uint8Array, fn: (json: Record<string, unknown>) => void): Buffer;
