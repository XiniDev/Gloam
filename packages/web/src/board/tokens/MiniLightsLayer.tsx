import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { prefersReducedMotion } from "../../state/settings.ts";
import { cameraRig } from "../CameraRig.tsx";
import { TIERS, useTier } from "../tiers.ts";
import { flicker, hashSeed, lightsOf } from "../vision/VisionLayer.tsx";
import { useDrawn } from "../warmup/state.ts";
import { type MiniLightSource, pickMiniLights, setMiniLights } from "./miniLights.ts";

const focus = new Vector3();

/**
 * Picks, each frame, the light sources nearest the view that light the minis (SPEC §15.7 step 5; the tier's count)
 * and hands them to the minis' shaders (miniLights.ts): where the lights are this frame (a carried torch goes with
 * its carrier) and their flicker, the light map's.
 */
export function MiniLightsLayer() {
  const lights = useDrawn("lights");
  const tokens = useDrawn("tokens");
  const n = useTier((s) => TIERS[s.name].pointLights);
  useFrame((state) => {
    const still = prefersReducedMotion();
    const t = state.clock.elapsedTime;
    const sources: MiniLightSource[] = lightsOf(lights, tokens, performance.now()).map((l) => ({
      id: l.id,
      x: l.x,
      y: l.y,
      bright: l.bright,
      dim: l.dim,
      color: l.color,
      flicker: still ? 1 : flicker(l.anim, t, hashSeed(l.id)),
    }));
    const c = cameraRig.controls?.getTarget(focus) ?? focus;
    setMiniLights(pickMiniLights(sources, { x: c.x, y: c.z }, n), state.camera.matrixWorldInverse);
  });
  return null;
}
