import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  IcosahedronGeometry,
  LineSegments,
  Mesh,
  NormalBlending,
  RingGeometry,
  ShaderMaterial,
} from "three";
import { seeded } from "./particles.ts";

/**
 * The VFX pieces that aren't particles (SPEC §24.5): shells (noise-displaced spheres that swell and thin out — a
 * fireball's heart, a force dome), floor rings (a shockwave, frost, a runic circle), pillars of light, fading decals (a
 * scorch, a puddle, a web's strands, thorns), and forked bolts (midpoint displacement). Each is one mesh with its own
 * small shader, driven by `uTime` (s since it began) and `uLife`; `uLoop` for a lasting area's slow motion.
 */

const NOISE = /* glsl */ `
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

// ── shells ───────────────────────────────────────────────────────────────────────────────────────────────

const SHELL_VERT = /* glsl */ `
uniform float uTime; uniform float uLife; uniform float uRadius; uniform float uRough; uniform float uLoop;
varying float vFres; varying float vN;
${NOISE}
void main() {
  float u = uLoop > 0.5 ? 1.0 : clamp(uTime / uLife, 0.0, 1.0);
  float grow = uLoop > 0.5 ? 1.0 : 1.0 - pow(1.0 - u, 3.0);
  float n = noise(normal * 2.3 + vec3(uTime * 0.9));
  vN = n;
  vec3 p = normal * uRadius * (0.35 + 0.65 * grow) * (1.0 + (n - 0.5) * uRough);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 nv = normalize(normalMatrix * normal);
  vFres = pow(1.0 - abs(dot(nv, normalize(-mv.xyz))), 1.6);
  gl_Position = projectionMatrix * mv;
}`;
const SHELL_FRAG = /* glsl */ `
uniform float uTime; uniform float uLife; uniform vec3 uCore; uniform vec3 uGlow; uniform float uOpacity; uniform float uLoop;
uniform float uFacet;
varying float vFres; varying float vN;
void main() {
  float u = uLoop > 0.5 ? 0.5 : clamp(uTime / uLife, 0.0, 1.0);
  float fade = uLoop > 0.5 ? 1.0 : (1.0 - smoothstep(0.45, 1.0, u)) * smoothstep(0.0, 0.08, u);
  // A force shell's facets (a hex-ish lattice from the noise's steps), a fireball's heart hotter at the middle.
  float lattice = uFacet > 0.5 ? step(0.82, fract(vN * 9.0)) * 0.8 : 0.0;
  vec3 col = mix(uCore, uGlow, clamp(vFres + u * 0.6, 0.0, 1.0));
  float a = (mix(0.35, 1.0, vFres) + lattice) * fade * uOpacity;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export function shell(o: {
  radius: number;
  life: number;
  core: string;
  glow: string;
  rough?: number;
  opacity?: number;
  facet?: boolean;
  loop?: boolean;
  additive?: boolean;
}): Mesh {
  const mat = new ShaderMaterial({
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: o.additive === false ? NormalBlending : AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: o.life },
      uRadius: { value: o.radius },
      uRough: { value: o.rough ?? 0.35 },
      uCore: { value: new Color(o.core) },
      uGlow: { value: new Color(o.glow) },
      uOpacity: { value: o.opacity ?? 0.9 },
      uLoop: { value: o.loop ? 1 : 0 },
      uFacet: { value: o.facet ? 1 : 0 },
    },
  });
  const m = new Mesh(new IcosahedronGeometry(1, 4), mat);
  m.renderOrder = 11;
  m.raycast = () => {};
  m.frustumCulled = false;
  return m;
}

// ── rings on the floor ───────────────────────────────────────────────────────────────────────────────────

