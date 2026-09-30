import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector3 } from "three";
import { prefersReducedMotion, useSettings } from "../state/settings.ts";
import { C, col } from "./colors.ts";
import { boardDiag } from "./diag.ts";
import { disposeLater } from "./dispose.ts";
import { frameDelta, setAmbient } from "./frames.ts";
import { keyLightDirection } from "./Lighting.tsx";
import { type Bounds, boundsCenter, boundsSize } from "./scene.ts";

const VERT = /* glsl */ `
attribute vec4 seed; // xyz: drift phases, w: size factor
uniform float uTime; uniform float uScale; uniform vec3 uShaftPoint; uniform vec3 uShaftDir; uniform float uShaftR;
varying float vGlow;
void main() {
  vec3 p = position;
  float t = uTime * 0.05;
  // Slow wandering: each mote on its own loop, a gentle rise and fall, never leaving its neighbourhood.
  p.x += sin(t * 1.7 + seed.x * 6.283) * 1.6 + sin(t * 0.63 + seed.y * 12.0) * 0.8;
  p.z += cos(t * 1.3 + seed.y * 6.283) * 1.6 + sin(t * 0.71 + seed.z * 9.0) * 0.8;
  p.y += sin(t * 0.9 + seed.z * 6.283) * 1.2;
  // Brightest inside the key light's shaft (a column along the light direction through the map's centre).
  vec3 d = p - uShaftPoint;
  float along = dot(d, uShaftDir);
  float off = length(d - uShaftDir * along);
  vGlow = exp(-(off * off) / (uShaftR * uShaftR)) * (0.35 + 0.65 * seed.w);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(uScale * (0.6 + seed.w) / -mv.z, 1.0, 6.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity;
varying float vGlow;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c));
  gl_FragColor = vec4(uColor * a * vGlow * uOpacity, 1.0);
}`;

/**
 * Faint dust motes drifting through the warm key light (SPEC §8.4 Table environment): one Points draw, additive,
 * never written to depth; brightest inside the light's shaft. Counts come from the tier (none on Low). They drift
 * on the board's rendered time, so after an idle pause they carry on instead of jumping, and as ambient motion they
 * get at most 30 frames a second of their own. Reduced motion: they hold still.
 */
export function DustMotes({
  bounds,
  count,
  specimen = false,
}: {
  bounds: Bounds;
  count: number;
  /** The shader warm-up's (warmup/Warmup.tsx): drawn for its program only — not counted, no ambient frames. */
  specimen?: boolean;
}) {
  // Subscribed, so a change in Settings (or the OS preference, on the next render) applies at once.
  const still = useSettings(() => prefersReducedMotion());
  const { x, y } = boundsCenter(bounds);
  const { w, h } = boundsSize(bounds);

  const points = useMemo(() => {
    if (!count) return null;
    const geo = new BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    // Deterministic scatter (no Math.random: the same scene looks the same on every load).
    let s = 0x9e3779b9;
    const rnd = () => {
      s = (s ^ (s << 13)) >>> 0;
      s = (s ^ (s >>> 17)) >>> 0;
      s = (s ^ (s << 5)) >>> 0;
      return s / 4294967296;
    };
    const spanX = Math.max(w, 30) * 0.9;
    const spanZ = Math.max(h, 30) * 0.9;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = x + (rnd() - 0.5) * spanX;
      pos[i * 3 + 1] = 1.5 + rnd() * 16;
      pos[i * 3 + 2] = y + (rnd() - 0.5) * spanZ;
      seed.set([rnd(), rnd(), rnd(), rnd()], i * 4);
    }
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("seed", new BufferAttribute(seed, 4));
    const [dx, dy, dz] = keyLightDirection();
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 120 },
        uColor: { value: col(C.keyLight).clone() },
        uOpacity: { value: 0.55 },
        uShaftPoint: { value: new Vector3(x, 0, y) },
        uShaftDir: { value: new Vector3(dx, dy, dz) },
        uShaftR: { value: Math.max(w, h, 30) * 0.28 },
      },
    });
    const p = new Points(geo, mat);
    p.name = "dust-motes";
    p.frustumCulled = false;
    p.renderOrder = 20;
    return p;
  }, [count, x, y, w, h]);

  useEffect(() => {
    if (!specimen) boardDiag.dust = points ? count : 0;
    if (!points) return;
    return () => {
      points.geometry.dispose();
      disposeLater(points.material as ShaderMaterial);
    };
  }, [points, count, specimen]);

  useEffect(() => {
    if (specimen) return;
    setAmbient("dust", Boolean(points) && !still);
    return () => setAmbient("dust", false);
  }, [points, still, specimen]);

  useFrame(() => {
    if (!points || still) return;
    // Rendered time: an idle pause (on-demand rendering) doesn't make the motes jump.
    const u = (points.material as ShaderMaterial).uniforms.uTime as { value: number };
    u.value += frameDelta();
  });

  return points ? <primitive object={points} /> : null;
}
