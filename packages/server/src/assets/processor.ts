/**
 * The asset processor — a separate child process (SPEC §21.1 step 5, §21.2). It receives a job (an input path, a
 * staging directory, a profile) over IPC, writes only into that staging directory, touches neither the database nor
 * the network, and answers with metadata and output file names. Native image/mesh libraries allocate outside the JS
 * heap, so the parent watches this process's RSS and kills it on overrun, timeout or crash.
 */
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Document, getBounds, Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  meshopt,
  metalRough,
  prune,
  simplify,
  textureCompress,
  weld,
} from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { validateBytes } from "gltf-validator";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp, { type Metadata, type OutputInfo } from "sharp";
import { audioProblem, glbJson, hasActiveContent, polyglotReason } from "./sniff.ts";
import {
  GLB_BUDGET,
  IMAGE_VARIANTS,
  PIXEL_LIMIT,
  type ProcessJob,
  type ProcessMeta,
  type ProcessorMessage,
  type ProcessResult,
  type VariantOut,
} from "./types.ts";

sharp.concurrency(1);
sharp.cache(false);

const send = (m: ProcessorMessage) => process.send?.(m);
const fail = (reason: string): ProcessResult => ({ ok: false, reason });

// ── images (SPEC §21.3) ─────────────────────────────────────────────────────────────────────────────────

const PROFILE_LABEL = { map: "maps", tok: "tokens, portraits and drawings", hnd: "handouts" } as const;

