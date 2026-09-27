import {
  type BufferGeometry,
  LinearMipmapLinearFilter,
  type Material,
  type Mesh,
  type Object3D,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { assetUrl, fetchAsset } from "../net/assets.ts";
import { useLoading } from "./diag.ts";
import { disposeLater } from "./dispose.ts";
import { wake } from "./frames.ts";

/**
 * Refcounted GPU resources per asset (SPEC §24.8): every token using the same image shares one texture, every mini
 * using the same GLB shares its geometry and materials (AC-TOK-10), and everything is disposed when the last user
 * lets go. GLBs load with GLTFLoader + MeshoptDecoder only — never Draco (SPEC §21.4 step 6).
 */

interface Entry<T> {
  promise: Promise<T>;
  refs: number;
  value?: T;
  dispose(v: T): void;
}

const textures = new Map<string, Entry<Texture>>();
const models = new Map<string, Entry<GLTF>>();
let anisotropy = 4;

export function setMaxAnisotropy(n: number): void {
  anisotropy = Math.max(1, Math.min(16, n));
}

function acquire<T>(
  map: Map<string, Entry<T>>,
  key: string,
  load: () => Promise<T>,
  dispose: (v: T) => void,
) {
  let e = map.get(key);
  if (!e) {
    const loaded = useLoading.getState().begin();
    const entry: Entry<T> = { promise: load(), refs: 0, dispose };
    // A finished load changes the picture (on-demand rendering): draw for a moment.
    entry.promise
      .finally(() => {
        loaded();
        wake();
      })
      .catch(() => {});
    entry.promise.then(
      (v) => {
        entry.value = v;
        if (entry.refs <= 0) {
          map.delete(key);
          dispose(v);
        }
      },
      () => map.delete(key),
    );
    map.set(key, entry);
    e = entry;
  }
  e.refs++;
  const entry = e;
  let released = false;
  return {
    promise: entry.promise,
    release() {
      if (released) return;
      released = true;
      entry.refs--;
      if (entry.refs <= 0 && entry.value !== undefined) {
        map.delete(key);
        entry.dispose(entry.value);
      }
    },
  };
}

/** An image variant as a texture (decoded off the main thread by createImageBitmap). */
export function acquireTexture(assetId: string, variant: string) {
  return acquire(
    textures,
    `${assetId}/${variant}`,
    async () => {
      const blob = await (await fetchAsset(assetUrl(assetId, variant))).blob();
      const bitmap = await createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "none" });
      const tex = new Texture(bitmap as unknown as HTMLImageElement);
      tex.flipY = false; // already flipped while decoding
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = anisotropy;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      tex.userData.size = [bitmap.width, bitmap.height];
      return tex;
    },
    (t) => {
      (t.image as ImageBitmap | undefined)?.close?.();
      t.dispose();
    },
  );
}

let loader: GLTFLoader | null = null;
async function gltfLoader(): Promise<GLTFLoader> {
  if (!loader) {
    await MeshoptDecoder.ready;
    loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    // Embedded GLB textures: three.js would fetch() the blob: URL it makes for each image (ImageBitmapLoader),
    // which our CSP forbids (connect-src 'self', SPEC §22.4); an image element loads it under img-src blob:.
    loader.register((parser) => {
      parser.textureLoader = new TextureLoader(parser.options.manager);
      return { name: "gloam_image_element_textures" };
    });
  }
  return loader;
}

function disposeScene(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) (m.geometry as BufferGeometry).dispose();
    const mats = (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as Material[];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof Texture) v.dispose();
      disposeLater(mat);
    }
  });
}

/** A GLB asset (minis and 3D maps). Clone its scene with SkeletonUtils.clone to share geometry and materials. */
export function acquireGlb(assetId: string) {
  return acquire(
    models,
    assetId,
    async () => {
      const buf = await (await fetchAsset(assetUrl(assetId, "glb"))).arrayBuffer();
      return (await gltfLoader()).parseAsync(buf, "");
    },
    (g) => disposeScene(g.scene),
  );
}

/** Diagnostics for tests and the perf overlay. */
export function resourceStats() {
  return {
    textures: [...textures.entries()].map(([k, e]) => ({ key: k, refs: e.refs })),
    models: [...models.entries()].map(([k, e]) => ({ key: k, refs: e.refs })),
  };
}
