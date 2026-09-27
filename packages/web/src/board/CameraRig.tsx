import { CameraControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import CameraControlsImpl from "camera-controls";
import { useEffect, useRef } from "react";
import { Box3, MathUtils, Vector3 } from "three";
import { tableEvents } from "../net/table.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { type Bounds, boundsCenter, boundsSize } from "./scene.ts";

const { ACTION } = CameraControlsImpl;
const DEG = MathUtils.DEG2RAD;

/** Camera presets by pitch above the table (SPEC §8.4). Polar angle = 90° − pitch. */
export const PRESETS = { top: 90, tabletop: 55, low: 30 } as const;
export const PITCH_MIN = 25;
export const DISTANCE = { min: 8, max: 400 } as const;
const PRESET_MS = 400;
const SPOTLIGHT_MS = 600;

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
  pitchTo(pitchDeg: number, ms?: number): void;
  moveTargetTo(x: number, z: number, ms?: number): void;
  pitchDeg(): number;
} = {
  controls: null,
  pitchTo: () => {},
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

  // One-time control setup.
  useEffect(() => {
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
    c.mouseButtons.left = ACTION.SCREEN_PAN;
    c.mouseButtons.middle = ACTION.SCREEN_PAN;
    c.mouseButtons.right = ACTION.ROTATE;
    c.mouseButtons.wheel = ACTION.DOLLY;
    c.touches.one = ACTION.TOUCH_SCREEN_PAN;
    c.touches.two = ACTION.TOUCH_DOLLY_ROTATE;
    c.touches.three = ACTION.TOUCH_ROTATE;
    return () => {
      if (cameraRig.controls === c) cameraRig.controls = null;
    };
  }, []);

  // The target stays within the scene bounds + 20 %.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const { w, h } = boundsSize(bounds);
    c.setBoundary(
      new Box3(
        new Vector3(bounds.minX - w * 0.2, -50, bounds.minY - h * 0.2),
        new Vector3(bounds.maxX + w * 0.2, 200, bounds.maxY + h * 0.2),
      ),
    );
  }, [bounds]);

  // Each scene opens where this viewer left it, or framed at the tabletop preset.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const saved = useUi.getState().cameras[sceneId];
    if (saved) {
      void c.setLookAt(...saved.position, ...saved.target, false);
      return;
    }
    const { x, y } = boundsCenter(bounds);
    const { w, h } = boundsSize(bounds);
    const fov = ((camera as { fov?: number }).fov ?? 40) * DEG;
    const dist = MathUtils.clamp((Math.max(w, h * 1.3) / (2 * Math.tan(fov / 2))) * 0.85, 20, 260);
    const pitch = PRESETS.tabletop * DEG;
    void c.setLookAt(x, dist * Math.sin(pitch), y + dist * Math.cos(pitch), x, 0, y, false);
  }, [sceneId, bounds, camera]);

  // Remember the view whenever the camera settles.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const onRest = () => {
      const p = c.getPosition(new Vector3());
      const t = c.getTarget(new Vector3());
      useUi.getState().rememberCamera(sceneId, { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] });
    };
    c.addEventListener("rest", onRest);
    return () => c.removeEventListener("rest", onRest);
  }, [sceneId]);

  // Tween helpers (exact durations, unlike the controls' damping).
  useEffect(() => {
    cameraRig.pitchDeg = () => 90 - (ref.current?.polarAngle ?? 35 * DEG) / DEG;
    cameraRig.pitchTo = (pitchDeg, ms = PRESET_MS) => {
      const c = ref.current;
      if (!c) return;
      const from = c.polarAngle;
      const to = Math.max(0.0001, (90 - pitchDeg) * DEG);
      tweens.current = tweens.current.filter((t) => t.kind !== "pitch");
      tweens.current.push({
        kind: "pitch",
        start: performance.now(),
        duration: ms,
        apply: (k) => void c.rotatePolarTo(from + (to - from) * k, false),
      });
    };
    cameraRig.moveTargetTo = (x, z, ms = PRESET_MS) => {
      const c = ref.current;
      if (!c) return;
      const t0 = c.getTarget(new Vector3());
      tweens.current = tweens.current.filter((t) => t.kind !== "move");
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
    let spaceHeld = false;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.shiftKey && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3")) {
        e.preventDefault();
        cameraRig.pitchTo(
          e.code === "Digit1" ? PRESETS.top : e.code === "Digit2" ? PRESETS.tabletop : PRESETS.low,
        );
      } else if (!e.shiftKey && e.code === "KeyT") {
        cameraRig.pitchTo(cameraRig.pitchDeg() > 75 ? PRESETS.tabletop : PRESETS.top);
      } else if (e.code === "KeyF") {
        const id = useUi.getState().selection[0];
        if (!id) return;
        follow.current = e.shiftKey && follow.current !== id ? id : null;
        const pos = tokenPosition(id);
        if (pos) cameraRig.moveTargetTo(pos.x, pos.y);
      } else if (e.code === "Space" && !spaceHeld) {
        spaceHeld = true;
        if (ref.current) ref.current.mouseButtons.left = ACTION.SCREEN_PAN;
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
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

  return <CameraControls ref={ref} makeDefault />;
}

/** Where a token is on the table (looked up lazily to avoid a store subscription per frame). */
let tokenPosition: (id: string) => { x: number; y: number } | null = () => null;
export function setTokenPositionLookup(fn: typeof tokenPosition): void {
  tokenPosition = fn;
}
