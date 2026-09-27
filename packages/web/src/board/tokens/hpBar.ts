import { Color, DoubleSide, ShaderMaterial } from "three";
import { C, col, hpColor } from "../colors.ts";

export const GHOST_HOLD_MS = 400;
export const GHOST_DRAIN_MS = 600;

/**
 * The HP ghost (SPEC §8.5, AC-TOK-05): when damage lands, a pale segment lingers where the fill was for 400 ms, then
 * drains to the new value over 600 ms. Stacked hits extend the ghost from wherever it currently is; healing has no
 * ghost.
 */
export class HpGhost {
  private frac = -1;
  private from = 0;
  private start = 0;

  update(frac: number, now: number): number {
    if (this.frac < 0) {
      this.frac = frac;
      return frac;
    }
    if (frac < this.frac - 1e-6) {
      this.from = Math.max(this.value(now), this.frac);
      this.start = now;
    } else if (frac > this.frac + 1e-6) {
      this.start = 0;
    }
    this.frac = frac;
    return this.value(now);
  }

  value(now: number): number {
    if (!this.start) return this.frac;
    const t = now - this.start;
    if (t < GHOST_HOLD_MS) return this.from;
    if (t < GHOST_HOLD_MS + GHOST_DRAIN_MS)
      return this.from + (this.frac - this.from) * ((t - GHOST_HOLD_MS) / GHOST_DRAIN_MS);
    this.start = 0;
    return this.frac;
  }
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const FRAG = /* glsl */ `
uniform float uFrac; uniform float uTemp; uniform float uGhost; uniform float uOpacity; uniform float uStripe;
uniform vec3 uFill; uniform vec3 uTempC; uniform vec3 uGhostC; uniform vec3 uBg; uniform vec3 uEdge;
varying vec2 vUv;
void main() {
  // The bar spans max(hpMax, hp + temp): temp HP is its own segment after the fill.
  float denom = max(1.0, uFrac + uTemp);
  float x = vUv.x;
  float f = uFrac / denom;
  float t = (uFrac + uTemp) / denom;
  float g = max(uGhost, uFrac) / denom;
  vec3 c = uBg;
  if (x < f) {
    c = uFill;
    // Colour-blind mode stripes the low-HP fill (SPEC §27.2).
    if (uStripe > 0.5) c *= mix(0.7, 1.0, step(0.5, fract(vUv.x * 26.0 + vUv.y * 2.5)));
  } else if (x < t) c = uTempC;
  else if (x < g) c = uGhostC;
  float tick = 1.0 - smoothstep(0.0, 0.007, abs(x - 0.5 / denom));
  c = mix(c, uEdge, tick * 0.85);
  float border = max(max(step(vUv.y, 0.14), step(0.86, vUv.y)), max(step(x, 0.012), step(0.988, x)));
  c = mix(c, uEdge, border * 0.9);
  gl_FragColor = vec4(c, 0.96 * uOpacity);
  #include <colorspace_fragment>
}`;

export function createHpBarMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uFrac: { value: 1 },
      uTemp: { value: 0 },
      uGhost: { value: 1 },
      uOpacity: { value: 1 },
      uStripe: { value: 0 },
      uFill: { value: new Color() },
      uTempC: { value: col(C.ice300) },
      uGhostC: { value: col(C.hpGhost) },
      uBg: { value: col(C.ink900) },
      uEdge: { value: col(C.ink950) },
    },
  });
}

export function setHpBar(
  m: ShaderMaterial,
  v: { frac: number; temp: number; ghost: number; opacity: number },
  colorBlind: boolean,
): void {
  const u = m.uniforms as Record<string, { value: unknown }>;
  (u.uFrac as { value: number }).value = v.frac;
  (u.uTemp as { value: number }).value = v.temp;
  (u.uGhost as { value: number }).value = v.ghost;
  (u.uOpacity as { value: number }).value = v.opacity;
  (u.uStripe as { value: number }).value = colorBlind && v.frac <= 0.25 ? 1 : 0;
  (u.uFill as { value: Color }).value.copy(col(hpColor(v.frac, colorBlind)));
}
