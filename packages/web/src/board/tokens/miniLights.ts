import { Color, type Material, Matrix4, Vector3, Vector4 } from "three";

/** The most lights a mini is lit by (Ultra's count, SPEC §24.6); a tier uses its own count of them. */
export const MINI_LIGHTS_MAX = 8;
/** How strongly a light shades a mini's facing side (the light map already brightens the ground it stands on). */
const STRENGTH = 1.6;
/** A light's height over its spot (ft): a torch held, a lantern hung — minis are lit from about there. */
const LIGHT_HEIGHT = 5;

/**
 * Real point lights for 3-D minis (SPEC §15.7 step 5): the N light sources nearest the view (tier: Ultra 8, High 4,
 * Medium 2, Low 0) shade a mini's sides, at the light map's intensities (full within the bright radius, half through
 * the dim, none past it) and flickering with it. Uniforms shared by every mini's material: one program for every tier
 * and any number of lights — a tier change or a torch lit compiles nothing (§24.7).
 */
export const miniLightUniforms = {
  gMiniLightPos: { value: Array.from({ length: MINI_LIGHTS_MAX }, () => new Vector4()) },
  gMiniLightCol: { value: Array.from({ length: MINI_LIGHTS_MAX }, () => new Vector4()) },
  gMiniLightCount: { value: 0 },
};

const GLSL_HEAD = /* glsl */ `
uniform vec4 gMiniLightPos[${MINI_LIGHTS_MAX}];
uniform vec4 gMiniLightCol[${MINI_LIGHTS_MAX}];
uniform int gMiniLightCount;`;

const GLSL_LIGHT = /* glsl */ `
for (int i = 0; i < ${MINI_LIGHTS_MAX}; i++) {
  if (i >= gMiniLightCount) break;
  vec4 lp = gMiniLightPos[i];
  vec4 lc = gMiniLightCol[i];
  vec3 toLight = lp.xyz - geometryPosition;
  float dist = length(toLight);
  float reach = dist < lc.w ? 1.0 : 0.5 * (1.0 - smoothstep(lc.w, lp.w, dist));
  float ndl = max(dot(normal, toLight / max(dist, 1e-3)), 0.0);
  reflectedLight.directDiffuse += ndl * reach * lc.rgb * BRDF_Lambert(material.diffuseColor);
}`;

const lit = new WeakSet<Material>();

/** Adds the mini lights to a mini's (standard or physical) material, keeping its other shader changes (the fog's). */
export function withMiniLights<M extends Material>(m: M): M {
  if (lit.has(m) || !(m as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) return m;
  lit.add(m);
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|minilights`;
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, miniLightUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GLSL_HEAD}`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${GLSL_LIGHT}`);
  };
  m.needsUpdate = true;
  return m;
}

export interface MiniLightSource {
  id: string;
  x: number;
  y: number;
  bright: number;
  dim: number;
  color: string;
  /** This frame's flicker (the light map's). */
  flicker: number;
}

/** The `n` sources nearest `focus` (a table point), nearest first; ties by id so the pick doesn't flutter. */
export function pickMiniLights(
  sources: MiniLightSource[],
  focus: { x: number; y: number },
  n: number,
): MiniLightSource[] {
  if (n <= 0) return [];
  return sources
    .map((s) => ({ s, d: Math.hypot(s.x - focus.x, s.y - focus.y) }))
    .sort((a, b) => a.d - b.d || (a.s.id < b.s.id ? -1 : 1))
    .slice(0, Math.min(n, MINI_LIGHTS_MAX))
    .map((x) => x.s);
}

const colour = new Color();
const p = new Vector3();
const view = new Matrix4();

/** Writes the picked lights into the uniforms, in the camera's view space (as three's own lights are). */
export function setMiniLights(picked: MiniLightSource[], viewMatrix: Matrix4): void {
  view.copy(viewMatrix);
  const pos = miniLightUniforms.gMiniLightPos.value;
  const col = miniLightUniforms.gMiniLightCol.value;
  picked.forEach((s, i) => {
    p.set(s.x, LIGHT_HEIGHT, s.y).applyMatrix4(view);
    (pos[i] as Vector4).set(p.x, p.y, p.z, s.bright + s.dim);
    colour.set(s.color || "#ffffff");
    const k = STRENGTH * s.flicker;
    (col[i] as Vector4).set(colour.r * k, colour.g * k, colour.b * k, s.bright);
  });
  miniLightUniforms.gMiniLightCount.value = picked.length;
}
