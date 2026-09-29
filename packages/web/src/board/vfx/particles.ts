import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  NormalBlending,
  Points,
  ShaderMaterial,
} from "three";

/**
 * The particle engine (SPEC §24.5): one Points draw per burst, each particle's path computed in the vertex shader from
 * its spawn data and the time — p = p0 + v0·t + ½·g·t² (with a swirl about its emitter's axis where one is asked) —
 * its size and alpha over its normalised life from three-key curves, its colour from the preset's core toward its glow
 * as it ages. Additive for fire, light and sparks; normal blending for smoke and clouds (they darken, not glow).
 * Deterministic from a seed: every viewer sees the same shapes.
 */

export interface EmitterSpec {
  count: number;
  /** Where a particle starts (scene ft, y up), given its index and a random in [0, 1). */
  origin: (i: number, r: () => number) => [number, number, number];
  /** Its velocity (ft/s). */
  velocity: (i: number, r: () => number) => [number, number, number];
  /** Life range (s) and start delay range (s). */
  life: [number, number];
  delay?: [number, number];
  /** Size in world ft at its largest. */
  size: [number, number];
  /** How it grows and fades over its life: values at 0, ½, 1. */
  sizeCurve?: [number, number, number];
  alphaCurve?: [number, number, number];
  /** 0: core colour throughout; 1: core to glow as it ages. */
  colorShift?: number;
  /** Swirl about the vertical through `swirlAt` (rad/s), for motes circling a creature. */
  swirl?: number;
}

const VERT = /* glsl */ `
attribute vec3 aVel; attribute vec4 aTime; attribute vec2 aSize; attribute vec3 aSwirl;
uniform float uTime; uniform float uGravity; uniform vec3 uSizeCurve; uniform vec3 uAlphaCurve; uniform float uLoop;
uniform float uPx;
varying float vAlpha; varying float vAge; varying float vShift;
float curve(vec3 k, float t) { return t < 0.5 ? mix(k.x, k.y, t * 2.0) : mix(k.y, k.z, t * 2.0 - 1.0); }
void main() {
  float birth = aTime.x; float life = aTime.y;
  float t = uTime - birth;
  if (uLoop > 0.5) t = mod(t, life + aTime.z);
  float u = t / life;
  if (t < 0.0 || u > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
  vec3 p = position + aVel * t + vec3(0.0, -0.5 * uGravity * t * t, 0.0);
  if (aSwirl.z != 0.0) {
    // Circling the swirl's centre (aSwirl.xy in x, z) at its angular speed.
    vec2 rel = p.xz - aSwirl.xy;
    float a = aSwirl.z * t;
    p.xz = aSwirl.xy + vec2(rel.x * cos(a) - rel.y * sin(a), rel.x * sin(a) + rel.y * cos(a));
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float size = mix(aSize.x, aSize.y, aTime.w) * curve(uSizeCurve, u);
  gl_PointSize = clamp(uPx * size / -mv.z, 0.0, 256.0);
  gl_Position = projectionMatrix * mv;
  vAlpha = curve(uAlphaCurve, u);
  vAge = u;
  vShift = aTime.w;
}`;

const FRAG = /* glsl */ `
uniform vec3 uCore; uniform vec3 uGlow; uniform float uColorShift; uniform float uOpacity; uniform float uSoft;
varying float vAlpha; varying float vAge; varying float vShift;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = (1.0 - smoothstep(uSoft, 1.0, d)) * vAlpha * uOpacity;
  if (a < 0.003) discard;
  vec3 col = mix(uCore, uGlow, clamp(vAge * uColorShift + vShift * 0.15, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

/** A small, fast, seeded random (xorshift): the same seed, the same burst everywhere. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export interface ParticleOptions {
  core: string;
  glow: string;
  /** Additive (light) or normal (smoke). */
  additive?: boolean;
  gravity?: number;
  opacity?: number;
  /** Where the soft edge starts (0: all soft, 0.9: a hard dot). */
  soft?: number;
  /** Repeats forever (a lasting area's loop) instead of playing once. */
  loop?: boolean;
  seed?: number;
  /** Swirl centre (x, z) for emitters with a swirl. */
  swirlAt?: [number, number];
}

/** Builds one burst's particles (one draw); dispose its geometry and material when it's done. */
export function particleBurst(emitters: EmitterSpec[], o: ParticleOptions, scale = 1): Points {
  const r = seeded(o.seed ?? 1);
  const counts = emitters.map((e) => Math.max(1, Math.round(e.count * scale)));
  const n = counts.reduce((a, b) => a + b, 0);
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const time = new Float32Array(n * 4);
  const size = new Float32Array(n * 2);
  const swirl = new Float32Array(n * 3);
  let k = 0;
  const curves: { size: [number, number, number]; alpha: [number, number, number]; shift: number } = {
    size: emitters[0]?.sizeCurve ?? [0.6, 1, 0.8],
    alpha: emitters[0]?.alphaCurve ?? [0, 1, 0],
    shift: emitters[0]?.colorShift ?? 1,
  };
  emitters.forEach((e, ei) => {
    for (let i = 0; i < (counts[ei] as number); i++, k++) {
      pos.set(e.origin(i, r), k * 3);
      vel.set(e.velocity(i, r), k * 3);
      const [l0, l1] = e.life;
      const [d0, d1] = e.delay ?? [0, 0];
      time.set([d0 + (d1 - d0) * r(), l0 + (l1 - l0) * r(), (d1 - d0) * r(), r()], k * 4);
      size.set(e.size, k * 2);
      swirl.set([o.swirlAt?.[0] ?? 0, o.swirlAt?.[1] ?? 0, e.swirl ?? 0], k * 3);
    }
  });
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("aVel", new BufferAttribute(vel, 3));
  geo.setAttribute("aTime", new BufferAttribute(time, 4));
  geo.setAttribute("aSize", new BufferAttribute(size, 2));
  geo.setAttribute("aSwirl", new BufferAttribute(swirl, 3));
  const mat = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: o.additive === false ? NormalBlending : AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uGravity: { value: o.gravity ?? 0 },
      uSizeCurve: { value: curves.size },
      uAlphaCurve: { value: curves.alpha },
      uColorShift: { value: curves.shift },
      uCore: { value: new Color(o.core) },
      uGlow: { value: new Color(o.glow) },
      uOpacity: { value: o.opacity ?? 1 },
      uSoft: { value: o.soft ?? 0.2 },
      uLoop: { value: o.loop ? 1 : 0 },
      uPx: { value: 900 },
    },
  });
  const pts = new Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 12;
  pts.raycast = () => {};
  return pts;
}

/** Sets a burst's clock (seconds since it began) and its pixel scale (the viewport's height). */
export function tickParticles(p: Points, t: number, viewportHeightPx: number): void {
  const u = (p.material as ShaderMaterial).uniforms;
  (u.uTime as { value: number }).value = t;
  // A world ft at 1 ft from the camera is about half the viewport tall at the board's 40° field of view.
  (u.uPx as { value: number }).value = viewportHeightPx * 1.37;
}
