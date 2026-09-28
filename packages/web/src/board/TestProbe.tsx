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
import { cameraRig, rigDiag } from "./CameraRig.tsx";
import { boardDiag, useLoading } from "./diag.ts";
import { setAnimating, wake } from "./frames.ts";
import { cutaway, doorLeafAngles, doorSwing } from "./map/Walls3D.tsx";
import { animatingTokens } from "./move/anims.ts";
import { moveDiag, useMove } from "./move/drag.ts";
import { remoteLog, useRemoteMoves } from "./move/remote.ts";
import { usePings } from "./PingLayer.tsx";
import { editPerf } from "./perf.ts";
import { resourceStats } from "./resources.ts";
import { TIERS, TierGovernor, useTier } from "./tiers.ts";
import { overlayDiagnostics } from "./tokens/declutter.ts";
import { createHpBarMaterial, setHpBar } from "./tokens/hpBar.ts";
import { hpBarState, overlayFade } from "./tokens/TokenObject.tsx";
import { current as currentMeasure, measuredFt, useMeasure } from "./tools/measure.ts";
import { useWallTool } from "./tools/walls.ts";
import { useZoneTool } from "./tools/zones.ts";

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
        // The camera that draws and picks (its world matrix) is where the controls are now — not a frame behind.
        const now = c.getPosition(new Vector3(), false);
        const drawn = new Vector3().setFromMatrixPosition(c.camera.matrixWorld);
        return {
          inSync: drawn.distanceTo(now) < 1e-3,
          target: [t.x, t.y, t.z],
          position: [p.x, p.y, p.z],
          pitchDeg: cameraRig.pitchDeg(),
          azimuthDeg: (c.azimuthAngle * 180) / Math.PI,
          distance: c.distance,
          ortho: (c.camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true,
          zoom: (c.camera as { zoom?: number }).zoom ?? 1,
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
    provideTestHook("cameraLog", () => ({
      log: boardDiag.cameraLog,
      tweenStarts: boardDiag.tweenStarts,
      rig: rigDiag,
    }));
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
        /** The scene the camera rig has set the view up for (its framing runs an effect after the scene shows). */
        framed: cameraRig.framedScene,
      };
    });
    provideTestHook("scene", () => boardData(useEntities.getState()).scene);
    // Every overlay: its layout verdict, plate rectangle and fade, and the screen rectangle of its token's visible
    // parts (base, coin, standee or mini) — so journeys can check where plates sit relative to their tokens.
    provideTestHook("overlays", () => {
      const cam = boardApi.camera;
      const el = boardApi.element;
      const w = el?.clientWidth ?? 0;
      const h = el?.clientHeight ?? 0;
      const tokenRect = (id: string) => {
        const body = scene.getObjectByName(`token:${id}`)?.children[0];
        if (!body || !cam) return null;
        // Each visible part's own box corners through its transform (a world-aligned box would inflate turned or
        // tipped parts), projected.
        const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        const c = new Vector3();
        body.updateWorldMatrix(true, true);
        body.traverseVisible((o) => {
          const m = o as Mesh;
          if (!m.isMesh || !m.geometry) return;
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox as Box3;
          for (let i = 0; i < 8; i++) {
            c.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
            c.applyMatrix4(m.matrixWorld).project(cam);
            const sx = ((c.x + 1) / 2) * w;
            const sy = ((1 - c.y) / 2) * h;
            r.x0 = Math.min(r.x0, sx);
            r.y0 = Math.min(r.y0, sy);
            r.x1 = Math.max(r.x1, sx);
            r.y1 = Math.max(r.y1, sy);
          }
        });
        return Number.isFinite(r.x0) ? r : null;
      };
      return overlayDiagnostics().map((o) => ({ ...o, fade: overlayFade.get(o.id), token: tokenRect(o.id) }));
    });
    provideTestHook("ui", () => {
      const u = useUi.getState();
      return { selection: u.selection, hover: u.hover, tool: u.tool, radial: u.radial };
    });
    provideTestHook("walls", () => [...boardData(useEntities.getState()).walls.values()]);
    provideTestHook("wall", (id: string) => boardData(useEntities.getState()).walls.get(id) ?? null);
    provideTestHook("zones", () => [...boardData(useEntities.getState()).zones.values()]);
    /** AC-WAL-02: the Walls tool as it stands (mode, chain, snap, selection, the edit being previewed). */
    provideTestHook("wallTool", () => {
      const w = useWallTool.getState();
      return {
        mode: w.mode,
        chain: w.chain,
        pointer: w.pointer,
        snap: w.snap,
        rect: w.rect,
        selected: w.selected,
        hover: w.hover,
        handle: w.handle,
        preview: w.preview ? [...w.preview.entries()] : null,
        ghosts: w.ghosts.length,
      };
    });
    /**
     * The walls overlay: segments in its buffers, and how many the renderer will draw (three.js fixes an instanced
     * geometry's count at its first draw — the overlay must never draw fewer than it holds).
     */
    provideTestHook("wallsOverlay", () => {
      const o = scene.getObjectByName("walls-overlay") as
        | { geometry: { getAttribute(n: string): { count: number } | undefined; _maxInstanceCount?: number } }
        | undefined;
      if (!o) return null;
      return {
        segments: o.geometry.getAttribute("instanceStart")?.count ?? 0,
        drawn: o.geometry._maxInstanceCount ?? null,
      };
    });
    /** AC-WAL-06: the 3D walls on this viewer's board — instance counts, door leaves and their angles. */
    provideTestHook("walls3d", () => {
      const g = scene.getObjectByName("walls3d");
      if (!g) return null;
      const count = (name: string) =>
        (g.getObjectByName(name) as unknown as { count?: number } | undefined)?.count ?? 0;
      const names = (name: string) => {
        let n = 0;
        g.traverse((o) => {
          if (o.name === name) n++;
        });
        return n;
      };
      const stone = g.getObjectByName("walls3d-stone") as unknown as
        | { material: { customProgramCacheKey?: () => string } }
        | undefined;
      return {
        stone: count("walls3d-stone"),
        ghost: count("walls3d-ghost"),
        stoneMaterial: stone?.material.customProgramCacheKey?.() ?? null,
        glass: names("window-glass"),
        curtains: names("curtain"),
        fields: names("force-field"),
        doors: doorLeafAngles(),
        cut: cutaway.uCutOn.value === 1,
      };
    });
    /** AC-WAL-06: a door leaf's latest swing and its angle at given times after it began. */
    provideTestHook("doorSwing", (id: string, ms: number[]) => doorSwing(id, ms));
    /** AC-WAL-05: the Zones tool as it stands. */
    provideTestHook("zoneTool", () => {
      const z = useZoneTool.getState();
      return { mode: z.mode, points: z.points, draft: z.draft, selected: z.selected, preview: z.preview };
    });
    /** The Walls tool in a few numbers (cheap to poll while a trace measures the page). */
    provideTestHook("wallToolSummary", () => {
      const w = useWallTool.getState();
      return { mode: w.mode, selected: w.selected.length, preview: w.preview ? w.preview.size : null };
    });
    /** AC-WAL-07: main-thread editing work per frame (ms) — switch on, reset, read. */
    provideTestHook("editPerf", (cmd: "on" | "off" | "read" | "parts") => {
      if (cmd === "on") {
        editPerf.on = true;
        editPerf.frames = [];
        editPerf.parts = [];
        editPerf.pending = 0;
      } else if (cmd === "off") editPerf.on = false;
      if (cmd === "parts") return editPerf.parts.map((x) => [...x]);
      return [...editPerf.frames];
    });
    /** AC-WAL-03/04: the door handles drawn on this viewer's board. */
    provideTestHook("doorHandles", () => {
      const out: { wallId: string; doorState: string }[] = [];
      scene.traverse((o) => {
        if (o.userData.part === "doorHandle")
          out.push({ wallId: o.userData.wallId as string, doorState: o.userData.doorState as string });
      });
      return out;
    });
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
    // Movement (P3): the viewer's planned move, others' drags, and tokens gliding along committed paths.
    provideTestHook("move", () => {
      const m = useMove.getState();
      return {
        tokenId: m.tokenId,
        dragging: m.dragging,
        mode: m.mode,
        waypoints: m.waypoints,
        preview: m.preview,
        sending: m.sending,
      };
    });
    provideTestHook("remoteMoves", () =>
      [...useRemoteMoves.getState().byToken].map(([id, r]) => ({
        tokenId: id,
        points: r.points,
        cost: r.cost,
        by: r.by,
      })),
    );
    provideTestHook("moveAnims", () => animatingTokens());
    provideTestHook("moveDiag", () => ({ ...moveDiag }));
    provideTestHook("measure", () => {
      const m = useMeasure.getState();
      const c = currentMeasure();
      return {
        points: m.points,
        done: m.done,
        shape: c?.shape ?? null,
        ft: c ? measuredFt(c) : null,
        shared: m.shared.map((x) => ({ shape: x.shape, by: x.by, name: x.name, ft: measuredFt(x) })),
      };
    });
    provideTestHook("pings", () =>
      usePings
        .getState()
        .pings.map((p) => ({ x: p.x, y: p.y, color: p.color, spotlight: p.spotlight, by: p.by })),
    );
    provideTestHook("remoteMoveLog", () => [...remoteLog]);
    /** Keeps the board drawing for `ms` (a burst of ordinary redraws, as camera or store changes cause). */
    provideTestHook("redraw", (ms: number) => {
      const before = boardApi.frames;
      wake(ms);
      return before;
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
