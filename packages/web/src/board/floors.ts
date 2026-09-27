import { C } from "./colors.ts";
import { NOISE_GLSL } from "./glsl.ts";
import type { FloorStyle } from "./scene.ts";

export const FLOOR_STYLES: FloorStyle[] = ["stone", "wood", "grass", "sand", "parchment", "cavern"];
export const STYLE_INDEX: Record<FloorStyle, number> = {
  stone: 0,
  wood: 1,
  grass: 2,
  sand: 3,
  parchment: 4,
  cavern: 5,
};
export const PALETTE: Record<FloorStyle, [string, string, string]> = {
  stone: [C.stoneA, C.stoneB, C.stoneJoint],
  wood: [C.plankA, C.plankB, C.plankJoint],
  grass: [C.grassA, C.grassB, C.grassDry],
  sand: [C.sandA, C.sandB, C.sandA],
  parchment: [C.parchmentA, C.parchmentB, C.parchmentStain],
  cavern: [C.caveA, C.caveB, C.caveCrack],
};
export const ROUGHNESS: Record<FloorStyle, number> = {
  stone: 0.86,
  wood: 0.62,
  grass: 0.95,
  sand: 0.96,
  parchment: 0.9,
  cavern: 0.92,
};

/**
 * Procedural floors (SPEC §8.3, AC-SCN-05): stone flagstones, wooden planks, grass, sand, parchment and cavern rock.
 * Every pattern is a continuous function of the world position in feet — nothing is a repeated texture, so there
 * is no tile to repeat and no seam to show. Lit like any surface (the scene's ambient level applies).
 */
export const FLOOR_PATTERN_GLSL = /* glsl */ `
vec3 floorPattern(float uStyle, vec2 p, vec3 uA, vec3 uB, vec3 uJ, out float rough) {
  rough = 0.9;
  if (uStyle < 0.5) {
    // Flagstones: 2.5-ft courses, stones 2.5–4.5 ft long, staggered; mortar joints; per-stone tint and wear.
    float row = floor(p.y / 2.5);
    float x = p.x + g_hash(vec2(row, 3.0)) * 7.0;
    float len = 2.5 + 2.0 * g_hash(vec2(row, 11.0));
    float stone = floor(x / len);
    vec2 local = vec2(fract(x / len) * len, fract(p.y / 2.5) * 2.5);
    float edge = min(min(local.x, len - local.x), min(local.y, 2.5 - local.y));
    float mortar = smoothstep(0.1, 0.03, edge);
    float h = g_hash(vec2(stone, row));
    vec3 c = mix(uA, uB, h) * (0.78 + 0.35 * g_fbm(p * 1.3 + h * 20.0));
    c *= 0.9 + 0.1 * smoothstep(0.0, 0.5, edge);
    return mix(c, uJ, mortar);
  }
  if (uStyle < 1.5) {
    // Planks: 0.75-ft boards along X, 6–10 ft long with staggered butt joints; grain from stretched fbm.
    float board = floor(p.y / 0.75);
    float x = p.x + g_hash(vec2(board, 5.0)) * 9.0;
    float len = 6.0 + 4.0 * g_hash(vec2(board, 13.0));
    float piece = floor(x / len);
    float h = g_hash(vec2(board, piece));
    float grain = g_fbm(vec2(p.x * 0.35 + h * 30.0, p.y * 7.0));
    vec3 c = mix(uA, uB, 0.25 + 0.5 * grain + 0.25 * h);
    float side = smoothstep(0.035, 0.0, min(fract(p.y / 0.75), 1.0 - fract(p.y / 0.75)) * 0.75);
    float butt = smoothstep(0.05, 0.0, min(fract(x / len), 1.0 - fract(x / len)) * len);
    rough = 0.55 + 0.15 * grain;
    return mix(c, uJ, max(side, butt) * 0.85);
  }
  if (uStyle < 2.5) {
    // Grass: broad colour drift, dry patches, fine blade noise.
    float broad = g_fbm(p * 0.07);
    float dry = smoothstep(0.55, 0.75, g_fbm(p * 0.035 + 40.0));
    float blades = g_noise(p * 9.0) * 0.5 + g_noise(p * 23.0) * 0.5;
    vec3 c = mix(uA, uB, broad);
    c = mix(c, uJ, dry * 0.55);
    return c * (0.8 + 0.35 * blades);
  }
  if (uStyle < 3.5) {
    // Sand: warm drift with wind ripples.
    float drift = g_fbm(p * 0.05);
    float warp = g_fbm(p * 0.2) * 5.0;
    float ripple = 0.5 + 0.5 * sin(p.x * 1.6 + p.y * 0.4 + warp);
    vec3 c = mix(uA, uB, drift);
    return c * (0.9 + 0.12 * ripple + 0.06 * g_noise(p * 14.0));
  }
  if (uStyle < 4.5) {
    // Parchment: paper tone, fibres, faint stains.
    float fibre = g_fbm(p * vec2(2.5, 0.8)) * 0.6 + g_noise(p * 12.0) * 0.4;
    float stain = smoothstep(0.62, 0.8, g_fbm(p * 0.06 + 8.0));
    vec3 c = mix(uA, uB, 0.25 + 0.35 * g_fbm(p * 0.12));
    c *= 0.94 + 0.08 * fibre;
    return mix(c, uJ, stain * 0.35);
  }
  // Cavern rock: large Voronoi plates with dark cracks, mottled stone.
  vec3 v = g_voronoi(p / 4.0);
  float crack = smoothstep(0.06, 0.0, v.y);
  vec3 c = mix(uA, uB, 0.3 + 0.5 * g_fbm(p * 0.5 + v.z * 10.0)) * (0.85 + 0.3 * v.z);
  return mix(c, uJ, crack);
}
`;