const RING_VERT = /* glsl */ `
varying vec2 vUv; varying vec2 vP;
void main() { vUv = uv; vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FRAG = /* glsl */ `
uniform float uTime; uniform float uLife; uniform float uRadius; uniform vec3 uCore; uniform vec3 uGlow; uniform float uOpacity;
uniform float uLoop; uniform float uRunes; uniform float uWidth;
varying vec2 vUv; varying vec2 vP;
float hash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
void main() {
  float u = uLoop > 0.5 ? fract(uTime * 0.25) : clamp(uTime / uLife, 0.0, 1.0);
  float r = length(vP) / uRadius;
  // A ring sweeping out (a shockwave, frost) or standing (a runic circle) with a band of glyph ticks.
  float front = uRunes > 0.5 ? 0.92 : (uLoop > 0.5 ? 0.35 + 0.6 * u : 0.15 + 0.85 * (1.0 - pow(1.0 - u, 2.0)));
  float band = 1.0 - smoothstep(0.0, uWidth, abs(r - front));
  float inner = uRunes > 0.5 ? (1.0 - smoothstep(0.0, 0.012, abs(r - 0.78))) * 0.8 : 0.0;
  float ang = atan(vP.y, vP.x) + uTime * (uRunes > 0.5 ? 0.25 : 0.0);
  float ticks = uRunes > 0.5 ? step(0.55, hash(floor(ang * 9.549))) * step(0.8, r) * step(r, 0.9) : 0.0;
  float fade = uLoop > 0.5 ? (uRunes > 0.5 ? 1.0 : 1.0 - u) : 1.0 - smoothstep(0.55, 1.0, u);
  float a = max(max(band, inner), ticks * 0.9) * fade * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uGlow, uCore, band), a);
  #include <colorspace_fragment>
}`;

export function floorRing(o: {
  radius: number;
  life: number;
  core: string;
  glow: string;
  opacity?: number;
  runes?: boolean;
  loop?: boolean;
  width?: number;
}): Mesh {
  const mat = new ShaderMaterial({
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: o.life },
      uRadius: { value: o.radius },
      uCore: { value: new Color(o.core) },
      uGlow: { value: new Color(o.glow) },
      uOpacity: { value: o.opacity ?? 0.9 },
      uLoop: { value: o.loop ? 1 : 0 },
      uRunes: { value: o.runes ? 1 : 0 },
      uWidth: { value: o.width ?? 0.06 },
    },
  });
  const m = new Mesh(new CircleGeometry(o.radius, 96), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.09;
  m.renderOrder = 10;
  m.raycast = () => {};
  return m;
}

// ── pillars of light ─────────────────────────────────────────────────────────────────────────────────────

const PILLAR_VERT = /* glsl */ `
varying vec2 vUv; varying float vFres;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 nv = normalize(normalMatrix * normal);
  vFres = 1.0 - abs(dot(nv, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const PILLAR_FRAG = /* glsl */ `
uniform float uTime; uniform float uLife; uniform vec3 uCore; uniform vec3 uGlow; uniform float uOpacity; uniform float uLoop;
varying vec2 vUv; varying float vFres;
void main() {
  float u = uLoop > 0.5 ? 0.5 : clamp(uTime / uLife, 0.0, 1.0);
  float fade = uLoop > 0.5 ? 0.8 + 0.2 * sin(uTime * 1.3) : smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.5, 1.0, u));
  float top = 1.0 - smoothstep(0.55, 1.0, vUv.y);
  float shimmer = 0.85 + 0.15 * sin(vUv.y * 40.0 - uTime * 6.0);
  float a = (0.25 + 0.75 * (1.0 - vFres)) * top * fade * shimmer * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uGlow, uCore, 1.0 - vFres), a);
  #include <colorspace_fragment>
}`;

export function pillar(o: {
  radius: number;
  height: number;
  life: number;
  core: string;
  glow: string;
  opacity?: number;
  loop?: boolean;
}): Mesh {
  const mat = new ShaderMaterial({
    vertexShader: PILLAR_VERT,
    fragmentShader: PILLAR_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: o.life },
      uCore: { value: new Color(o.core) },
      uGlow: { value: new Color(o.glow) },
      uOpacity: { value: o.opacity ?? 0.8 },
      uLoop: { value: o.loop ? 1 : 0 },
    },
  });
  const g = new CylinderGeometry(o.radius, o.radius, o.height, 48, 1, true);
  g.translate(0, o.height / 2, 0);
  const m = new Mesh(g, mat);
  m.renderOrder = 11;
  m.raycast = () => {};
  return m;
}

// ── decals ───────────────────────────────────────────────────────────────────────────────────────────────

