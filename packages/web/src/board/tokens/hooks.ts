import { SIZE_MINI_HEIGHT_FT, type Size } from "@gloam/shared";
import type { TokenView } from "@gloam/shared/state";
import { useEffect, useState } from "react";
import { Box3, type Group, type Mesh, type Texture, Vector3 } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { assetMeta, pickImageVariant } from "../../net/assets.ts";
import { type AssetRender, useLibrary } from "../../state/library.ts";
import { acquireGlb, acquireTexture } from "../resources.ts";
import { withFog } from "../vision/fogMaterial.ts";
import { initialsTexture } from "./glyphs.ts";

/** An asset's render view, kept current when it changes (e.g. a mini's overrides, pushed to every client). */
export function useAssetMeta(id: string | undefined): AssetRender | null {
  const live = useLibrary((s) => (id ? s.renders.get(id) : undefined));
  const [meta, setMeta] = useState<AssetRender | null>(null);
  useEffect(() => {
    if (!id) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    void assetMeta(id).then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return live ?? meta;
}

/** A shared texture for a token image (one per asset + variant; refcounted). */
export function useAssetTexture(meta: AssetRender | null, maxSize: number): Texture | null {
  const [tex, setTex] = useState<Texture | null>(null);
  const variant = meta && meta.cls === "image" ? pickImageVariant(meta, maxSize)?.name : undefined;
  const id = meta?.id;
  useEffect(() => {
    if (!id || !variant) {
      setTex(null);
      return;
    }
    let cancelled = false;
    const h = acquireTexture(id, variant);
    h.promise.then(
      (t) => {
        if (!cancelled) setTex(t);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      h.release();
    };
  }, [id, variant]);
  return tex;
}

export interface MiniInstance {
  root: Group;
  gltf: GLTF;
  /** Scale that makes the model the size category's height (SPEC §8.5). */
  scale: number;
  /** Offset that grounds the model at y = 0 and centres it on its base. */
  offset: Vector3;
  height: number;
  /** The model's bounds after `offset` (grounded and centred), before `scale`. */
  localBox: Box3;
}

/**
 * A GLB mini instance: a SkeletonUtils clone (geometry and materials shared with every other token using the same
 * asset, AC-TOK-10), normalised at display time — grounded, centred on its base, facing +Z, scaled to the size
 * category's height — using the processor's bounds when present (AC-TOK-03).
 */
export function useMini(meta: AssetRender | null, size: Size): MiniInstance | null {
  const [inst, setInst] = useState<MiniInstance | null>(null);
  const id = meta && meta.cls === "model" ? meta.id : undefined;
  // Keyed by value: Library updates replace the object even when the bounds are unchanged.
  const boundsKey = meta?.glb?.bounds ? JSON.stringify(meta.glb.bounds) : "";
  useEffect(() => {
    if (!id) {
      setInst(null);
      return;
    }
    let cancelled = false;
    const h = acquireGlb(id);
    h.promise.then(
      (gltf) => {
        if (cancelled) return;
        const root = cloneSkinned(gltf.scene) as Group;
        root.traverse((o) => {
          const m = o as Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
            // Lit and fogged like the rest of the board (a mini in dim light looks dim, §15.7 step 4).
            for (const mat of Array.isArray(m.material) ? m.material : [m.material]) withFog(mat, "object");
          }
        });
        const b = boundsKey
          ? (JSON.parse(boundsKey) as { min: [number, number, number]; max: [number, number, number] })
          : null;
        const box = b
          ? new Box3(new Vector3(...b.min), new Vector3(...b.max))
          : new Box3().setFromObject(root);
        const height = Math.max(1e-3, box.max.y - box.min.y);
        const target = SIZE_MINI_HEIGHT_FT[size] ?? SIZE_MINI_HEIGHT_FT.medium;
        const scale = target / height;
        const centre = box.getCenter(new Vector3());
        const offset = new Vector3(-centre.x, -box.min.y, -centre.z);
        const localBox = box.clone().translate(offset);
        setInst({ root, gltf, scale, height: target, offset, localBox });
      },
      () => {},
    );
    return () => {
      cancelled = true;
      h.release();
      setInst(null);
    };
  }, [id, size, boundsKey]);
  return inst;
}

/**
 * A token's face: its image (a token-art asset), else its portrait, else its initials on its ring colour — what its
 * coin shows, used wherever the token is stood in for (a move's ghost).
 */
export function useTokenFace(token: TokenView | undefined, ring: string): Texture {
  const meta = useAssetMeta(token?.assetId || undefined);
  const portrait = useAssetMeta(token?.portraitAssetId || undefined);
  const faceMeta = meta?.cls === "image" ? meta : portrait?.cls === "image" ? portrait : null;
  const tex = useAssetTexture(faceMeta, 256);
  return tex ?? initialsTexture(token?.name ?? "?", ring);
}
