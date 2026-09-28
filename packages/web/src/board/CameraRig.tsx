import { CameraControls, OrthographicCamera } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import CameraControlsImpl from "camera-controls";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Box3, MathUtils, type OrthographicCamera as OrthoCam, Vector3 } from "three";
import { create } from "zustand";
import { useHudInsets } from "../hud/insets.ts";
import { tableEvents } from "../net/table.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { boardApi } from "./boardApi.ts";
import { boardDiag } from "./diag.ts";
import { again, wake } from "./frames.ts";
import { frameBounds } from "./framing.ts";
import { type Bounds, boundsSize } from "./scene.ts";

const { ACTION } = CameraControlsImpl;
const DEG = MathUtils.DEG2RAD;

/** Camera presets by pitch above the table (SPEC §8.4). Polar angle = 90° − pitch. */
export const PRESETS = { top: 90, tabletop: 55, low: 30 } as const;
export const PITCH_MIN = 25;
export const DISTANCE = { min: 8, max: 400 } as const;
const PRESET_MS = 400;
/** The perspective camera's vertical field of view (the Board's Canvas). */
const FOV_DEG = 40;

/**
 * The orthographic top-down view (SPEC §8.4: `O`, "for precise measuring"): no perspective, so a foot is the same
 * size anywhere on screen. It is only ever top-down — turning it on tilts to 90° first, and any other preset turns it
 * off.
 */
export const useCameraMode = create<{ ortho: boolean }>(() => ({ ortho: false }));
const SPOTLIGHT_MS = 600;

/** Diagnostics (test hooks): rig mounts, helper installs, and helper calls that found no controls. */
export const rigDiag = { mounts: 0, unmounts: 0, helpers: 0, noControls: [] as string[] };

/** Diagnostics: when each tween began (the E2E journeys time the camera's motion against it). */
function noteTween(kind: string): void {
  boardDiag.tweenStarts.push({ kind, at: performance.now() });
  if (boardDiag.tweenStarts.length > 20) boardDiag.tweenStarts.shift();
}

/**
 * Each scene's view as it is right now, for as long as the page lives: if the camera setup runs again for a scene
 * already on screen (the renderer or the controls re-created), the view must not jump back to a default framing that
 * the session-storage copy (written only when the camera comes to rest) would otherwise give.
 */
const liveViews = new Map<string, { position: [number, number, number]; target: [number, number, number] }>();

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Tween {
  kind: "pitch" | "move";
  start: number;
  duration: number;
  apply(k: number): void;
  done?(): void;
}

/** Shared handle for tools, tests and panels: the live controls plus the rig's tween helpers. */
export const cameraRig: {
  controls: CameraControlsImpl | null;
  pitchTo(pitchDeg: number, ms?: number, done?: () => void): void;
  /** Orthographic top-down on or off (the view stays where it is). */
  setOrtho(on: boolean): void;
  moveTargetTo(x: number, z: number, ms?: number): void;
  pitchDeg(): number;
  /** Moves the view so the table slides by (dx, dz) feet (the grab-the-table pan). */
  panBy(dx: number, dz: number): void;
  /** Space is held: a left-drag pans whatever is under it. */
  spaceHeld: boolean;
  /** The scene the camera has been set up for (restored or framed) — set after the board shows it. */
  framedScene: string | null;
} = {
  controls: null,
  spaceHeld: false,
  framedScene: null,
  panBy: () => {},
  pitchTo: () => {},
  setOrtho: () => {},
  moveTargetTo: () => {},
  pitchDeg: () => PRESETS.tabletop,
};

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

/**
 * The board camera (SPEC §8.4): wheel dollies toward the cursor; right-drag orbits and tilts; left-drag on empty
 * board, middle-drag and Space+drag pan along the table; pitch 25°–90°, distance 8–400 ft, target within the scene
 * bounds + 20 %. Presets animate over exactly 400 ms; the DM Spotlight over 600 ms (AC-BRD-02/04). The last view of
 * each scene is remembered so a reconnect or reload restores it (AC-AUTH-07).
 */
