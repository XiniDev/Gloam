import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  Box3,
  Color,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from "three";
import { diceEnvironment } from "../dice/materials.ts";
import { boardData, useEntities } from "../state/entities.ts";
import { useFog } from "../state/fog.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { useViewAs } from "../state/viewAs.ts";
import { provideTestHook } from "../test/hooks.ts";
import { boardApi } from "./boardApi.ts";
import { cameraRig, rigDiag } from "./CameraRig.tsx";
import { boardDiag, useLoading } from "./diag.ts";
import { again, setAnimating, wake } from "./frames.ts";
import { useGpu } from "./gpu.ts";
import { cutaway, doorLeafAngles, doorSwing } from "./map/Walls3D.tsx";
import { animatingTokens, movedLog } from "./move/anims.ts";
import { moveDiag, useMove } from "./move/drag.ts";
import { remoteLog, useRemoteMoves } from "./move/remote.ts";
import { pingsSeen, usePings } from "./PingLayer.tsx";
import { editPerf } from "./perf.ts";
import { onProgramCompiled } from "./programs.ts";
import { resourceStats } from "./resources.ts";
import { TIERS, TierGovernor, useTier } from "./tiers.ts";
import { overlayDiagnostics, plateCovers, setOverlaysOff } from "./tokens/declutter.ts";
import { createHpBarMaterial, setHpBar } from "./tokens/hpBar.ts";
import { fxPlayed, lieOf } from "./tokens/hpFx.tsx";
import { statusAtlas } from "./tokens/statusAtlas.ts";
import { hpBarState, overlayFade } from "./tokens/TokenObject.tsx";
import { current as currentMeasure, measuredFt, useMeasure } from "./tools/measure.ts";
import { useWallTool } from "./tools/walls.ts";
import { useZoneTool } from "./tools/zones.ts";
import { fogUniforms } from "./vision/fogMaterial.ts";
import { visionDiag } from "./vision/VisionLayer.tsx";

