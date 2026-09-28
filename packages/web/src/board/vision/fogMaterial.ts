import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  RedFormat,
  RepeatWrapping,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector4,
} from "three";
import { C, col } from "../colors.ts";

/**
 * The fog and light composite (SPEC §15.7 step 3), in every lit material of the board: per fragment, the perception
 * class from the vision and light render targets alone (no per-viewer uniforms, so any number of viewers), then the
 * grade — bright in full colour; dim at 55 % with a slight cool shift; darkvision in grey (with a faint grain);
 * blindsight grey with a slow ripple; remembered ground desaturated at 35 % with a blue tint; the unknown as drifting
 * war fog. DMs see everything with a hatch where the players' fog is. Outside the scene (the table) nothing changes.
 *
 * One set of uniforms is shared by every patched material, so the renderer updates it once per frame.
 */
export const fogUniforms = {
  /** 0 off, 1 painted, 2 dynamic. */
  gMode: { value: 0 },
  /** 1: the DM's view (everything visible, the players' fog hatched). */
  gDm: { value: 0 },
  /** The scene's ambient light: 0 dark, 1 dim, 2 bright. */
  gAmbient: { value: 2 },
  /** Scene bounds the targets cover: x0, y0 (ft), width, height (ft). */
  gRect: { value: new Vector4(0, 0, 1, 1) },
  /** One texel of the vision/light targets, and of the memory raster (uv units). */
  gTexel: { value: new Vector2(1, 1) },
  gMemTexel: { value: new Vector2(1, 1) },
  /** Where the memory raster lies: x0, y0 (ft), width, height (ft) — its cells may overhang the bounds. */
  gMemRect: { value: new Vector4(0, 0, 1, 1) },
  /** Vision (R sight, G darkvision, B blindsight, A truesight): now, and before the last change (for the reveal). */
  gVis: { value: null as Texture | null },
  gVisPrev: { value: null as Texture | null },
  /** 0 → 1 over 300 ms after the vision changes (reveals animate, §15.7 step 6). */
  gBlend: { value: 1 },
  /** Light coverage (R bright, G dim, B magical) and colour. */
  gLight: { value: null as Texture | null },
  gLightCol: { value: null as Texture | null },
  /** Memory: explored (dynamic) or revealed (painted), one value per fog cell. */
  gMem: { value: null as Texture | null },
  /** Seconds, frozen under reduced motion (the war fog drifts with it). */
  gTime: { value: 0 },
  /** A tileable fbm tile: the war fog is two scrolling reads of it (cheap enough for software GL and low tiers). */
  gNoise: { value: fogNoise() as Texture },
};

