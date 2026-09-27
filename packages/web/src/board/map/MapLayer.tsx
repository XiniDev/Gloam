import type { SceneView } from "@gloam/shared/state";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { type Group, type Mesh, MeshBasicMaterial, type Texture } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { assetMeta, pickImageVariant } from "../../net/assets.ts";
import { C, col } from "../colors.ts";
import { boardDiag, useLoading } from "../diag.ts";
import { acquireGlb, acquireTexture } from "../resources.ts";
import { type Bounds, type Calibration, calibrationFromJson, sceneFloor } from "../scene.ts";
import { TIERS, useTier } from "../tiers.ts";
import { useMapAlign } from "./mapAlign.ts";
import { ProceduralFloor } from "./ProceduralFloor.tsx";

/** The map under the tokens (SPEC §24.1 MapLayer): image plane, GLB map, or procedural/blank floor. */
export function MapLayer({ scene, bounds }: { scene: SceneView; bounds: Bounds }) {
  const calibJson = scene.calibJson;
  const calib = useMemo(() => calibrationFromJson(calibJson), [calibJson]);
  const style = sceneFloor(scene);
  if (scene.mapKind === "image" && scene.mapAssetId)
    return <ImageMap assetId={scene.mapAssetId} calib={calib} bounds={bounds} />;
  if (scene.mapKind === "model" && scene.mapAssetId)
    return <GlbMap assetId={scene.mapAssetId} calib={calib} />;
  boardDiag.map = { kind: scene.mapKind || "blank", style };
  return <ProceduralFloor bounds={bounds} style={style} />;
}

/**
 * An image map at its calibrated size (1 unit = 1 ft; top-left at the origin), unlit so the art keeps its colours
 * (SPEC §24.3). It loads the largest server variant that fits both the device's MAX_TEXTURE_SIZE and the tier's
 * cap (AC-BRD-06), showing the image's dominant colour until then.
 */
function ImageMap({ assetId, calib, bounds }: { assetId: string; calib: Calibration; bounds: Bounds }) {
  const tier = useTier((s) => s.name);
  const maxTexture = useTier((s) => s.device?.maxTexture ?? 4096);
  const [tex, setTex] = useState<Texture | null>(null);
  const [dominant, setDominant] = useState<string | null>(null);
  const cap = Math.min(maxTexture, TIERS[tier].textureCap);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    const done = useLoading.getState().begin();
    void assetMeta(assetId).then((meta) => {
      if (cancelled || !meta) return done();
      if (meta.dominant) setDominant(meta.dominant);
      const v = pickImageVariant(meta, cap);
      if (!v) return done();
      boardDiag.map = { kind: "image", assetId, variant: v.name, width: v.width, height: v.height };
      const h = acquireTexture(assetId, v.name);
      release = h.release;
      h.promise
        .then((t) => {
          if (!cancelled) setTex(t);
        })
        .catch(() => {})
        .finally(done);
    });
    return () => {
      cancelled = true;
      done();
      release?.();
    };
  }, [assetId, cap]);

  const ftPerPx = calib.ftPerPx ?? 5 / 70;
  const w = (calib.imageW ?? bounds.maxX / ftPerPx) * ftPerPx;
  const h = (calib.imageH ?? bounds.maxY / ftPerPx) * ftPerPx;
  // The plane's size on the table, in feet (1 unit = 1 ft, AC-BRD-01), for the test hooks and perf overlay.
  useEffect(() => {
    if (tex && boardDiag.map?.assetId === assetId) Object.assign(boardDiag.map, { worldW: w, worldH: h });
  }, [tex, assetId, w, h]);
  const material = useMemo(() => new MeshBasicMaterial(), []);
  useEffect(() => {
    material.map = tex;
    if (tex) material.color.setScalar(1);
    else material.color.copy(col(dominant ?? C.ink900));
    material.needsUpdate = true;
  }, [tex, dominant, material]);
  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[w / 2, 0, h / 2]}
      material={material}
      userData={{ map: "image" }}
    >
      <planeGeometry args={[w, h, 1, 1]} />
    </mesh>
  );
}

/** A GLB map placed by its calibration transform (move / rotate about Y / uniform scale; SPEC §8.3). */
function GlbMap({ assetId, calib }: { assetId: string; calib: Calibration }) {
  const [root, setRoot] = useState<Group | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let cancelled = false;
    const done = useLoading.getState().begin();
    const h = acquireGlb(assetId);
    h.promise
      .then((g) => {
        if (cancelled) return;
        const copy = cloneSkinned(g.scene) as Group;
        copy.traverse((o) => {
          const m = o as Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
        copy.name = "glb-map";
        setRoot(copy);
        boardDiag.map = { kind: "model", assetId };
        invalidate();
      })
      .catch(() => {})
      .finally(done);
    return () => {
      cancelled = true;
      done();
      h.release();
    };
  }, [assetId, invalidate]);
  // The alignment gizmo and Generate walls work on this object (SPEC §8.3 3D maps).
  useEffect(() => {
    if (!root) return;
    useMapAlign.getState().set({ object: root });
    return () => {
      if (useMapAlign.getState().object === root) useMapAlign.getState().set({ object: null, live: null });
    };
  }, [root]);
  const p = calib.position ?? { x: 0, y: 0, z: 0 };
  if (!root) return null;
  return (
    <primitive
      object={root}
      position={[p.x, p.y, p.z]}
      rotation-y={((calib.rotationYDeg ?? 0) * Math.PI) / 180}
      scale={calib.scale ?? 1}
    />
  );
}
