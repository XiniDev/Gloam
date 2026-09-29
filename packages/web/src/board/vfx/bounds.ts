import { ShaderMaterial, type ShaderMaterialParameters, Vector4 } from "three";
import type { Bounds } from "../scene.ts";
import { FOG_SEEN_GLSL, fogUniforms } from "../vision/fogMaterial.ts";

/**
 * The scene's bounds as the spell effects see them: an effect fades out over the last few feet inside the map's edge,
 * never spilling onto the table around it (critic P9 r1 #24: clouds and silence lay across the wooden table). One
 * uniform object, shared by every VFX material, set when the scene changes.
 */
export const VFX_BOUNDS = {
  uBounds: { value: new Vector4(-1e5, -1e5, 1e5, 1e5) },
  /** Feet over which an effect fades out as it reaches the edge. */
  uBoundsFade: { value: 4 },
};

export function setVfxBounds(b: Bounds): void {
  VFX_BOUNDS.uBounds.value.set(b.minX, b.minY, b.maxX, b.maxY);
}

const FADE_GLSL = /* glsl */ `
uniform vec4 uBounds; uniform float uBoundsFade;
varying vec2 vBoundsW;
float boundsFade(vec2 w) {
  vec2 lo = w - uBounds.xy;
  vec2 hi = uBounds.zw - w;
  return smoothstep(0.0, uBoundsFade, min(min(lo.x, lo.y), min(hi.x, hi.y)));
}
`;

/**
 * A VFX material that fades at the scene's edge: its vertex shader passes its world ground position (a vertex's, or —
 * where the shader sets `vBoundsW` itself, as the particles do from where each one has drifted — its own), and every
 * colour it writes has its alpha scaled by how far inside the bounds it is.
 */
export function vfxMaterial(
  p: ShaderMaterialParameters & { vertexShader: string; fragmentShader: string },
): ShaderMaterial {
  const own = p.vertexShader.includes("vBoundsW");
  if (!own && !/void main\(\)\s*\{/.test(p.vertexShader))
    throw new Error("A VFX vertex shader without main()");
  const vert = own
    ? `varying vec2 vBoundsW;\n${p.vertexShader}`
    : `varying vec2 vBoundsW;\n${p.vertexShader.replace(
        /void main\(\)\s*\{/,
        "void main() {\n  vBoundsW = (modelMatrix * vec4(position, 1.0)).xz;",
      )}`;
  // Faded at the scene's edge, and drawn only as far as the viewer sees the table under it (the players' fog).
  const frag = `${FADE_GLSL}${FOG_SEEN_GLSL}${p.fragmentShader.replace(
    /gl_FragColor\s*=[^;]*;/g,
    (m) => `${m} gl_FragColor.a *= boundsFade(vBoundsW) * gloamSeen(vBoundsW);`,
  )}`;
  return new ShaderMaterial({
    ...p,
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      ...p.uniforms,
      ...VFX_BOUNDS,
      gMode: fogUniforms.gMode,
      gDm: fogUniforms.gDm,
      gAmbient: fogUniforms.gAmbient,
      gRect: fogUniforms.gRect,
      gMemTexel: fogUniforms.gMemTexel,
      gMemRect: fogUniforms.gMemRect,
      gVis: fogUniforms.gVis,
      gVisPrev: fogUniforms.gVisPrev,
      gBlend: fogUniforms.gBlend,
      gLight: fogUniforms.gLight,
      gMem: fogUniforms.gMem,
    },
  });
}
