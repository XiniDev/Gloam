import type { DiceSkin } from "@gloam/shared/dice";
import {
  AgXToneMapping,
  AmbientLight,
  DirectionalLight,
  type Material,
  Mesh,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { dieGeometry } from "./atlas.ts";
import { diceEnvironment, diceMaterial } from "./materials.ts";
import { markerFor, solid } from "./solids.ts";

/**
 * A still of a die in a skin (the skin picker's preview, SPEC §8.9 Dice skins): the same geometry, face atlas,
 * material and reflection room as the dice on the table, so what you pick is what everyone sees — a d20 showing its
 * 20, turned a little so its facets and sheen read. One small offscreen renderer draws every preview and copies the
 * picture into the preview's own canvas; null when there's no WebGL (the picker falls back to a flat glyph).
 */

let stage: { gl: WebGLRenderer; scene: Scene; camera: PerspectiveCamera; mesh: Mesh } | null | undefined;

function getStage(): typeof stage {
  if (stage !== undefined) return stage;
  try {
    const gl = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    gl.toneMapping = AgXToneMapping;
    gl.outputColorSpace = SRGBColorSpace;
    gl.setClearColor(0x000000, 0);
    const scene = new Scene();
    const key = new DirectionalLight(0xffffff, 1.5);
    key.position.set(-8, 30, 14);
    scene.add(key, new AmbientLight(0xffffff, 0.12));
    const camera = new PerspectiveCamera(30, 1, 0.1, 50);
    // As the dice camera sees them: from above at a steep pitch.
    const pitch = (72 * Math.PI) / 180;
    // Close enough that the die fills about 85 % of the picture.
    camera.position.set(0, Math.sin(pitch) * 3.6, Math.cos(pitch) * 3.6);
    camera.lookAt(0, 0, 0);
    const s = solid("d20");
    const mesh = new Mesh(dieGeometry(s));
    // The 20 turned toward the camera, rolled a little off square.
    const toCam = camera.position.clone().normalize();
    const marker = (s.markers[markerFor(s, 20)] as Vector3).clone();
    mesh.quaternion.setFromUnitVectors(marker, toCam);
    mesh.quaternion.premultiply(new Quaternion().setFromAxisAngle(toCam, 0.35));
    mesh.quaternion.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.28));
    scene.add(mesh);
    stage = { gl, scene, camera, mesh };
  } catch {
    stage = null;
  }
  return stage;
}

/** Draws a d20 in `skin` into `canvas` (sized in device pixels). False when it can't (no WebGL). */
export function drawDiePreview(canvas: HTMLCanvasElement, skin: DiceSkin): boolean {
  const st = getStage();
  const ctx = canvas.getContext("2d");
  if (!st || !ctx) return false;
  const { gl, scene, camera, mesh } = st;
  gl.setSize(canvas.width, canvas.height, false);
  camera.aspect = canvas.width / Math.max(1, canvas.height);
  camera.updateProjectionMatrix();
  const material = diceMaterial(solid("d20"), skin, "values", false, diceEnvironment(gl));
  mesh.material = material;
  gl.render(scene, camera);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gl.domElement, 0, 0, canvas.width, canvas.height);
  (material as Material).dispose();
  return true;
}
