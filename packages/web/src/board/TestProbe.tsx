import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Vector3 } from "three";
import { boardData, useEntities } from "../state/entities.ts";
import { provideTestHook } from "../test/hooks.ts";
import { boardApi } from "./boardApi.ts";
import { cameraRig } from "./CameraRig.tsx";
import { boardDiag, useLoading } from "./diag.ts";
import { setAnimating, wake } from "./frames.ts";
import { resourceStats } from "./resources.ts";
import { TIERS, TierGovernor, useTier } from "./tiers.ts";
import { hpBarState } from "./tokens/TokenObject.tsx";

/**
 * Test hooks for the board (SPEC §23.7; present only in `vite build --mode test`): camera read/write, renderer and
 * tier stats, visible tokens and each token's render state.
 */
export function TestProbe() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  // The camera at every rendered frame (after the controls and the rig's tweens have run), for timing journeys.
  const v = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const c = cameraRig.controls;
    if (!c) return;
    c.getTarget(v);
    boardDiag.cameraLog.push({
      t: performance.now(),
      tx: v.x,
      tz: v.z,
      pitch: cameraRig.pitchDeg(),
      dist: c.distance,
    });
    if (boardDiag.cameraLog.length > 600) boardDiag.cameraLog.splice(0, 100);
  });
  useEffect(() => {
    if (!__GLOAM_TEST__) return;
    provideTestHook(
      "camera",
      (set?: { pitchDeg?: number; distance?: number; target?: [number, number]; ms?: number }) => {
        const c = cameraRig.controls;
        if (!c) return null;
        if (set) {
          if (set.target) cameraRig.moveTargetTo(set.target[0], set.target[1], set.ms ?? 0);
          if (set.pitchDeg !== undefined) cameraRig.pitchTo(set.pitchDeg, set.ms ?? 0);
          if (set.distance !== undefined) void c.dollyTo(set.distance, false);
          wake();
        }
        const t = c.getTarget(new Vector3());
        const p = c.getPosition(new Vector3());
        return {
          target: [t.x, t.y, t.z],
          position: [p.x, p.y, p.z],
          pitchDeg: cameraRig.pitchDeg(),
          azimuthDeg: (c.azimuthAngle * 180) / Math.PI,
          distance: c.distance,
        };
      },
    );
    provideTestHook("stats", () => {
      const tier = useTier.getState();
      return {
        tier: tier.name,
        pinned: tier.pinned,
        reason: tier.reason,
        fps: tier.fps,
        device: tier.device,
        spec: TIERS[tier.name],
        dpr: gl.getPixelRatio(),
        shadows: gl.shadowMap.enabled,
        postfx: boardDiag.postfx,
        map: boardDiag.map,
        memory: { ...gl.info.memory },
        /** Frames rendered so far (on-demand rendering: an idle board stops counting). */
        frames: gl.info.render.frame,
        programs: gl.info.programs?.length ?? 0,
        resources: resourceStats(),
        firstFrameAt: boardDiag.firstFrameAt,
      };
    });
    provideTestHook("cameraLog", () => ({ log: boardDiag.cameraLog, tweenStarts: boardDiag.tweenStarts }));
    provideTestHook("groundAt", (x: number, y: number) => boardApi.groundAt(x, y));
    provideTestHook("project", (x: number, y: number, elevation?: number) =>
      boardApi.project(x, y, elevation ?? 0),
    );
    provideTestHook("boardScene", () => {
      const e = useEntities.getState();
      return {
        shown: boardData(e).scene?.id ?? null,
        live: e.live.scene?.id ?? null,
        prep: e.prep?.scene?.id ?? null,
        travelling: e.travel !== null,
        loading: useLoading.getState().pending,
      };
    });
    provideTestHook("visibleTokenIds", () => [...boardData(useEntities.getState()).tokens.keys()].sort());
    provideTestHook("tokenState", (id: string) => {
      const obj = scene.getObjectByName(`token:${id}`);
      if (!obj) return null;
      const parts: Record<string, { diameter?: number; visible: boolean }> = {};
      obj.traverse((o) => {
        const part = o.userData.part as string | undefined;
        if (part) parts[part] = { diameter: o.userData.diameter as number | undefined, visible: o.visible };
      });
      return { modes: boardDiag.tokenModes.get(id) ?? null, hp: hpBarState.get(id) ?? null, parts };
    });
    provideTestHook("forceFrameMs", (ms: number | null) => {
      TierGovernor.forcedMs = ms;
      // The governor measures rendered frames; while a test forces frame times, keep them coming.
      setAnimating("test:forceFrameMs", ms !== null);
    });
    /** AC-TOK-10: the minis on the table and how many distinct geometries/materials they use. */
    provideTestHook("miniStats", () => {
      const geometries = new Set<string>();
      const materials = new Set<string>();
      let instances = 0;
      scene.traverse((o) => {
        if (o.userData.part !== "mini") return;
        instances++;
        o.traverse((m) => {
          const mesh = m as unknown as {
            isMesh?: boolean;
            geometry?: { uuid: string };
            material?: { uuid: string } | { uuid: string }[];
          };
          if (!mesh.isMesh) return;
          if (mesh.geometry) geometries.add(mesh.geometry.uuid);
          for (const mat of Array.isArray(mesh.material)
            ? mesh.material
            : mesh.material
              ? [mesh.material]
              : [])
            materials.add(mat.uuid);
        });
      });
      return {
        instances,
        geometries: geometries.size,
        materials: materials.size,
        rendererGeometries: gl.info.memory.geometries,
      };
    });
  }, [gl, scene]);
  return null;
}
