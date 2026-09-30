import type { DiceSkin } from "@gloam/shared/dice";
import {
  BackSide,
  CanvasTexture,
  Color,
  DoubleSide,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { keepDrawn } from "../board/gpu.ts";
import { type FaceSet, faceAtlas, faceMask, faceRoughness, outlinedNumerals } from "./atlas.ts";
import type { Solid } from "./solids.ts";

/**
 * How dice look (SPEC §8.9 Dice skins, §18.4 Geometry and skins): the skin's body and number colours on each face,
 * and its material — resin, gemstone (translucent on High and Ultra), metal (its numbers enamel-filled), bone,
 * obsidian — lit by a small lantern-lit room made in code (no files, no network): a dark wood floor, a warm glow
 * overhead, a warm key window where the dice light is and a dim cool fill opposite. Metal and glassy skins reflect it,
 * so they read as metal and glass even on Low where there's no transmission.
 */

const envByRenderer = new WeakMap<object, Texture>();

/** The reflection room, made once per renderer (and drawn again if its context is lost and given back, gpu.ts). */
export function diceEnvironment(gl: WebGLRenderer): Texture {
  const hit = envByRenderer.get(gl);
  if (hit) return hit;
  const rt = drawRoom(gl);
  keepDrawn(gl, rt, () => drawRoom(gl));
  envByRenderer.set(gl, rt.texture);
  return rt.texture;
}

/** The room drawn into a new environment map. */
function drawRoom(gl: WebGLRenderer): WebGLRenderTarget {
  const scene = new Scene();
  const room = new Mesh(
    new SphereGeometry(20, 32, 16),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      vertexShader:
        "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      // Floor (dark wood) → horizon (warm umber) → ceiling (lantern glow); linear values.
      fragmentShader: `varying vec3 vDir;
        void main(){
          float y = vDir.y;
          vec3 floorC = vec3(0.028, 0.017, 0.010);
          vec3 horizon = vec3(0.16, 0.095, 0.05);
          vec3 ceiling = vec3(0.62, 0.43, 0.24);
          vec3 c = y < 0.0 ? mix(horizon, floorC, smoothstep(0.0, 0.5, -y)) : mix(horizon, ceiling, smoothstep(0.0, 0.85, y));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  scene.add(room);
  const panel = (w: number, h: number, color: Color, x: number, y: number, z: number) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color, side: DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
    return m;
  };
  // A lantern-lit softbox where the dice's upward faces mirror the room from the dice camera (72° down: up and a
  // little away), set off-centre so its edge runs across them — faces catch a highlight or its falloff, not one flat
  // tone; the key window where the dice's light comes from (the stage's key light is at −8, 30, 14); a cool fill.
  panel(5, 4, new Color(1.0, 0.8, 0.52).multiplyScalar(4), -5.2, 12.4, -4);
  // A thin hot strip across where flat tops mirror the room: a specular band that moves over them as they tumble.
  panel(9, 0.7, new Color(1.0, 0.9, 0.72).multiplyScalar(9), 0.8, 13.2, -4.4);
  panel(9, 6, new Color(1.0, 0.82, 0.56).multiplyScalar(3.5), -5, 15, 8);
  panel(6, 10, new Color(0.55, 0.62, 0.8).multiplyScalar(0.9), 15, 6, -6);
  const pmrem = new PMREMGenerator(gl);
  const rt = pmrem.fromScene(scene, 0.02);
  pmrem.dispose();
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      (o.material as Material).dispose();
    }
  });
  return rt;
}

const materialCache = new Map<string, Material>();

/**
 * A die's material for a skin: cached per die kind, skin, face set, tier and environment; each throw fades a clone.
 * Reflections are per material (a metal die reflects the room strongly, resin faintly) — a scene-wide environment
 * intensity would override them.
 */
export function diceMaterial(s: Solid, skin: DiceSkin, set: FaceSet, high: boolean, env: Texture): Material {
  const key = `${s.kind}|${skin.body}|${skin.number}|${skin.material}|${set}|${high ? "h" : "l"}|${env.uuid}`;
  let base = materialCache.get(key);
  if (!base) {
    const map = faceAtlas(s, skin, set);
    const body = new Color(skin.body);
    switch (skin.material) {
      case "gemstone":
        base = high
          ? new MeshPhysicalMaterial({
              map,
              envMap: env,
              envMapIntensity: 1.1,
              roughness: 0.08,
              metalness: 0,
              transmission: 0.55,
              thickness: 1.2,
              ior: 1.54,
              attenuationColor: body,
              attenuationDistance: 2.5,
            })
          : // No transmission on Low: a glassy surface with a faint inner glow of its own colour.
            new MeshStandardMaterial({
              map,
              envMap: env,
              envMapIntensity: 0.6,
              metalness: 0.1,
              roughness: 0.1,
              emissive: body,
              emissiveIntensity: 0.14,
            });
        break;
      case "metal":
        // The metal takes its colour from the body (metals reflect in their own colour); the numbers are enamel.
        base = new MeshStandardMaterial({
          map,
          envMap: env,
          envMapIntensity: 1.5,
          metalness: 1,
          metalnessMap: faceMask(s, set, outlinedNumerals(skin.number)),
          roughness: 1,
          roughnessMap: faceRoughness(s),
        });
        break;
      case "bone":
        base = new MeshStandardMaterial({
          map,
          envMap: env,
          envMapIntensity: 0.25,
          metalness: 0,
          roughness: 0.78,
        });
        break;
      case "obsidian":
        base = new MeshStandardMaterial({
          map,
          envMap: env,
          envMapIntensity: 1.1,
          metalness: 0.05,
          roughness: 0.08,
        });
        break;
      default:
        base = new MeshStandardMaterial({
          map,
          envMap: env,
          envMapIntensity: 0.3,
          metalness: 0,
          roughness: 0.3,
        });
    }
    materialCache.set(key, base);
  }
  return base.clone();
}

let blob: CanvasTexture | null = null;
/**
 * A soft round shadow for under a die (a radial falloff drawn once): the contact shadow that grounds dice on tiers
 * without shadow maps, and deepens the contact where they have them.
 */
export function contactShadowTexture(): CanvasTexture {
  if (blob) return blob;
  const N = 64;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  // Alpha only (the material is black): a dense core where the die meets the floor (the inner three quarters) inside
  // a soft penumbra falling to nothing at the edge.
  const smooth = (e0: number, e1: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const r = Math.min(1, Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) / (N / 2));
      const core = 0.8 * (1 - smooth(0.35, 0.74, r));
      const penumbra = 0.5 * (1 - smooth(0.2, 1, r)) ** 1.4;
      img.data[(y * N + x) * 4 + 3] = Math.round(255 * Math.min(1, core + penumbra));
    }
  g.putImageData(img, 0, 0);
  blob = new CanvasTexture(c);
  blob.colorSpace = SRGBColorSpace;
  return blob;
}