async function runImage(job: ProcessJob): Promise<ProcessResult> {
  const profile = job.profile as "map" | "tok" | "hnd";
  const buf = await readFile(job.input);
  const poly = polyglotReason(buf, job.mime);
  if (poly) return fail(`This image was refused for safety: ${poly}`);
  let meta: Metadata;
  try {
    meta = await sharp(buf, { failOn: "error", limitInputPixels: false, animated: false }).metadata();
  } catch {
    return fail("The image file is damaged or incomplete.");
  }
  const w = meta.width ?? 0;
  const h = meta.pageHeight ?? meta.height ?? 0; // GIFs contribute their first frame only
  if (!w || !h) return fail("The image file is damaged or incomplete.");
  // Decompression bombs: judge by the declared size before decoding a single pixel.
  const limit = PIXEL_LIMIT[profile];
  if (w * h > limit) {
    const side = Math.floor(Math.sqrt(limit));
    return fail(
      `This image is ${w.toLocaleString("en")} × ${h.toLocaleString("en")} pixels — ${PROFILE_LABEL[profile]} can be at most ${side.toLocaleString("en")} × ${side.toLocaleString("en")}.`,
    );
  }
  const swap = (meta.orientation ?? 1) >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const L = Math.max(W, H);
  const sizes = [...new Set(IMAGE_VARIANTS[profile].map((s) => Math.min(s, L)))].sort((a, b) => b - a);
  const variants: VariantOut[] = [];
  // Decode the (possibly huge) source once, for the largest variant; derive smaller ones from that output.
  let source: Buffer | string = buf;
  let sourceIsOriginal = true;
  for (const size of sizes) {
    const file = `w${size}.webp`;
    let p = sharp(source, {
      failOn: sourceIsOriginal ? "error" : "none",
      limitInputPixels: limit,
      animated: false,
      sequentialRead: true,
    });
    if (sourceIsOriginal) p = p.rotate(); // EXIF orientation; metadata is stripped on output
    p = p.resize({
      width: W >= H ? size : undefined,
      height: H > W ? size : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
    p =
      profile === "map"
        ? p.flatten({ background: "#000000" }).webp({ quality: 88, effort: size > 4096 ? 2 : 4 })
        : p.webp({ quality: 90, alphaQuality: 90, effort: 4 });
    let info: OutputInfo;
    try {
      info = await p.toFile(join(job.outDir, file));
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (/pixel limit/i.test(msg)) return fail("This image has too many pixels.");
      return fail("The image file is damaged or incomplete.");
    }
    variants.push({
      name: `w${size}`,
      file,
      mime: "image/webp",
      bytes: info.size,
      width: info.width,
      height: info.height,
    });
    source = join(job.outDir, file);
    sourceIsOriginal = false;
  }
  const smallest = variants.at(-1) as VariantOut;
  const { dominant } = await sharp(join(job.outDir, smallest.file)).stats();
  const hex = `#${[dominant.r, dominant.g, dominant.b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  return { ok: true, variants, meta: { width: W, height: H, dominant: hex } };
}

// ── GLB (SPEC §21.4, R3 notes 26–31) ────────────────────────────────────────────────────────────────────

/** Extensions kept on output: the §21.4 allow-list, narrowed to what three's GLTFLoader renders (R3 note 29). */
const KEEP = new Set([
  "KHR_materials_anisotropy",
  "KHR_materials_clearcoat",
  "KHR_materials_dispersion",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_iridescence",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_unlit",
  "KHR_materials_volume",
  "KHR_texture_transform",
  "KHR_mesh_quantization",
  "EXT_meshopt_compression",
  "EXT_texture_webp",
]);
/** Required extensions we can decode (then convert or strip) — anything else required is refused. */
const DECODABLE = new Set([
  ...KEEP,
  "KHR_draco_mesh_compression",
  "KHR_materials_pbrSpecularGlossiness",
  "KHR_lights_punctual",
  "KHR_materials_diffuse_transmission",
]);

let ioPromise: Promise<NodeIO> | null = null;
function io(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
    return new NodeIO()
      .setLogger(new Logger(Logger.Verbosity.ERROR))
      .setAllowNetwork(false)
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        "meshopt.decoder": MeshoptDecoder,
        "meshopt.encoder": MeshoptEncoder,
        "draco3d.decoder": await draco3d.createDecoderModule(),
      });
  })();
  return ioPromise;
}

function countTriangles(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const count = prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION")?.getCount() ?? 0;
      const mode = prim.getMode();
      if (mode === 4) n += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) n += Math.max(0, count - 2);
    }
  }
  return n;
}

async function validate(bytes: Uint8Array): Promise<string | null> {
  const report = await validateBytes(bytes, { format: "glb", maxIssues: 100, writeTimestamp: false });
  if (report.issues.numErrors > 0) {
    const first = report.issues.messages.find((m) => m.severity === 0);
    return `This model has ${report.issues.numErrors} error${report.issues.numErrors === 1 ? "" : "s"}${first ? ` (first: ${first.message})` : ""}.`;
  }
  if (report.info?.resources?.some((r) => r.storage === "external"))
    return "This model points to files outside the .glb — export it as one self-contained .glb.";
  return null;
}

async function runModel(job: ProcessJob): Promise<ProcessResult> {
  const profile = job.profile as "mini" | "mapglb";
  const buf = await readFile(job.input);
  const json = glbJson(buf);
  if (json === null) return fail("This isn't a valid .glb file.");
  if (hasActiveContent(Buffer.from(json)))
    return fail("This model was refused for safety: it contains web page or script code.");
  let gltf: { extensionsRequired?: unknown; extensionsUsed?: unknown };
  try {
    gltf = JSON.parse(json) as typeof gltf;
  } catch {
    return fail("This isn't a valid .glb file.");
  }
  const required = Array.isArray(gltf.extensionsRequired) ? gltf.extensionsRequired.map(String) : [];
  const used = Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed.map(String) : [];
  if ([...required, ...used].includes("KHR_texture_basisu"))
    return fail("KTX2/Basis textures aren't supported — export the model with PNG, JPEG or WebP textures.");
  const unknown = required.find((e) => !DECODABLE.has(e));
  if (unknown) return fail(`This model requires an extension Gloam can't read safely (${unknown}).`);
  const invalid = await validate(new Uint8Array(buf));
  if (invalid) return fail(invalid);

  const nodeIO = await io();
  let doc: Document;
  try {
    doc = await nodeIO.readBinary(new Uint8Array(buf));
  } catch (err) {
    return fail(`This model couldn't be read (${String((err as Error).message ?? err).slice(0, 120)}).`);
  }
  const root = doc.getRoot();
  for (const tex of root.listTextures()) {
    const mime = tex.getMimeType();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime))
      return fail(`This model has a ${mime || "unknown"} texture — use PNG, JPEG or WebP textures.`);
    const size = tex.getSize();
    if (!size || size[0] > 8192 || size[1] > 8192)
      return fail("This model has a texture larger than 8192 × 8192.");
  }
  // Strip (before compression, R3 note 29): spec-gloss → metal-rough, then every extension outside the keep list,
  // cameras, lights and extras.
  if (root.listExtensionsUsed().some((e) => e.extensionName === "KHR_materials_pbrSpecularGlossiness"))
    await doc.transform(metalRough());
  for (const ext of root.listExtensionsUsed()) if (!KEEP.has(ext.extensionName)) ext.dispose();
  for (const cam of root.listCameras()) cam.dispose();
  for (const p of [
    root,
    ...root.listScenes(),
    ...root.listNodes(),
    ...root.listMeshes(),
    ...root.listMaterials(),
    ...root.listTextures(),
    ...root.listAnimations(),
    ...root.listSkins(),
    ...root.listAccessors(),
    ...root.listBuffers(),
  ])
    p.setExtras({});
  const trianglesIn = countTriangles(doc);
  const budget = GLB_BUDGET[profile];
  // Every primitive is a draw call; thousands of separate parts also can't be simplified (per-primitive).
  const primitives = root.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
  if (primitives > budget.primitives)
    return fail(
      `This model has ${primitives.toLocaleString("en")} separate parts (the limit is ${budget.primitives.toLocaleString("en")}). Join them in Blender (select all, Ctrl+J) and try again.`,
    );
  await doc.transform(prune(), dedup(), weld());
  // Simplify toward the triangle budget (R3 note 31: error 0.01), loosening the tolerance if a pass falls short.
  for (const error of [0.01, 0.05, 0.1]) {
    const tris = countTriangles(doc);
    if (tris <= budget.triangles) break;
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: budget.triangles / tris, error }));
  }
  const trianglesOut = countTriangles(doc);
  // Simplification works per primitive, so thousands of tiny separate parts can't be reduced. Shipping such a
  // model would cost every player frame rate, so refuse it with the fix instead.
  if (trianglesOut > budget.triangles * 1.5)
    return fail(
      `This model is too detailed (${trianglesOut.toLocaleString("en")} triangles after simplifying; the limit is ${budget.triangles.toLocaleString("en")}). Reduce it in Blender with a Decimate modifier, or join its parts, and try again.`,
    );
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [budget.texture, budget.texture] }),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
    prune(),
  );
  for (const tex of root.listTextures())
    if (tex.getMimeType() !== "image/webp") return fail("A texture in this model couldn't be converted.");
  const out = await nodeIO.writeBinary(doc);
  // Output gate (R3 note 27): it reads back, and the validator reports no errors and no external resources.
  let check: Document;
  try {
    check = await nodeIO.readBinary(out);
  } catch {
    return fail("Optimising this model produced an invalid file.");
  }
  const outInvalid = await validate(out);
  if (outInvalid) return fail(`Optimising this model produced an invalid file: ${outInvalid}`);
  const scene = check.getRoot().getDefaultScene() ?? check.getRoot().listScenes()[0];
  if (!scene) return fail("This model has no scene to show.");
  const b = getBounds(scene);
  if (!b.min.every(Number.isFinite) || !b.max.every(Number.isFinite))
    return fail("This model has no geometry.");
  await writeFile(join(job.outDir, "model.glb"), out);
  const meta: ProcessMeta = {
    glb: {
      triangles: countTriangles(check),
      trianglesIn,
      textures: check.getRoot().listTextures().length,
      animations: check
        .getRoot()
        .listAnimations()
        .map((a) => a.getName()),
      bounds: { min: b.min as [number, number, number], max: b.max as [number, number, number] },
    },
  };
  return {
    ok: true,
    variants: [{ name: "glb", file: "model.glb", mime: "model/gltf-binary", bytes: out.byteLength }],
    meta,
  };
}