const DECAL_FRAG = /* glsl */ `
uniform float uTime; uniform float uLife; uniform vec3 uCore; uniform vec3 uGlow; uniform float uOpacity; uniform float uLoop;
uniform float uKind; uniform float uRadius;
varying vec2 vUv; varying vec2 vP;
${NOISE}
void main() {
  float r = length(vP) / uRadius;
  float u = uLoop > 0.5 ? 0.0 : clamp(uTime / uLife, 0.0, 1.0);
  float fade = uLoop > 0.5 ? 1.0 : smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.35, 1.0, u));
  float n = noise(vec3(vP * 0.6, 0.0)) * 0.6 + noise(vec3(vP * 1.7, 3.0)) * 0.4;
  float edge = 1.0 - smoothstep(0.55 + n * 0.35, 1.0, r);
  float a; vec3 col;
  if (uKind < 0.5) {
    // A scorch: charred toward the middle, a glow of embers at its rim while it's fresh.
    a = edge * (0.55 + 0.35 * n);
    col = mix(uCore, uGlow, smoothstep(0.6, 1.0, r) * (1.0 - u));
  } else if (uKind < 1.5) {
    // A puddle (acid): bubbling spots on a slick.
    float spots = step(0.72, noise(vec3(vP * 2.5, uTime * 0.8)));
    a = edge * (0.45 + 0.4 * spots);
    col = mix(uGlow, uCore, spots);
  } else if (uKind < 2.5) {
    // A web's strands: radial spokes and rings, a few broken.
    float ang = atan(vP.y, vP.x);
    float spokes = 1.0 - smoothstep(0.0, 0.06, abs(sin(ang * 8.0)));
    float rings = 1.0 - smoothstep(0.0, 0.08, abs(sin(r * 26.0)));
    float broken = step(0.25, noise(vec3(vP * 1.1, 7.0)));
    a = max(spokes, rings) * broken * step(r, 1.0) * 0.55;
    col = uCore;
  } else {
    // Thorns: dark, jagged strokes scattered through it.
    float t = step(0.78, noise(vec3(vP * 3.3, 11.0))) + step(0.8, noise(vec3(vP.yx * 2.7, 5.0)));
    a = clamp(t, 0.0, 1.0) * step(r, 1.0) * 0.7;
    col = mix(uGlow, uCore, n);
  }
  a *= fade * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export type DecalKind = "scorch" | "puddle" | "web" | "thorns";
const DECAL_KIND: Record<DecalKind, number> = { scorch: 0, puddle: 1, web: 2, thorns: 3 };

/** A decal on the floor: a disc (`radius`) or any flat shape given as its geometry. */
export function decal(o: {
  kind: DecalKind;
  radius: number;
  life: number;
  core: string;
  glow: string;
  opacity?: number;
  loop?: boolean;
  geometry?: BufferGeometry;
}): Mesh {
  const mat = new ShaderMaterial({
    vertexShader: RING_VERT,
    fragmentShader: DECAL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: o.life },
      uCore: { value: new Color(o.core) },
      uGlow: { value: new Color(o.glow) },
      uOpacity: { value: o.opacity ?? 0.85 },
      uLoop: { value: o.loop ? 1 : 0 },
      uKind: { value: DECAL_KIND[o.kind] },
      uRadius: { value: o.radius },
    },
  });
  const m = new Mesh(o.geometry ?? new CircleGeometry(o.radius, 64), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.075;
  m.renderOrder = 9;
  m.raycast = () => {};
  return m;
}

// ── bolts ────────────────────────────────────────────────────────────────────────────────────────────────

/** A forked bolt from a to b (midpoint displacement, with a branch or two), as line segments. */
export function boltGeometry(
  a: [number, number, number],
  b: [number, number, number],
  seed: number,
): BufferGeometry {
  const r = seeded(seed);
  const pts: [number, number, number][] = [a, b];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  let off = len * 0.18;
  for (let depth = 0; depth < 6; depth++) {
    const next: [number, number, number][] = [pts[0] as [number, number, number]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1] as [number, number, number];
      const q = pts[i] as [number, number, number];
      next.push([
        (p[0] + q[0]) / 2 + (r() - 0.5) * off,
        (p[1] + q[1]) / 2 + (r() - 0.5) * off * 0.6,
        (p[2] + q[2]) / 2 + (r() - 0.5) * off,
      ]);
      next.push(q);
    }
    pts.splice(0, pts.length, ...next);
    off *= 0.55;
  }
  const segs: number[] = [];
  for (let i = 1; i < pts.length; i++) segs.push(...(pts[i - 1] as number[]), ...(pts[i] as number[]));
  // A branch or two off the middle.
  for (let k = 0; k < 2; k++) {
    const at = pts[Math.floor(pts.length * (0.3 + r() * 0.4))] as [number, number, number];
    let prev = at;
    for (let s = 0; s < 6; s++) {
      const p: [number, number, number] = [
        prev[0] + (r() - 0.3) * len * 0.05,
        prev[1] - r() * len * 0.02,
        prev[2] + (r() - 0.5) * len * 0.05,
      ];
      segs.push(...prev, ...p);
      prev = p;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(segs), 3));
  return g;
}

const BOLT_FRAG = /* glsl */ `
uniform float uTime; uniform float uLife; uniform vec3 uCore; uniform float uOpacity;
void main() {
  float u = clamp(uTime / uLife, 0.0, 1.0);
  // Flickers three frames on, then fades (§24.5 "flickers 3 frames").
  float flick = step(0.5, fract(uTime * 18.0));
  float a = (u < 0.25 ? 1.0 : flick * (1.0 - u)) * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCore, a);
  #include <colorspace_fragment>
}`;

export function bolt(
  a: [number, number, number],
  b: [number, number, number],
  o: { life: number; core: string; seed: number },
): LineSegments {
  const mat = new ShaderMaterial({
    vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: BOLT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: o.life },
      uCore: { value: new Color(o.core) },
      uOpacity: { value: 1 },
    },
  });
  const l = new LineSegments(boltGeometry(a, b, o.seed), mat);
  l.renderOrder = 13;
  l.frustumCulled = false;
  l.raycast = () => {};
  return l;
}

/** A ring outline of an area (a lasting one's edge), for shapes the other pieces don't draw. */
export function ringGeometry(inner: number, outer: number): RingGeometry {
  return new RingGeometry(inner, outer, 96);
}
