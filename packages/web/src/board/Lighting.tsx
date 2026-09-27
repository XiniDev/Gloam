import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { type DirectionalLight, type Object3D, PMREMGenerator } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { C } from "./colors.ts";
import { type Bounds, boundsCenter, boundsSize } from "./scene.ts";
import type { TierSpec } from "./tiers.ts";

/** The warm key light's direction: 35° up, from the south-west, so shadows fall away from the default camera. */
export const KEY_ELEVATION_DEG = 35;
export const KEY_AZIMUTH_DEG = -30;
/** Unit vector from the lit point toward the key light. */
export function keyLightDirection(): [number, number, number] {
  const el = (KEY_ELEVATION_DEG * Math.PI) / 180;
  const az = (KEY_AZIMUTH_DEG * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
}

/** Scene ambient → hemisphere intensity (SPEC §24.2): bright 1.0, dim 0.45, dark 0.15. */
export const AMBIENT_INTENSITY: Record<string, number> = { bright: 1.0, dim: 0.45, dark: 0.15 };
const KEY_INTENSITY: Record<string, number> = { bright: 2.4, dim: 1.5, dark: 0.7 };

/**
 * The lighting rig (SPEC §24.2): hemisphere light by the scene's ambient level, a warm key light at 35° elevation
 * (shadows on Medium and up, soft on Ultra) and a local RoomEnvironment through PMREM for subtle reflections —
 * no HDRI downloads.
 */
export function Lighting({ bounds, ambient, tier }: { bounds: Bounds; ambient: string; tier: TierSpec }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const key = useRef<DirectionalLight>(null);
  const target = useRef<Object3D>(null);

  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.3;
    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
      room.dispose();
    };
  }, [gl, scene]);

  const { x, y } = boundsCenter(bounds);
  const { w, h } = boundsSize(bounds);
  const span = Math.max(w, h, 40);
  const pos = useMemo(() => {
    const elev = (KEY_ELEVATION_DEG * Math.PI) / 180;
    const az = (KEY_AZIMUTH_DEG * Math.PI) / 180;
    const d = span * 1.4;
    return [
      x + Math.sin(az) * Math.cos(elev) * d,
      Math.sin(elev) * d,
      y + Math.cos(az) * Math.cos(elev) * d,
    ] as const;
  }, [x, y, span]);

  useEffect(() => {
    if (key.current && target.current) key.current.target = target.current;
  }, []);

  useEffect(() => {
    const l = key.current;
    if (!l) return;
    const cam = l.shadow.camera;
    cam.left = -span * 0.75;
    cam.right = span * 0.75;
    cam.top = span * 0.75;
    cam.bottom = -span * 0.75;
    cam.near = 1;
    cam.far = span * 4;
    cam.updateProjectionMatrix();
    l.shadow.mapSize.set(tier.shadowMap || 512, tier.shadowMap || 512);
    l.shadow.map?.dispose();
    l.shadow.map = null;
    l.shadow.bias = tier.softShadows ? -0.0006 : -0.0004;
    l.shadow.normalBias = 0.03;
  }, [span, tier.shadowMap, tier.softShadows]);

  return (
    <>
      <hemisphereLight args={[C.hemiSky, C.hemiGround, AMBIENT_INTENSITY[ambient] ?? 1]} />
      <object3D ref={target} position={[x, 0, y]} />
      <directionalLight
        ref={key}
        color={C.keyLight}
        intensity={KEY_INTENSITY[ambient] ?? 2.4}
        position={pos as unknown as [number, number, number]}
        castShadow={tier.shadowMap > 0}
      />
    </>
  );
}