// ── audio (SPEC §21.5) ──────────────────────────────────────────────────────────────────────────────────

const AUDIO_EXT: Record<string, [string, string]> = {
  "audio/mpeg": ["mp3", "audio/mpeg"],
  "audio/ogg": ["ogg", "audio/ogg"],
  "audio/ogg; codecs=opus": ["ogg", "audio/ogg"],
  "audio/wav": ["wav", "audio/wav"],
  "audio/flac": ["flac", "audio/flac"],
  "audio/x-m4a": ["m4a", "audio/mp4"],
  "video/mp4": ["m4a", "audio/mp4"],
};

async function runAudio(job: ProcessJob): Promise<ProcessResult> {
  const buf = await readFile(job.input);
  const problem = audioProblem(buf, job.mime);
  if (problem) return fail(problem);
  const [ext, mime] = AUDIO_EXT[job.mime] ?? ["bin", "application/octet-stream"];
  const file = `orig.${ext}`;
  await copyFile(job.input, join(job.outDir, file));
  return {
    ok: true,
    variants: [{ name: "orig", file, mime, bytes: buf.length }],
    meta: { audio: { container: ext } },
  };
}

// ── test hooks (NODE_ENV=test only): prove the parent survives hangs, runaway memory and crashes ─────────

const retained: Buffer[] = [];
async function runTestHook(job: ProcessJob): Promise<ProcessResult | null> {
  if (process.env.GLOAM_TEST_PROCESSOR_HOOKS !== "1") return null;
  const head = (await readFile(job.input)).subarray(0, 64).toString("latin1");
  const marker = /__gloam_test_(hang|oom|crash)__/.exec(head)?.[1];
  if (marker === "hang") for (;;) {}
  if (marker === "oom") {
    // Native (off-heap) allocation, like a runaway decoder: the parent's RSS watchdog must kill us.
    for (;;) {
      const b = Buffer.allocUnsafe(64 * 1024 * 1024);
      b.fill(1);
      retained.push(b);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (marker === "crash") process.exit(0xc0000005 & 0xff);
  return null;
}

async function run(job: ProcessJob): Promise<ProcessResult> {
  const hooked = await runTestHook(job);
  if (hooked) return hooked;
  if (job.cls === "image") return runImage(job);
  if (job.cls === "model") return runModel(job);
  return runAudio(job);
}

setInterval(() => send({ type: "rss", rss: process.memoryUsage().rss }), 250);
process.on("message", (m: { type?: string; job?: ProcessJob }) => {
  if (m?.type !== "job" || !m.job) return;
  const job = m.job;
  run(job)
    .catch(
      (err: unknown): ProcessResult =>
        fail(`Processing failed (${String((err as Error)?.message ?? err).slice(0, 160)}).`),
    )
    .then((result) => send({ type: "result", id: job.id, result }));
});
send({ type: "ready" });