export function CameraRig({ bounds, sceneId }: { bounds: Bounds; sceneId: string }) {
  const ref = useRef<CameraControlsImpl>(null);
  const tweens = useRef<Tween[]>([]);
  const follow = useRef<string | null>(null);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const ortho = useCameraMode((s) => s.ortho);
  /** The view to put the new camera at when it switches between perspective and orthographic. */
  const pendingView = useRef<{
    position: [number, number, number];
    target: [number, number, number];
    zoom?: number;
  } | null>(null);

  // Control setup — again whenever the camera changes (drei builds new controls for a new camera). This and the next
  // two are layout effects: a new camera (O) is set up and put in place in the commit that creates it, before any
  // frame is drawn or any pointer is picked with it (see applyNow).
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    cameraRig.controls = c;
    c.dollyToCursor = true;
    c.minDistance = DISTANCE.min;
    c.maxDistance = DISTANCE.max;
    c.minPolarAngle = 0.0001;
    c.maxPolarAngle = (90 - PITCH_MIN) * DEG;
    c.smoothTime = 0.12;
    c.draggingSmoothTime = 0.06;
    c.azimuthRotateSpeed = 0.55;
    c.polarRotateSpeed = 0.55;
    c.dollySpeed = 0.6;
    // Mouse and pen panning is the Board's "grab the table" pan (panBy): exact under the pointer at any pitch.
    c.mouseButtons.left = ACTION.NONE;
    c.mouseButtons.middle = ACTION.NONE;
    c.mouseButtons.right = ACTION.ROTATE;
    c.mouseButtons.wheel = ACTION.DOLLY;
    c.touches.one = ACTION.TOUCH_SCREEN_PAN;
    c.touches.two = ACTION.TOUCH_DOLLY_ROTATE;
    c.touches.three = ACTION.TOUCH_ROTATE;
    if ((camera as OrthoCam).isOrthographicCamera) {
      // Top-down only; the wheel and pinch zoom (the same range as the perspective distances).
      c.minPolarAngle = 0.0001;
      c.maxPolarAngle = 0.0001;
      c.mouseButtons.wheel = ACTION.ZOOM;
      c.touches.two = ACTION.TOUCH_ZOOM_ROTATE;
      const H = gl.domElement.clientHeight || window.innerHeight;
      c.minZoom = zoomFor(DISTANCE.max, H);
      c.maxZoom = zoomFor(DISTANCE.min, H);
    }
    return () => {
      if (cameraRig.controls === c) cameraRig.controls = null;
    };
  }, [camera, gl]);

  // The target stays within the scene bounds + 20 %.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the controls (ref) are new whenever the camera changes
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const { w, h } = boundsSize(bounds);
    c.setBoundary(
      new Box3(
        new Vector3(bounds.minX - w * 0.2, -50, bounds.minY - h * 0.2),
        new Vector3(bounds.maxX + w * 0.2, 200, bounds.maxY + h * 0.2),
      ),
    );
  }, [bounds, camera]);

  /** The scene these controls have set the view up for (the framing below runs once per scene and controls). */
  const framedBy = useRef<{ sceneId: string; controls: CameraControlsImpl } | null>(null);

  // Each scene opens where this viewer left it, or framed at the tabletop preset.
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    // The same controls already show this scene: a re-run for anything else (the scene's bounds or record replaced by
    // a patch) leaves the view alone — restoring the last live view here undid camera moves not yet drawn.
    if (framedBy.current?.sceneId === sceneId && framedBy.current.controls === c && !pendingView.current)
      return;
    framedBy.current = { sceneId, controls: c };
    // Switching between perspective and orthographic: the new camera takes the old one's view.
    const pv = pendingView.current;
    if (pv) {
      pendingView.current = null;
      void c.setLookAt(...pv.position, ...pv.target, false);
      if (pv.zoom !== undefined) void c.zoomTo(pv.zoom, false);
      applyNow(c);
      cameraRig.framedScene = sceneId;
      return;
    }
    // Already showing this scene in this page (the effect re-running — renderer or controls re-created, a remount):
    // the view stays exactly where the viewer has it.
    const live = liveViews.get(sceneId);
    if (live) {
      void c.setLookAt(...live.position, ...live.target, false);
      applyNow(c);
      cameraRig.framedScene = sceneId;
      return;
    }
    const saved = useUi.getState().cameras[sceneId];
    if (saved) {
      void c.setLookAt(...saved.position, ...saved.target, false);
      applyNow(c);
      cameraRig.framedScene = sceneId;
      return;
    }
    // The whole map inside the part of the screen the HUD leaves visible, centred there (framing.ts).
    const el = gl.domElement;
    const W = el.clientWidth || window.innerWidth;
    const H = el.clientHeight || window.innerHeight;
    const hud = useHudInsets.getState();
    const f = frameBounds({
      bounds,
      width: W,
      height: H,
      fovDeg: (camera as { fov?: number }).fov ?? 40,
      pitchDeg: PRESETS.tabletop,
      visible: { left: hud.left, top: hud.top + hud.banner, right: W - hud.right, bottom: H - 12 },
    });
    void c.setLookAt(...f.position, ...f.target, false);
    applyNow(c);
    cameraRig.framedScene = sceneId;
  }, [sceneId, bounds, camera, gl]);

  // Remember the view whenever the camera settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the controls (ref) are new whenever the camera changes
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const onRest = () => {
      const p = c.getPosition(new Vector3());
      const t = c.getTarget(new Vector3());
      useUi.getState().rememberCamera(sceneId, { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] });
    };
    // And, as it moves, the live view (for the page's life; see liveViews).
    const p = new Vector3();
    const t = new Vector3();
    const onUpdate = () => {
      if (sceneId === "none") return;
      c.getPosition(p);
      c.getTarget(t);
      liveViews.set(sceneId, { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] });
    };
    c.addEventListener("rest", onRest);
    c.addEventListener("update", onUpdate);
    return () => {
      c.removeEventListener("rest", onRest);
      c.removeEventListener("update", onUpdate);
    };
  }, [sceneId, camera]);

  useEffect(() => {
    rigDiag.mounts++;
    return () => {
      rigDiag.unmounts++;
    };
  }, []);

  // Tween helpers (exact durations, unlike the controls' damping).
  useEffect(() => {
    rigDiag.helpers++;
    cameraRig.pitchDeg = () => 90 - (ref.current?.polarAngle ?? 35 * DEG) / DEG;
    cameraRig.pitchTo = (pitchDeg, ms = PRESET_MS, done) => {
      const c = ref.current;
      if (!c) {
        rigDiag.noControls.push(`pitch@${Math.round(performance.now())}`);
        return;
      }
      // A tilt leaves the orthographic view (it is top-down only).
      if (useCameraMode.getState().ortho && pitchDeg < 89.5) {
        cameraRig.setOrtho(false);
        requestAnimationFrame(() => cameraRig.pitchTo(pitchDeg, ms, done));
        return;
      }
      const from = c.polarAngle;
      const to = Math.max(0.0001, (90 - pitchDeg) * DEG);
      tweens.current = tweens.current.filter((t) => t.kind !== "pitch");
      wake();
      noteTween("pitch");
      tweens.current.push({
        kind: "pitch",
        start: performance.now(),
        duration: ms,
        apply: (k) => void c.rotatePolarTo(from + (to - from) * k, false),
        done,
      });
    };
    cameraRig.setOrtho = (on) => {
      if (on === useCameraMode.getState().ortho || !ref.current) return;
      const go = () => {
        const c = ref.current;
        if (!c) return;
        const t = c.getTarget(new Vector3());
        const p = c.getPosition(new Vector3());
        const H = boardApi.element?.clientHeight || window.innerHeight;
        const cam = c.camera as unknown as OrthoCam & { isOrthographicCamera?: boolean };
        // The same visible area: the orthographic zoom that shows what the perspective camera showed at the
        // target's distance, and back.
        const d = on
          ? c.distance
          : MathUtils.clamp(distanceFor(cam.zoom ?? 1, H), DISTANCE.min, DISTANCE.max);
        const dir = p.clone().sub(t);
        if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
        // Orthographic: well above anything on the table (minis, 8-ft walls) whatever the zoom.
        dir.setLength(on ? Math.max(d, 60) : d);
        pendingView.current = {
          target: [t.x, t.y, t.z],
          position: [t.x + dir.x, t.y + dir.y, t.z + dir.z],
          ...(on ? { zoom: zoomFor(d, H) } : {}),
        };
        useCameraMode.setState({ ortho: on });
        wake();
      };
      if (on && cameraRig.pitchDeg() < 89.5) cameraRig.pitchTo(PRESETS.top, PRESET_MS, go);
      else go();
    };
    cameraRig.panBy = (dx, dz) => {
      const c = ref.current;
      if (!c) return;
      const t = c.getTarget(new Vector3());
      follow.current = null;
      void c.moveTo(t.x + dx, t.y, t.z + dz, false);
      wake();
    };
    cameraRig.moveTargetTo = (x, z, ms = PRESET_MS) => {
      const c = ref.current;
      if (!c) {
        rigDiag.noControls.push(`move@${Math.round(performance.now())}`);
        return;
      }
      const t0 = c.getTarget(new Vector3());
      tweens.current = tweens.current.filter((t) => t.kind !== "move");
      wake();
      noteTween("move");
      tweens.current.push({
        kind: "move",
        start: performance.now(),
        duration: ms,
        apply: (k) => void c.moveTo(t0.x + (x - t0.x) * k, t0.y * (1 - k), t0.z + (z - t0.z) * k, false),
      });
    };
  }, []);

  // Keyboard: Shift+1/2/3 presets, T toggles top-down ↔ tabletop, F focuses the selection, Shift+F follows it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.shiftKey && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3")) {
        e.preventDefault();
        cameraRig.pitchTo(
          e.code === "Digit1" ? PRESETS.top : e.code === "Digit2" ? PRESETS.tabletop : PRESETS.low,
        );
      } else if (!e.shiftKey && e.code === "KeyO") {
        cameraRig.setOrtho(!useCameraMode.getState().ortho);
      } else if (!e.shiftKey && e.code === "KeyT") {
        cameraRig.pitchTo(cameraRig.pitchDeg() > 75 ? PRESETS.tabletop : PRESETS.top);
      } else if (e.code === "KeyF") {
        const id = useUi.getState().selection[0];
        if (!id) return;
        follow.current = e.shiftKey && follow.current !== id ? id : null;
        const pos = tokenPosition(id);
        if (pos) cameraRig.moveTargetTo(pos.x, pos.y);
      } else if (e.code === "Space") {
        // Space + drag pans with any tool (the Board reads this flag).
        if (!e.repeat) e.preventDefault();
        cameraRig.spaceHeld = true;
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space") cameraRig.spaceHeld = false;
    };
    // Alt+wheel over a token raises or lowers it (AC-TOK-07): while Alt is held the wheel doesn't zoom.
    const setAltWheel = (alt: boolean) => {
      const c = cameraRig.controls;
      if (c) c.mouseButtons.wheel = alt ? ACTION.NONE : ACTION.DOLLY;
    };
    const onAltDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltWheel(true);
    };
    const onAltUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltWheel(false);
    };
    const onBlur = () => setAltWheel(false);
    window.addEventListener("keydown", onAltDown);
    window.addEventListener("keyup", onAltUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("keydown", onAltDown);
      window.removeEventListener("keyup", onAltUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // DM Spotlight (AC-BRD-04): opted-in players glide to the point over 600 ms.
  useEffect(
    () =>
      tableEvents.on("spotlight", (p) => {
        if (!useSettings.getState().dmCanMoveCamera) return;
        cameraRig.moveTargetTo(p.x, p.y, SPOTLIGHT_MS);
      }),
    [],
  );

  useFrame(() => {
    const now = performance.now();
    // On-demand rendering: a tween or a follow keeps frames coming (user input is handled by the controls).
    if (tweens.current.length || follow.current) again();
    if (tweens.current.length) {
      tweens.current = tweens.current.filter((t) => {
        const k = Math.min(1, (now - t.start) / t.duration);
        t.apply(easeInOut(k));
        if (k >= 1) t.done?.();
        return k < 1;
      });
    }
    if (follow.current && !tweens.current.length && ref.current) {
      const pos = tokenPosition(follow.current);
      if (pos) void ref.current.moveTo(pos.x, 0, pos.y, true);
      else follow.current = null;
    }
  });

  return (
    <>
      {ortho ? <OrthographicCamera makeDefault near={0.5} far={4000} /> : null}
      <CameraControls ref={ref} makeDefault />
    </>
  );
}

/**
 * Puts the camera object where its controls now are, at once. The controls write the camera only when they update
 * (each frame), so a view set without transition was reported by the controls while the camera still sat where it
 * was built — for a new camera (O) at the origin: a pick in between (a click right after pressing O) landed on the
 * wrong spot of the table, and a frame drawn in between showed the table from nowhere.
 */
function applyNow(c: CameraControlsImpl) {
  c.update(0);
  c.camera.updateMatrixWorld();
  wake();
}

/** The orthographic zoom showing as much as a perspective camera at distance d (drei sizes the frustum in pixels). */
function zoomFor(d: number, heightPx: number): number {
  return heightPx / (2 * d * Math.tan((FOV_DEG * DEG) / 2));
}
function distanceFor(zoom: number, heightPx: number): number {
  return heightPx / (2 * zoom * Math.tan((FOV_DEG * DEG) / 2));
}

/** Where a token is on the table (looked up lazily to avoid a store subscription per frame). */
let tokenPosition: (id: string) => { x: number; y: number } | null = () => null;
export function setTokenPositionLookup(fn: typeof tokenPosition): void {
  tokenPosition = fn;
}