/** 256² tileable value-noise fbm (5 octaves), made once on the CPU (no GPU readback). */
function fogNoise(): DataTexture {
  const N = 256;
  const data = new Uint8Array(N * N);
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const octaves = [4, 8, 16, 32, 64].map((L) => ({ L, g: Float32Array.from({ length: L * L }, rnd) }));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  let min = 1;
  let max = 0;
  const f = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let v = 0;
      let amp = 0.5;
      let norm = 0;
      for (const { L, g } of octaves) {
        const fx = (x / N) * L;
        const fy = (y / N) * L;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = smooth(fx - x0);
        const ty = smooth(fy - y0);
        const at = (i: number, j: number) => g[((j % L) * L + (i % L)) >>> 0] as number;
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        v += (a + (b - a) * ty) * amp;
        norm += amp;
        amp *= 0.5;
      }
      v /= norm;
      f[y * N + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  for (let k = 0; k < N * N; k++) data[k] = Math.round((((f[k] as number) - min) / (max - min || 1)) * 255);
  const t = new DataTexture(data, N, N, RedFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export type FogKind = "floor" | "wall" | "object";

const patched = new WeakSet<Material>();

const COMMON = /* glsl */ `
uniform float gMode; uniform float gDm; uniform float gAmbient; uniform vec4 gRect; uniform vec2 gTexel;
uniform vec2 gMemTexel; uniform vec4 gMemRect; uniform sampler2D gVis; uniform sampler2D gVisPrev; uniform float gBlend;
uniform sampler2D gLight; uniform sampler2D gLightCol; uniform sampler2D gMem; uniform float gTime;
uniform sampler2D gNoise;
varying vec3 vFogW; varying vec2 vFogAcross;
`;

const GLSL = /* glsl */ `
float gf_hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
const vec3 G_FOG = vec3(${col(C.warFog)
  .toArray()
  .map((v) => v.toFixed(4))
  .join(", ")});
const vec3 G_TINT = vec3(${col(C.exploredTint)
  .toArray()
  .map((v) => v.toFixed(4))
  .join(", ")});
const vec3 G_HATCH = vec3(${col(C.brass600)
  .toArray()
  .map((v) => v.toFixed(4))
  .join(", ")});
vec4 gVisAt(vec2 uv) { return gBlend >= 1.0 ? texture2D(gVis, uv) : mix(texture2D(gVisPrev, uv), texture2D(gVis, uv), gBlend); }
// Explored / revealed memory, softened by a cell (upsampled and blurred, §15.7 step 1).
float gMemAt(vec2 xz) {
  // Upsampled and blurred across a cell, then contoured: a smooth edge instead of the raster's 1-ft steps.
  vec2 uv = (xz - gMemRect.xy) / gMemRect.zw;
  vec2 o = gMemTexel * 0.75;
  float m = 0.25 * (texture2D(gMem, uv + vec2(o.x, o.y)).r + texture2D(gMem, uv + vec2(-o.x, o.y)).r
    + texture2D(gMem, uv + vec2(o.x, -o.y)).r + texture2D(gMem, uv + vec2(-o.x, -o.y)).r);
  return smoothstep(0.2, 0.8, m);
}
// The unknown: deep blue-black war fog drifting slowly (animated fbm), never flat black.
vec3 gWarFog(vec2 xz) {
  float n = texture2D(gNoise, xz * 0.034 + vec2(gTime * 0.004, -gTime * 0.0028)).r;
  float m = texture2D(gNoise, xz * 0.087 - vec2(gTime * 0.007, gTime * 0.0035)).r;
  return G_FOG * (0.45 + 0.95 * n * n + 0.35 * m);
}
// The DM's view of the players' fog: a translucent hatch, the map still readable under it.
vec3 gHatch(vec3 col, vec2 xz, float fog) {
  float h = abs(fract((xz.x + xz.y) * 0.5) - 0.5);
  float line = 1.0 - smoothstep(0.06, 0.12, h);
  return mix(col, mix(col * 0.72, G_HATCH, line * 0.55), fog * 0.85);
}
// Sight coverage with a soft edge inside the visible region only (the feather never crosses a wall; DECISIONS).
vec4 gVisFeathered(vec2 uv) {
  vec4 c = gVisAt(uv);
  if (c.r <= 0.001) return c;
  vec2 r = vec2(1.2 / gRect.z, 1.2 / gRect.w); // 1.2 ft in uv
  float s = c.r;
  s += gVisAt(uv + vec2(r.x, 0.0)).r + gVisAt(uv - vec2(r.x, 0.0)).r;
  s += gVisAt(uv + vec2(0.0, r.y)).r + gVisAt(uv - vec2(0.0, r.y)).r;
  float f = clamp(2.0 * (s / 5.0) - 1.0, 0.0, 1.0);
  return vec4(f, c.g * f / c.r, c.b, c.a * f / c.r);
}
vec3 gloamFog(vec3 col, vec2 xz, float feather, vec2 across) {
  if (gMode < 0.5) return col;
  vec2 uv = (xz - gRect.xy) / gRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return col;
  float mem = gMemAt(xz);
  if (gMode < 1.5) {
    // Painted: what's revealed is plain; the rest is fog.
    if (gDm > 0.5) return gHatch(col, xz, 1.0 - mem);
    return mix(gWarFog(xz), col, mem);
  }
  vec4 v;
  if (dot(across, across) > 0.0) {
    // A wall: seen when either side of it is (its faces lie on the visible region's edge).
    vec2 d = across * 0.6 / gRect.zw;
    v = max(gVisAt(uv + d), gVisAt(uv - d));
  } else v = feather > 0.5 ? gVisFeathered(uv) : gVisAt(uv);
  vec4 L = texture2D(gLight, uv);
  float bright = max(L.r, gAmbient > 1.5 ? 1.0 : 0.0);
  float dim = max(max(L.g, bright), gAmbient > 0.5 ? 1.0 : 0.0);
  float sight = v.r;
  float dv = v.g;
  float ts = v.a;
  float wBright = sight * (bright + (dim - bright) * dv);
  float wDim = sight * (dim - bright) * (1.0 - dv);
  float wDark = sight * (1.0 - dim) * max(dv, ts);
  float seenSight = clamp(wBright + wDim + wDark, 0.0, 1.0);
  float wBlind = v.b * (1.0 - seenSight);
  float seen = clamp(seenSight + wBlind, 0.0, 1.0);
  if (gDm > 0.5) return gHatch(col, xz, 1.0 - max(seen, mem * 0.55));
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 lit = col;
  // Coloured light warms (or cools) what it lights; a flickering one's intensity (alpha over coverage) breathes.
  vec4 lcol = texture2D(gLightCol, uv);
  vec3 lc = lcol.rgb;
  float lk = max(lc.r, max(lc.g, lc.b));
  float flick = L.g > 0.001 ? clamp(lcol.a / L.g, 0.6, 1.0) : 1.0;
  if (lk > 0.001) lit *= mix(vec3(1.0), lc / lk, 0.28 * clamp(L.g * 1.5, 0.0, 1.0));
  lit *= flick;
  vec3 cDim = col * 0.55 * vec3(0.93, 0.97, 1.07) * flick;
  float grain = (gf_hash(floor(xz * 6.0) + floor(gTime * 12.0)) - 0.5) * 0.05;
  vec3 cDark = vec3(lum * 0.85 + grain);
  float ripple = 0.08 * sin(length(xz) * 2.2 - gTime * 1.6);
  vec3 cBlind = vec3(lum * (0.7 + ripple));
  vec3 visible = (lit * wBright + cDim * wDim + cDark * wDark + cBlind * wBlind) / max(seen, 0.001);
  vec3 remembered = mix(vec3(lum), col, 0.3) * 0.35 + G_TINT * 0.05;
  vec3 unseen = mix(gWarFog(xz), remembered, mem);
  return mix(unseen, visible, seen);
}
`;

/**
 * Adds the composite to a material (keeping its own shader changes): its fragments are graded at their table position —
 * a floor with the soft inner edge, a wall by whichever side of it is seen, anything else (tokens, minis) as it
 * stands.
 */
export function withFog<M extends Material>(m: M, kind: FogKind): M {
  // (A set, not a userData flag: a material's clone copies userData but not its shader hook.)
  if (patched.has(m)) return m;
  patched.add(m);
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|fog:${kind}`;
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, fogUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vFogW; varying vec2 vFogAcross;`)
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
vec4 fogP = vec4(transformed, 1.0);
vec4 fogA = vec4(0.0, 0.0, ${kind === "wall" ? "1.0" : "0.0"}, 0.0);
#ifdef USE_INSTANCING
fogP = instanceMatrix * fogP;
fogA = instanceMatrix * fogA;
#endif
vFogW = (modelMatrix * fogP).xyz;
vec3 fogAW = (modelMatrix * fogA).xyz;
vFogAcross = dot(fogAW.xz, fogAW.xz) > 1e-6 ? normalize(fogAW.xz) : vec2(0.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${COMMON}\n${GLSL}`)
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
gl_FragColor.rgb = gloamFog(gl_FragColor.rgb, vFogW.xz, ${kind === "floor" ? "1.0" : "0.0"}, vFogAcross);`,
      );
  };
  m.needsUpdate = true;
  return m;
}