/** Tokens whose body's sideways offset is watched, frame by frame, and the largest seen (the `sway` hook). */
const swayWatch = new Map<string, { max: number }>();
/** Frame timestamps while the benchmark records (the `frameTimes` hook). */
const frameLog: number[] & { recording?: boolean } = [];
/** Every shader program the board compiled, when, and which materials used it then (the `programs` hook). */
const compileLog: { name: string; key: string; at: number; origin: string; materials: string[] }[] = [];

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
    if (frameLog.recording) frameLog.push(performance.now());
    for (const [id, w] of swayWatch) {
      const x = scene.getObjectByName(`token:${id}`)?.getObjectByName("token-body")?.position.x ?? 0;
      w.max = Math.max(w.max, Math.abs(x));
    }
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
    return onProgramCompiled(({ program, at, origin }) => {
      const materials = new Set<string>();
      scene.traverse((o) => {
        const ms = (o as Mesh).material;
        for (const m of Array.isArray(ms) ? ms : ms ? [ms] : []) {
          const used = (gl.properties.get(m) as { currentProgram?: unknown }).currentProgram;
          if (used !== program) continue;
          // The object and its named ancestors: which layer drew it.
          const path: string[] = [];
          for (let a: Object3D | null = o; a && path.length < 4; a = a.parent) {
            const label =
              a.name || (a.userData?.part as string | undefined) || (a.userData?.map as string | undefined);
            if (label) path.push(label);
          }
          if (!path.length) path.push(`${o.parent?.type ?? "no parent"} > ${o.parent?.parent?.type ?? "-"}`);
          materials.add(`${m.name || m.type} on ${o.type}${path.length ? ` (${path.join(" < ")})` : ""}`);
        }
      });
      compileLog.push({
        name: program.name,
        key: program.cacheKey,
        at,
        origin,
        materials: [...materials],
      });
    });
  }, [gl, scene]);
  useEffect(() => {
    if (!__GLOAM_TEST__) return;
    /** The shader programs compiled so far, each with when it was and what used it (AC-PERF-05). */
    provideTestHook("programs", () => compileLog.map((c) => ({ ...c })));
    provideTestHook(
      "camera",
      (set?: {
        pitchDeg?: number;
        distance?: number;
        target?: [number, number];
        ms?: number;
        /** Frame this area (feet) in the HUD's clear part of the screen, at `pitchDeg`. */
        frame?: { minX: number; minY: number; maxX: number; maxY: number };
      }) => {
        const c = cameraRig.controls;
        if (!c) return null;
        if (set?.frame) {
          cameraRig.frame(set.frame, set.pitchDeg);
          wake();
        } else if (set) {
          if (set.target) cameraRig.moveTargetTo(set.target[0], set.target[1], set.ms ?? 0);
          if (set.pitchDeg !== undefined) cameraRig.pitchTo(set.pitchDeg, set.ms ?? 0);
          if (set.distance !== undefined) void c.dollyTo(set.distance, false);
          // Set outright: in place now (what's projected next goes through this view).
          if ((set.ms ?? 0) <= 0) cameraRig.sync();
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
    // Fog this client holds (SPEC §15.8): the mode, the raster's placement, and how much is revealed/explored.
    provideTestHook("fog", () => {
      const f = useFog.getState();
      const count = (a: Uint8Array | null | undefined) => (a ? a.reduce((n, v) => n + (v ? 1 : 0), 0) : 0);
      return {
        sceneId: f.sceneId,
        mode: f.mode,
        shape: f.shape,
        explored: count(f.explored),
        layers: Object.fromEntries([...f.layers].map(([k, v]) => [k, count(v)])),
      };
    });
    // Lights this client holds (SPEC §8.8).
    provideTestHook("lights", () => [...boardData(useEntities.getState()).lights.values()]);
    // Tremorsense markers this client holds (SPEC §15.4): opaque ids and rounded positions only.
    provideTestHook("sensed", () => [...useEntities.getState().live.sensed.values()]);
    // Moves as this client received them (SPEC §15.6).
    provideTestHook("movedLog", () => movedLog.map((m) => ({ ...m })));
    // The board's pixels as WebGL drew them (no HUD over them): a PNG data URL.
    provideTestHook("canvasPng", () => {
      const el = boardApi.element;
      const c = el instanceof HTMLCanvasElement ? el : el?.querySelector("canvas");
      return c
        ? { url: c.toDataURL("image/png"), width: c.width, height: c.height, cssWidth: c.clientWidth }
        : null;
    });
    // The mean colour of a small square of the board around a window point (read in the page: no PNG round trip).
    provideTestHook("canvasRegion", (x: number, y: number, half: number) => {
      const el = boardApi.element;
      const c = el instanceof HTMLCanvasElement ? el : el?.querySelector("canvas");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const k = c.width / c.clientWidth;
      const size = Math.max(1, Math.round(half * 2 + 1));
      const cx = Math.round((x - r.left) * k) - Math.floor(size / 2);
      const cy = Math.round((y - r.top) * k) - Math.floor(size / 2);
      const off = document.createElement("canvas");
      off.width = size;
      off.height = size;
      const g = off.getContext("2d", { willReadFrequently: true });
      if (!g) return null;
      g.drawImage(c, cx, cy, size, size, 0, 0, size, size);
      const d = g.getImageData(0, 0, size, size).data;
      let R = 0;
      let G = 0;
      let B = 0;
      for (let i = 0; i < d.length; i += 4) {
        R += d[i] as number;
        G += d[i + 1] as number;
        B += d[i + 2] as number;
      }
      const n = d.length / 4;
      return { r: R / n / 255, g: G / n / 255, b: B / n / 255 };
    });
    // The board's WebGL context (SPEC §40): its state, and losing and restoring it as a phone or a driver reset would.
    provideTestHook("gpu", () => ({ ...useGpu.getState(), contextLost: gl.getContext().isContextLost() }));
    provideTestHook("loseContext", () => gl.forceContextLoss());
    provideTestHook("restoreContext", () => gl.forceContextRestore());
    /**
     * What an environment map gives: a metal ball lit by it alone (no lights), drawn into a small target and averaged
     * (0–255 per channel) — black if the map is blank. "board": the scene's room; "dice": the dice's.
     */
    provideTestHook("envLight", (which: "board" | "dice") => {
      const env = which === "board" ? scene.environment : diceEnvironment(gl);
      if (!env) return null;
      const probe = new Scene();
      const geo = new SphereGeometry(1, 24, 16);
      const mat = new MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.35, envMap: env });
      probe.add(new Mesh(geo, mat));
      const cam = new PerspectiveCamera(30, 1, 0.1, 10);
      cam.position.set(0, 0, 4);
      cam.lookAt(0, 0, 0);
      const N = 16;
      const rt = new WebGLRenderTarget(N, N);
      const prev = gl.getRenderTarget();
      gl.setRenderTarget(rt);
      gl.clear();
      gl.render(probe, cam);
      const buf = new Uint8Array(N * N * 4);
      gl.readRenderTargetPixels(rt, 0, 0, N, N, buf);
      gl.setRenderTarget(prev);
      rt.dispose();
      geo.dispose();
      mat.dispose();
      const sum = [0, 0, 0];
      for (let i = 0; i < N * N; i++)
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + (buf[i * 4 + c] as number);
      return sum.map((v) => Math.round(v / (N * N)));
    });
    // The composite's inputs (SPEC §15.7).
    provideTestHook("vision", () => ({
      draws: visionDiag.draws,
      lastDrawAt: visionDiag.lastDrawAt,
      lightDraws: visionDiag.lightDraws,
      wallsAt: visionDiag.wallsAt,
      wallsDrawnAt: visionDiag.wallsDrawnAt,
      computedAt: visionDiag.computedAt,
      flicker: { ...visionDiag.flicker },
      reveal: { ...visionDiag.reveal, steps: [...visionDiag.reveal.steps] },
      mode: fogUniforms.gMode.value,
      dm: fogUniforms.gDm.value,
      ambient: fogUniforms.gAmbient.value,
      blend: fogUniforms.gBlend.value,
      hasVision: fogUniforms.gVis.value !== null,
      hasLight: fogUniforms.gLight.value !== null,
      hasMemory: fogUniforms.gMem.value !== null,
    }));
    provideTestHook("project", (x: number, y: number, elevation?: number) =>
      boardApi.project(x, y, elevation ?? 0),
    );
    // What a press at a screen point would hit, nearest first (its object's type, name and what it belongs to).
    provideTestHook("pickAt", (sx: number, sy: number) => {
      const cam = cameraRig.controls?.camera;
      if (!cam) return [];
      const r = gl.domElement.getBoundingClientRect();
      const ray = new Raycaster();
      ray.setFromCamera(
        new Vector2(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1),
        cam,
      );
      return ray
        .intersectObjects(scene.children, true)
        .slice(0, 12)
        .map((h) => {
          let owner = "";
          for (let o: Object3D | null = h.object; o && !owner; o = o.parent)
            owner = o.name || (o.userData.effectHandle ? `handle:${o.userData.effectHandle}` : "");
          return {
            type: h.object.type,
            name: h.object.name,
            owner,
            distance: Math.round(h.distance * 10) / 10,
          };
        });
    });
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
      // Whether its leader line is drawn (a plate moved aside points back to its token).
      const leader = (id: string) =>
        scene.getObjectByName(`token:${id}`)?.getObjectByName("plateLeader")?.visible === true;
      return overlayDiagnostics().map((o) => ({
        ...o,
        fade: overlayFade.get(o.id),
        token: tokenRect(o.id),
        leader: leader(o.id),
      }));
    });
    provideTestHook("plateCovers", () => plateCovers());
    // The brightest pixel of the board within r px of a screen point (luminance 0–255), read from the drawing buffer
    // (kept in test builds) — no screenshot, so no waiting on a compositor frame.
    // The board's mean colour within r px of a screen point ([r, g, b] 0–255), from its drawing buffer.
    // Every plate off: the tokens' own geometry measured apart from whatever the plates' layout shows (AC-TOK-10).
    provideTestHook("overlaysOff", (on: boolean) => {
      setOverlaysOff(on);
      again();
      return true;
    });
    // This device's settings, changed as the Settings popover would (the colour-blind palette in the shots).
    provideTestHook("settings", (patch: Record<string, unknown>) => {
      useSettings.getState().update(patch as never);
      return true;
    });
    provideTestHook("boardRgb", (sx: number, sy: number, radius?: number) => {
      const r = radius ?? 1;
      const el = gl.domElement;
      const rect = el.getBoundingClientRect();
      const dpr = gl.getPixelRatio();
      const ctx = gl.getContext();
      const size = Math.max(1, Math.round((2 * r + 1) * dpr));
      const x = Math.round((sx - rect.left - r) * dpr);
      const y = Math.round(el.height - (sy - rect.top + r + 1) * dpr);
      const buf = new Uint8Array(size * size * 4);
      ctx.readPixels(x, y, size, size, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      const sum = [0, 0, 0];
      for (let i = 0; i < size * size; i++)
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + (buf[i * 4 + c] as number);
      return sum.map((v) => Math.round(v / (size * size)));
    });
    provideTestHook("boardPixels", (sx: number, sy: number, radius?: number) => {
      const r = radius ?? 4;
      const el = gl.domElement;
      const rect = el.getBoundingClientRect();
      const dpr = gl.getPixelRatio();
      const ctx = gl.getContext();
      const size = Math.round((2 * r + 1) * dpr);
      const x = Math.round((sx - rect.left - r) * dpr);
      const y = Math.round(el.height - (sy - rect.top + r + 1) * dpr);
      const buf = new Uint8Array(size * size * 4);
      ctx.readPixels(x, y, size, size, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      let best = 0;
      for (let i = 0; i < size * size; i++) {
        const l =
          0.2126 * (buf[i * 4] as number) +
          0.7152 * (buf[i * 4 + 1] as number) +
          0.0722 * (buf[i * 4 + 2] as number);
        if (l > best) best = l;
      }
      return best;
    });
    // The HP feedback each token played (AC-HP-11: a hit's shake and flash, a heal's glow).
    provideTestHook("fxPlayed", () => fxPlayed.map((f) => ({ ...f })));
    // Every mesh of a token as the renderer has it (diagnostics: a part that doesn't draw).
    provideTestHook("tokenMeshes", (id: string) => {
      const obj = scene.getObjectByName(`token:${id}`);
      if (!obj) return null;
      obj.updateWorldMatrix(true, true);
      const out: Record<string, unknown>[] = [];
      obj.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        const mat = m.material as MeshStandardMaterial;
        let shown = m.visible;
        for (let p = m.parent; p && shown; p = p.parent) shown = p.visible;
        const b = new Box3().setFromObject(m);
        out.push({
          part: m.userData.part ?? null,
          color: mat.color ? `#${mat.color.getHexString()}` : null,
          shown,
          transparent: mat.transparent,
          opacity: mat.opacity,
          alphaTest: mat.alphaTest,
          alphaMap: Boolean(mat.alphaMap),
          map: Boolean(mat.map),
          verts: m.geometry.getAttribute("position")?.count ?? 0,
          min: b.min.toArray().map((v) => Math.round(v * 100) / 100),
          max: b.max.toArray().map((v) => Math.round(v * 100) / 100),
        });
      });
      return out;
    });
    // The atlas cells made for custom markers ("glyph|#colour"), each with the badge colour its cell's centre shows.
    provideTestHook("customCells", () => {
      const a = statusAtlas();
      const g = a.canvas.getContext("2d") as CanvasRenderingContext2D;
      return [...a.custom].map(([key, { cell }]) => {
        const x = Math.round(cell.u0 * a.canvas.width) + 6;
        const y = Math.round((1 - cell.v1) * a.canvas.height) + 6;
        const [r, gr, b] = g.getImageData(x, y, 1, 1).data;
        const hex = (n = 0) => n.toString(16).padStart(2, "0");
        return { key, badge: `#${hex(r)}${hex(gr)}${hex(b)}` };
      });
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
      // Instances across every mesh of that name (the stone is one instanced mesh per division count).
      const count = (name: string) => {
        let n = 0;
        g.traverse((o) => {
          if (o.name === name) n += (o as unknown as { count?: number }).count ?? 0;
        });
        return n;
      };
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
        pillars: names("walls3d-pillar"),
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
    // The lasting effects this viewer has, as the board has them.
    provideTestHook("effects", () => [...boardData(useEntities.getState()).effects.values()]);
    provideTestHook("tokens", () => [...boardData(useEntities.getState()).tokens.values()]);
    // The tokens drawn (viewing as a player: exactly theirs).
    provideTestHook("visibleTokenIds", () => {
      const as = useViewAs.getState();
      const ids = [...boardData(useEntities.getState()).tokens.keys()];
      return (as.userId && as.data ? ids.filter((id) => as.data?.tokens.includes(id)) : ids).sort();
    });
    provideTestHook("tokenState", (id: string) => {
      const obj = scene.getObjectByName(`token:${id}`);
      if (!obj) return null;
      obj.updateWorldMatrix(true, true);
      const parts: Record<
        string,
        {
          diameter?: number;
          visible: boolean;
          bounds?: { min: number[]; max: number[] };
          pin?: { label: string; value: number; max: number };
          status?: string;
        }
      > = {};
      let ring: string | null = null;
      let opacity: number | null = null;
      obj.traverse((o) => {
        const part = o.userData.part as string | undefined;
        if (part) {
          let visible = o.visible;
          for (let p = o.parent; p && visible; p = p.parent) visible = p.visible;
          parts[part] = { diameter: o.userData.diameter as number | undefined, visible };
          if (o.userData.pin)
            parts[part].pin = o.userData.pin as { label: string; value: number; max: number };
          if (o.userData.status) parts[part].status = o.userData.status as string;
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
        // Its body's sideways offset from where it stands (a hit's shake moves it: AC-A11Y-02).
        bodyX: obj.getObjectByName("token-body")?.position.x ?? 0,
        // How far it has fallen (0 standing … 1 lying: prone, unconscious or dead — AC-HP-11's fall).
        lie: lieOf.get(id) ?? 0,
      };
    });
    /**
     * The largest sideways offset a token's body reaches in the frames drawn over the next `ms` (a hit's shake,
     * AC-A11Y-02) — read in every frame, not polled, so a slow machine's few frames are all counted.
     */
    provideTestHook("sway", async (id: string, ms: number) => {
      const w = { max: 0 };
      swayWatch.set(id, w);
      setAnimating("test:sway", true);
      await new Promise((r) => setTimeout(r, ms));
      setAnimating("test:sway", false);
      swayWatch.delete(id);
      return w.max;
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
    // Every ping shown here since the page loaded, as each arrived (PingLayer.tsx).
    provideTestHook("pingsSeen", () =>
      pingsSeen.map((p) => ({ x: p.x, y: p.y, color: p.color, spotlight: p.spotlight, by: p.by })),
    );
    provideTestHook("pings", () =>
      usePings
        .getState()
        .pings.map((p) => ({ x: p.x, y: p.y, color: p.color, spotlight: p.spotlight, by: p.by })),
    );
    provideTestHook("remoteMoveLog", () => [...remoteLog]);
    /** Frames the board has drawn so far (how often lasting animation redraws it). */
    provideTestHook("frameCount", () => boardApi.frames);
    /**
     * The board's frames, timed (the benchmark, SPEC §37): `true` starts a recording (and keeps the board drawing),
     * `false` stops it and returns each frame's interval and the longest main-thread stall between frames (ms).
     */
    provideTestHook("frameTimes", (on: boolean) => {
      if (on) {
        frameLog.length = 0;
        frameLog.recording = true;
        setAnimating("test:frameTimes", true);
        return true;
      }
      frameLog.recording = false;
      setAnimating("test:frameTimes", false);
      const deltas: number[] = [];
      for (let i = 1; i < frameLog.length; i++)
        deltas.push((frameLog[i] as number) - (frameLog[i - 1] as number));
      return deltas;
    });
    /** The quality tier in use and its particle share (§24.6). */
    provideTestHook("tier", () => {
      const name = useTier.getState().name;
      return { name, particles: TIERS[name].particles };
    });
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