/** Display names for the floor picker. */
export const FLOOR_LABELS: Record<FloorStyle, string> = {
  stone: "Stone flagstones",
  wood: "Wooden planks",
  grass: "Grass",
  sand: "Sand",
  parchment: "Parchment",
  cavern: "Cavern rock",
};

/**
 * All six floors side by side in one fragment shader (3 × 2 tiles), for the New scene picker: one WebGL context
 * rather than six. Uniforms uA0…uJ5 carry the palettes (sRGB, as the preview draws straight to the screen).
 */
export const FLOOR_PREVIEW_GLSL = /* glsl */ `
uniform vec2 uRes; uniform float uTime;
uniform vec3 uA0; uniform vec3 uB0; uniform vec3 uJ0; uniform vec3 uA1; uniform vec3 uB1; uniform vec3 uJ1;
uniform vec3 uA2; uniform vec3 uB2; uniform vec3 uJ2; uniform vec3 uA3; uniform vec3 uB3; uniform vec3 uJ3;
uniform vec3 uA4; uniform vec3 uB4; uniform vec3 uJ4; uniform vec3 uA5; uniform vec3 uB5; uniform vec3 uJ5;
${NOISE_GLSL}
${FLOOR_PATTERN_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 cell = vec2(uv.x * 3.0, (1.0 - uv.y) * 2.0);
  float idx = floor(cell.y) * 3.0 + floor(cell.x);
  vec2 local = fract(cell);
  vec2 p = vec2(local.x * 14.0, local.y * 14.0 * (uRes.y / 2.0) / (uRes.x / 3.0));
  vec3 A = uA0, B = uB0, J = uJ0;
  if (idx > 0.5) { A = uA1; B = uB1; J = uJ1; }
  if (idx > 1.5) { A = uA2; B = uB2; J = uJ2; }
  if (idx > 2.5) { A = uA3; B = uB3; J = uJ3; }
  if (idx > 3.5) { A = uA4; B = uB4; J = uJ4; }
  if (idx > 4.5) { A = uA5; B = uB5; J = uJ5; }
  float r;
  vec3 c = floorPattern(idx, p, A, B, J, r);
  vec2 edge = min(local, 1.0 - local) * vec2(uRes.x / 3.0, uRes.y / 2.0);
  c *= smoothstep(0.0, 2.0, min(edge.x, edge.y));
  gl_FragColor = vec4(c, 1.0);
}
`;
