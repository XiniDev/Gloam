import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  Box3,
  Color,
  Mesh,
  type MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
} from "three";
import { boardData, useEntities } from "../state/entities.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { provideTestHook } from "../test/hooks.ts";
import { boardApi } from "./boardApi.ts";
import { cameraRig } from "./CameraRig.tsx";
import { boardDiag, useLoading } from "./diag.ts";
import { setAnimating, wake } from "./frames.ts";
import { resourceStats } from "./resources.ts";
import { TIERS, TierGovernor, useTier } from "./tiers.ts";
import { createHpBarMaterial, setHpBar } from "./tokens/hpBar.ts";
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
        map: boardDiag.map && {
          ...boardDiag.map,
          ...(boardDiag.mapWorld ? { worldW: boardDiag.mapWorld.w, worldH: boardDiag.mapWorld.h } : {}),
        },
        memory: { ...gl.info.memory },
        /** Frames rendered so far (on-demand rendering: an idle board stops counting). */
        frames: gl.info.render.frame,
        programs: gl.info.programs?.length ?? 0,
        resources: resourceStats(),
        firstFrameAt: boardDiag.firstFrameAt,
        dust: boardDiag.dust,
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
    provideTestHook("scene", () => boardData(useEntities.getState()).scene);
    provideTestHook("ui", () => {
      const u = useUi.getState();
      return { selection: u.selection, hover: u.hover, tool: u.tool, radial: u.radial };
    });
    provideTestHook("walls", () => [...boardData(useEntities.getState()).walls.values()]);
    /** The token as this viewer holds it (its view shape, tags included), or null. */
    provideTestHook("token", (id: string) => boardData(useEntities.getState()).tokens.get(id) ?? null);
    provideTestHook("visibleTokenIds", () => [...boardData(useEntities.getState()).tokens.keys()].sort());
    provideTestHook("tokenState", (id: string) => {
      const obj = scene.getObjectByName(`token:${id}`);
      if (!obj) return null;
      obj.updateWorldMatrix(true, true);
      const parts: Record<
        string,
        { diameter?: number; visible: boolean; bounds?: { min: number[]; max: number[] } }
      > = {};
      let ring: string | null = null;
      let opacity: number | null = null;
      obj.traverse((o) => {
        const part = o.userData.part as string | undefined;
        if (part) {
          let visible = o.visible;
          for (let p = o.parent; p && visible; p = p.parent) visible = p.visible;
          parts[part] = { diameter: o.userData.diameter as number | undefined, visible };
          if (part === "mini") {
            const b = new Box3().setFromObject(o);
            parts[part].bounds = { min: b.min.toArray(), max: b.max.toArray() };
          }
        }
        if (o.userData.rim && ring === null) {
          const m = (o as Mesh).material as MeshStandardMaterial;
          ring = `#${m.color.getHexString()}`;
          opacity = m.opacity;
        }
      });
      return {
        modes: boardDiag.tokenModes.get(id) ?? null,
        hp: hpBarState.get(id) ?? null,
        parts,
        ring,
        opacity,
        position: obj.position.toArray(),
      };
    });
    /** Renders the real HP bar shader into a strip and reads its middle row back (AC-TOK-05). */
    provideTestHook("renderHpBar", (v: { frac: number; temp: number; ghost: number }, w?: number) => {
      const width = w ?? 400;
      const mat = createHpBarMaterial();
      setHpBar(mat, { ...v, opacity: 1 }, useSettings.getState().colorBlind);
      const strip = new Scene();
      const geo = new PlaneGeometry(2, 1);
      strip.add(new Mesh(geo, mat));
      const cam = new OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 10);
      cam.position.z = 1;
      const rt = new WebGLRenderTarget(width, 10);
      rt.texture.colorSpace = SRGBColorSpace;
      const prev = gl.getRenderTarget();
      const clear = gl.getClearColor(new Color());
      const alpha = gl.getClearAlpha();
      gl.setRenderTarget(rt);
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(strip, cam);
      const buf = new Uint8Array(width * 4);
      gl.readRenderTargetPixels(rt, 0, 5, width, 1, buf);
      gl.setRenderTarget(prev);
      gl.setClearColor(clear, alpha);
      rt.dispose();
      geo.dispose();
      mat.dispose();
      return Array.from({ length: width }, (_, i) => [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]]);
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
