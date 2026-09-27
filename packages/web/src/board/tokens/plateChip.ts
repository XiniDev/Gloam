import { Color, PlaneGeometry, ShaderMaterial, Vector2 } from "three";
import { C } from "../colors.ts";

/**
 * The name plate's backing chip (SPEC §27.4: name plates are 4-px-radius chips): an ink rounded rectangle drawn as a
 * signed-distance shape, so its corners stay crisp and round at any size — the plate resizes to its name.
 */
const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const FRAG = /* glsl */ `
uniform vec2 uSize; uniform float uRadius; uniform vec3 uColor; uniform vec3 uEdge; uniform float uEdgeW;
uniform float uOpacity;
varying vec2 vUv;
float roundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  float d = roundBox(p, uSize * 0.5, uRadius);
  float aa = max(fwidth(d), 1e-4);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  // A hairline just inside the edge.
  float edge = 1.0 - smoothstep(0.0, aa, abs(d + uEdgeW * 0.5) - uEdgeW * 0.5);
  gl_FragColor = vec4(mix(uColor, uEdge, edge * 0.55), inside * uOpacity);
}`;

/** One unit square; each chip scales it to its size. */
export const CHIP_GEOMETRY = new PlaneGeometry(1, 1);

export function createChipMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSize: { value: new Vector2(1, 1) },
      uRadius: { value: 0.2 },
      uColor: { value: new Color(C.ink950) },
      uEdge: { value: new Color(C.brass600) },
      uEdgeW: { value: 0.05 },
      uOpacity: { value: 0.82 },
    },
  });
}

/** Sizes the chip (plate units) and sets its opacity; the radius is 4 px at the plate's nominal 20 px per unit. */
export function setChip(m: ShaderMaterial, w: number, h: number, opacity: number): void {
  const u = m.uniforms as {
    uSize: { value: Vector2 };
    uOpacity: { value: number };
  };
  u.uSize.value.set(w, h);
  u.uOpacity.value = opacity;
}
