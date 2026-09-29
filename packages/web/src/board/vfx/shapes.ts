import type { Footprint } from "@gloam/shared/aoe";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  Group,
  IcosahedronGeometry,
  LineSegments,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  RingGeometry,
} from "three";
import { vfxMaterial } from "./bounds.ts";
import { seeded } from "./particles.ts";

/**
 * The VFX pieces that aren't particles (SPEC §24.5): shells (noise-displaced spheres that swell and thin out — a
 * fireball's heart, a force dome), a burning orb (Flaming Sphere) and the light it throws on the floor, floor rings (a
 * shockwave, frost, a runic circle), pillars of light, fading decals (a scorch, a puddle, a web's strands, thorns, a
 * mist), curtains (flames, or a pane: ice, stone, force) and forked bolts (midpoint displacement). Each is one mesh with
 * its own small shader, driven by `uTime` (s since it began) and `uLife`; `uLoop` for a lasting area's slow motion.
 * Floor pieces take an area's own footprint (`footprintGeometry`) — a cone, a line, a cube, a wall — not a disc round it.
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
uniform float uFacet; uniform float uSoft;
varying float vFres; varying float vN;
void main() {
  float u = uLoop > 0.5 ? 0.5 : clamp(uTime / uLife, 0.0, 1.0);
  float fade = uLoop > 0.5 ? 1.0 : (1.0 - smoothstep(0.45, 1.0, u)) * smoothstep(0.0, 0.08, u);
  // A force shell's facets (a hex-ish lattice from the noise's steps), a fireball's heart hotter at the middle.
  float lattice = uFacet > 0.5 ? step(0.82, fract(vN * 9.0)) * 0.8 : 0.0;
  vec3 col = mix(uCore, uGlow, clamp(vFres + u * 0.6, 0.0, 1.0));
  // A shell's rim is its densest (a bubble of force, a fireball's skin); a cloud's is its thinnest — dense in the
  // middle, thinning to nothing at its edge, never a glassy outline.
  float body = uSoft > 0.5 ? (1.0 - smoothstep(0.1, 0.8, vFres)) * (0.8 + 0.4 * (vN - 0.5)) : mix(0.35, 1.0, vFres);
  float a = (body + lattice) * fade * uOpacity;
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
  /** A cloud: dense in the middle, fading to nothing at its rim (not a bubble's bright skin). */
  soft?: boolean;
}): Mesh {
  const mat = vfxMaterial({
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
      uSoft: { value: o.soft ? 1 : 0 },
    },
  });
  // Finer for a big one (a 20-ft cloud's outline showed its facets at detail 4).
  const m = new Mesh(new IcosahedronGeometry(1, o.radius > 8 ? 5 : 4), mat);
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
uniform float uLoop; uniform float uRunes; uniform float uWidth; uniform float uInward;
varying vec2 vUv; varying vec2 vP;
float hash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
/** A band of width w round r0, anti-aliased by the pixel's footprint (no hard, stepped edges at any zoom). */
float line(float r, float r0, float w) {
  float aa = max(fwidth(r), 1e-4);
  return 1.0 - smoothstep(w, w + aa * 1.5, abs(r - r0));
}
void main() {
  float u = uLoop > 0.5 ? fract(uTime * 0.25) : clamp(uTime / uLife, 0.0, 1.0);
  float r = length(vP) / uRadius;
  // A ring sweeping out (a shockwave, frost), or standing: a runic circle — an outer and an inner line and, between
  // them, a slow-turning band of glyphs (short strokes and dots, each anti-aliased), in the preset's colour.
  float front = uRunes > 0.5 ? 0.93 : uInward > 0.5 ? 1.0 - 0.35 * u : (uLoop > 0.5 ? 0.35 + 0.6 * u : 0.15 + 0.85 * (1.0 - pow(1.0 - u, 2.0)));
  float band = uRunes > 0.5 ? line(r, front, 0.008) : 1.0 - smoothstep(0.0, uWidth, abs(r - front));
  float inner = uRunes > 0.5 ? line(r, 0.77, 0.005) * 0.7 : 0.0;
  float glyphs = 0.0;
  if (uRunes > 0.5) {
    float ang = atan(vP.y, vP.x) + uTime * 0.12;
    float seg = ang * 7.639; // 48 cells round the circle
    float id = floor(seg);
    float c = fract(seg) - 0.5;
    float h = hash(id + 11.0);
    float across = max(fwidth(seg), 1e-4);
    // A stroke across the band (most cells), a dot (some), a gap (a few).
    float stroke = (1.0 - smoothstep(0.06, 0.06 + across * 1.5, abs(c))) * line(r, 0.85, 0.035);
    float dotted = 1.0 - smoothstep(0.1, 0.1 + across * 1.5, length(vec2(c, (r - 0.85) * 7.6)));
    glyphs = h < 0.15 ? 0.0 : h < 0.45 ? dotted : stroke;
  }
  float fade = uLoop > 0.5 ? (uRunes > 0.5 ? 1.0 : 1.0 - u) : 1.0 - smoothstep(0.55, 1.0, u);
  float a = max(max(band, inner), glyphs * 0.75) * fade * uOpacity;
  if (a < 0.004) discard;
  vec3 col = uRunes > 0.5 ? mix(uGlow, uCore, band * 0.5) : mix(uGlow, uCore, band);
  gl_FragColor = vec4(col, a);
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
  /** The area's footprint (from `footprintGeometry`, about the ring's centre): the ring sweeps out inside it. */
  geometry?: BufferGeometry;
  /** Sweeping in from the rim instead (a hush settling: Silence). */
  inward?: boolean;
}): Mesh {
  const mat = vfxMaterial({
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
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
      uInward: { value: o.inward ? 1 : 0 },
    },
  });
  const m = new Mesh(o.geometry ?? new CircleGeometry(o.radius, 96), mat);
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
  float top = 1.0 - smoothstep(0.2, 1.0, vUv.y);
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
  const mat = vfxMaterial({
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

const DECAL_VERT = /* glsl */ `
attribute float edge;
varying vec2 vP; varying float vEdge;
void main() { vP = position.xy; vEdge = edge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DECAL_FRAG = /* glsl */ `
uniform float uTime; uniform float uLife; uniform vec3 uCore; uniform vec3 uGlow; uniform float uOpacity; uniform float uLoop;
uniform float uKind; uniform float uRadius;
varying vec2 vP; varying float vEdge;
${NOISE}
void main() {
  // e: 0 in the footprint's middle, 1 on its edge (a disc's radius, a cone's, a wall's width: its shape, not a circle).
  float e = clamp(1.0 - vEdge, 0.0, 1.0);
  float u = uLoop > 0.5 ? 0.0 : clamp(uTime / uLife, 0.0, 1.0);
  float fade = uLoop > 0.5 ? 1.0 : smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.35, 1.0, u));
  float n = noise(vec3(vP * 0.6, 0.0)) * 0.6 + noise(vec3(vP * 1.7, 3.0)) * 0.4;
  float edge = 1.0 - smoothstep(0.55 + n * 0.35, 1.0, e);
  float a; vec3 col;
  if (uKind < 0.5) {
    // A scorch: charred toward the middle, a glow of embers at its rim while it's fresh.
    a = edge * (0.55 + 0.35 * n);
    col = mix(uCore, uGlow, smoothstep(0.6, 1.0, e) * (1.0 - u));
  } else if (uKind < 1.5) {
    // A puddle (acid): bubbling spots on a slick.
    float spots = step(0.72, noise(vec3(vP * 2.5, uTime * 0.8)));
    a = edge * (0.45 + 0.4 * spots);
    col = mix(uGlow, uCore, spots);
  } else if (uKind < 2.5) {
    // A web's strands: anchor lines out from its middle at irregular angles, threads sagging between them following
    // its edge (a square web in a cube), some broken; thin (anti-aliased), grey-bone, fading toward the middle — no
    // bright knot where they meet.
    float ang = atan(vP.y, vP.x);
    float sect = ang * 1.591549; // 10 sectors
    float si = floor(sect);
    float jitter = (hash(vec3(si, 3.0, 1.0)) - 0.5) * 0.5;
    float sp = abs(fract(sect + jitter) - 0.5) * 2.0;
    float aa = max(fwidth(sect), 1e-4) * 2.0;
    float spokes = 1.0 - smoothstep(0.02, 0.02 + aa, 1.0 - sp);
    float sag = e * 20.0 + sin(fract(sect + jitter) * 3.14159) * 0.6;
    float ringAa = max(fwidth(sag), 1e-4);
    float rings = 1.0 - smoothstep(0.0, ringAa * 1.5, abs(fract(sag) - 0.5) - 0.44);
    float broken = step(0.22, noise(vec3(vP * 1.1, 7.0)));
    float middle = smoothstep(0.02, 0.2, e);
    a = max(spokes * 0.8, rings) * broken * middle * 0.5;
    col = mix(uGlow, uCore, 0.6);
  } else if (uKind < 3.5) {
    // Thorns: dark, jagged strokes scattered through it.
    float t = step(0.78, noise(vec3(vP * 3.3, 11.0))) + step(0.8, noise(vec3(vP.yx * 2.7, 5.0)));
    a = clamp(t, 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, e)) * 0.7;
    col = mix(uGlow, uCore, n);
  } else {
    // A mist lying in it (a light haze over a cube or a line): slow, soft noise, thinning toward its edge.
    float m = noise(vec3(vP * 0.22, uTime * 0.12)) * 0.6 + noise(vec3(vP * 0.6, uTime * 0.2 + 4.0)) * 0.4;
    a = (1.0 - smoothstep(0.45, 1.0, e)) * (0.3 + 0.5 * m);
    col = mix(uGlow, uCore, m);
  }
  a *= fade * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export type DecalKind = "scorch" | "puddle" | "web" | "thorns" | "mist";
const DECAL_KIND: Record<DecalKind, number> = { scorch: 0, puddle: 1, web: 2, thorns: 3, mist: 4 };

/** A decal on the floor: a disc (`radius`) or an area's footprint (`footprintGeometry`, about where it's placed). */
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
  const mat = vfxMaterial({
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
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
  const m = new Mesh(
    o.geometry ?? footprintGeometry({ kind: "circle", c: { x: 0, y: 0 }, r: o.radius }, { x: 0, y: 0 }),
    mat,
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.075;
  m.renderOrder = 9;
  m.raycast = () => {};
  return m;
}

// ── footprints ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * An area's footprint as a flat mesh in a floor piece's plane (x, −y about `at`, where the piece is placed), with an
 * `edge` attribute — 1 in its middle, 0 on its edge — so a scorch, a web, a mist or a sweeping ring follows a cone, a
 * line, a cube or a wall as the rules draw it, not a disc round its centre. Discs and polygons (all convex) are fans
 * from their middle; a wall's strip is a ribbon along its line, at least `minHalf` ft either side (burnt ground).
 */
export function footprintGeometry(f: Footprint, at: { x: number; y: number }, minHalf = 0): BufferGeometry {
  const pos: number[] = [];
  const edge: number[] = [];
  const index: number[] = [];
  const v = (x: number, y: number, e: number) => {
    pos.push(x - at.x, -(y - at.y), 0);
    edge.push(e);
    return edge.length - 1;
  };
  if (f.kind === "strip") {
    const closed = f.closed && f.points.length > 2;
    const pts = closed ? [...f.points, f.points[0] as { x: number; y: number }] : f.points;
    const n = pts.length;
    const half = Math.max(f.halfWidth, minHalf);
    for (let i = 0; i < n; i++) {
      const p = pts[i] as { x: number; y: number };
      // The line's direction here (a closed ring's ends wrap round to each other).
      const q = pts[i < n - 1 ? i + 1 : closed ? 1 : i] as { x: number; y: number };
      const r = pts[i > 0 ? i - 1 : closed ? n - 2 : i] as { x: number; y: number };
      const dx = q.x - r.x;
      const dy = q.y - r.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      v(p.x + nx * half, p.y + ny * half, 0);
      v(p.x, p.y, 1);
      v(p.x - nx * half, p.y - ny * half, 0);
      if (i < n - 1) {
        const a = i * 3;
        index.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
      }
    }
  } else {
    const rim =
      f.kind === "circle"
        ? Array.from({ length: 72 }, (_, i) => {
            const a = (i / 72) * Math.PI * 2;
            return { x: f.c.x + Math.cos(a) * f.r, y: f.c.y + Math.sin(a) * f.r };
          })
        : f.points;
    const c =
      f.kind === "circle"
        ? f.c
        : {
            x: rim.reduce((s, p) => s + p.x, 0) / rim.length,
            y: rim.reduce((s, p) => s + p.y, 0) / rim.length,
          };
    const mid = v(c.x, c.y, 1);
    for (const p of rim) v(p.x, p.y, 0);
    for (let i = 0; i < rim.length; i++) index.push(mid, mid + 1 + i, mid + 1 + ((i + 1) % rim.length));
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("edge", new BufferAttribute(new Float32Array(edge), 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

// ── a burning orb (Flaming Sphere) and the light it throws ───────────────────────────────────────────────

const ORB_VERT = /* glsl */ `
uniform float uTime; uniform float uRadius;
varying float vFres; varying vec3 vObj;
${NOISE}
void main() {
  float n = noise(normal * 6.5 + vec3(0.0, -uTime * 1.8, 0.0)) * 0.6 + noise(normal * 13.0 + vec3(0.0, -uTime * 3.0, 4.0)) * 0.4;
  vec3 p = normal * uRadius * (1.0 + (n - 0.5) * 0.1);
  vObj = normal;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 nv = normalize(normalMatrix * normal);
  vFres = 1.0 - abs(dot(nv, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const ORB_FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uCore; uniform vec3 uGlow; uniform vec3 uEmber; uniform float uOpacity;
varying float vFres; varying vec3 vObj;
${NOISE}
void main() {
  // Flames crawling up over it (two octaves scrolled upward in its own space); hot at its heart, the side facing you,
  // deepening to embers at its limb, the noise breaking the bands into tongues. Normal blending: a ball of fire, not a
  // white bloom on a pale floor.
  vec3 q = vObj * 5.0 + vec3(0.0, -uTime * 2.2, 0.0);
  float n = noise(q) * 0.5 + noise(q * 2.3 + 5.0) * 0.3 + noise(q * 5.1 + 9.0) * 0.2;
  float heat = clamp(1.05 - vFres * 1.25 + (n - 0.5) * 0.7, 0.0, 1.0);
  vec3 col = heat > 0.55 ? mix(uGlow, uCore, (heat - 0.55) / 0.45) : mix(uEmber, uGlow, heat / 0.55);
  float a = (1.0 - smoothstep(0.72, 1.0, vFres + (0.5 - n) * 0.35)) * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;
const HALO_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vQ;
void main() {
  vQ = position.xy;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}`;
const HALO_FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uGlow; uniform float uOpacity;
varying vec2 vQ;
void main() {
  float flick = 0.88 + 0.12 * sin(uTime * 7.3) * sin(uTime * 3.1 + 1.0);
  float a = pow(max(0.0, 1.0 - length(vQ)), 2.2) * uOpacity * flick;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uGlow, a);
  #include <colorspace_fragment>
}`;

/** A burning ball `radius` ft (Flaming Sphere): the orb and, round it, the glow of its heat (a camera-facing halo). */
export function orb(o: {
  radius: number;
  core: string;
  glow: string;
  ember: string;
  opacity?: number;
}): Group {
  const g = new Group();
  const ball = new Mesh(
    new IcosahedronGeometry(1, 4),
    vfxMaterial({
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
      transparent: true,
      depthWrite: false,
      side: FrontSide,
      blending: NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uRadius: { value: o.radius },
        uCore: { value: new Color(o.core) },
        uGlow: { value: new Color(o.glow) },
        uEmber: { value: new Color(o.ember) },
        uOpacity: { value: o.opacity ?? 0.97 },
      },
    }),
  );
  ball.renderOrder = 12;
  const halo = new Mesh(
    new PlaneGeometry(2, 2),
    vfxMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: o.radius * 2.4 },
        uGlow: { value: new Color(o.glow) },
        uOpacity: { value: 0.45 },
      },
    }),
  );
  halo.renderOrder = 11;
  for (const m of [ball, halo]) {
    m.raycast = () => {};
    m.frustumCulled = false;
    g.add(m);
  }
  return g;
}

const GLOW_FRAG = /* glsl */ `
uniform float uTime; uniform float uRadius; uniform vec3 uGlow; uniform float uOpacity; uniform float uFlicker;
varying vec2 vUv; varying vec2 vP;
void main() {
  float r = length(vP) / uRadius;
  float flick = 1.0 - uFlicker * (0.1 + 0.1 * sin(uTime * 6.1) * sin(uTime * 2.3 + 0.7));
  float a = pow(max(0.0, 1.0 - r), 1.8) * uOpacity * flick;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uGlow, a);
  #include <colorspace_fragment>
}`;

/** Light thrown on the floor round something that burns or shines: a soft pool, brightest under it (additive). */
export function glowDisc(o: { radius: number; color: string; opacity?: number; flicker?: boolean }): Mesh {
  const m = new Mesh(
    new CircleGeometry(o.radius, 64),
    vfxMaterial({
      vertexShader: RING_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uRadius: { value: o.radius },
        uGlow: { value: new Color(o.color) },
        uOpacity: { value: o.opacity ?? 0.35 },
        uFlicker: { value: o.flicker ? 1 : 0 },
      },
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.08;
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
  const mat = vfxMaterial({
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

// ── curtains ─────────────────────────────────────────────────────────────────────────────────────────────

const CURTAIN_VERT = /* glsl */ `
attribute float along;
varying vec2 vUv; varying float vAlong;
void main() {
  vUv = uv; vAlong = along;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CURTAIN_FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uCore; uniform vec3 uGlow; uniform vec3 uEmber; uniform float uOpacity; uniform float uLen;
varying vec2 vUv; varying float vAlong;
${NOISE}
void main() {
  // Tongues of flame rising along the line: noise scrolled upward, thinning toward the top; its ends burn down to
  // nothing over a couple of feet (an open wall: no hard, square cut).
  float n = noise(vec3(vAlong * 0.35, vUv.y * 2.2 - uTime * 1.6, uTime * 0.3)) * 0.65
    + noise(vec3(vAlong * 0.9, vUv.y * 5.0 - uTime * 3.1, 7.0)) * 0.35;
  float h = vUv.y;
  float ends = uLen > 0.0 ? smoothstep(0.0, 2.5, vAlong) * smoothstep(0.0, 2.5, uLen - vAlong) : 1.0;
  // Tall and low tongues along it (not one height repeated), and its foot fading into the floor.
  float tall = 0.65 + 0.35 * noise(vec3(vAlong * 0.12, uTime * 0.25, 11.0));
  float h2 = h / tall + (1.0 - ends) * 0.6;
  float body = smoothstep(h2 * 1.15 - 0.05, h2 * 1.15 + 0.25, n) * (1.0 - smoothstep(0.55, 1.0, h2));
  float a = body * uOpacity * ends * smoothstep(0.0, 0.07, h);
  if (a < 0.01) discard;
  // A pale heart at the roots, orange through the body, deepening toward the tips — drawn in its own colours (normal
  // blending), so it reads as fire on a pale floor as on a dark one.
  vec3 col = mix(uCore, uGlow, smoothstep(0.02, 0.4, h));
  col = mix(col, uEmber, smoothstep(0.45, 1.0, h) * 0.55);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

const PANE_FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uCore; uniform vec3 uGlow; uniform float uOpacity; uniform float uSolid;
varying vec2 vUv; varying float vAlong;
${NOISE}
void main() {
  // A sheet standing along the line (ice, stone, thorns, a barrier of force or wind): its body faint for one you can
  // see through, dense for an opaque one, a slow grain drifting in it, its top and foot edged brighter.
  float h = vUv.y;
  float n = noise(vec3(vAlong * 0.4, h * 3.0 - uTime * 0.25, uTime * 0.1)) * 0.7
    + noise(vec3(vAlong * 1.3, h * 9.0, 3.0)) * 0.3;
  float rim = smoothstep(0.94, 1.0, h) + (1.0 - smoothstep(0.0, 0.05, h)) * 0.6;
  float body = mix(0.16, 0.82, uSolid) * (0.75 + 0.25 * n);
  float a = clamp(body + rim * 0.45, 0.0, 1.0) * uOpacity;
  if (a < 0.01) discard;
  vec3 col = mix(uGlow, uCore, clamp(n * 0.6 + rim * 0.4, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

/**
 * A curtain along a line: flames (Wall of Fire, §24.5 "flame curtain along the wall line" — tongues of fire rising in
 * its shader) or a pane (every other wall: ice, stone, thorns, force; `solid` for an opaque one) — a vertical ribbon
 * `height` ft tall over the wall's points, or flat on the floor along it (`floor`); one draw, whatever the tier.
 */
export function curtain(o: {
  points: { x: number; y: number }[];
  closed?: boolean;
  height: number;
  core: string;
  glow: string;
  opacity?: number;
  /** A flat ribbon on the ground instead, this wide (ft): the line burning, seen from above. */
  floor?: number;
  look?: "flame" | "pane";
  /** A pane you can't see through (Wall of Stone, of Thorns). */
  solid?: boolean;
  /** Flames' tips (a deep red): the flame look's third colour. */
  ember?: string;
  /** Light added to what's under it (the burning ground) rather than drawn over it. */
  additive?: boolean;
}): Mesh {
  const pts =
    o.closed && o.points.length > 2 ? [...o.points, o.points[0] as { x: number; y: number }] : o.points;
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const along = new Float32Array(n * 2);
  const index: number[] = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i] as { x: number; y: number };
    if (i > 0) {
      const q = pts[i - 1] as { x: number; y: number };
      d += Math.hypot(p.x - q.x, p.y - q.y);
    }
    // The ribbon's across: up (a curtain), or sideways on the floor (the segment's normal).
    const q = pts[Math.min(n - 1, i + 1)] as { x: number; y: number };
    const r = pts[Math.max(0, i - 1)] as { x: number; y: number };
    const dx = q.x - r.x;
    const dy = q.y - r.y;
    const len = Math.hypot(dx, dy) || 1;
    for (const k of [0, 1] as const) {
      const v = i * 2 + k;
      if (o.floor)
        pos.set(
          [p.x + (-dy / len) * o.floor * (k - 0.5), 0.12, p.y + (dx / len) * o.floor * (k - 0.5)],
          v * 3,
        );
      else pos.set([p.x, k ? o.height : 0.1, p.y], v * 3);
      // On the floor the flames' "height" runs across it, bright down the middle.
      uv.set([d, o.floor ? Math.abs(k - 0.5) * 0.6 : k], v * 2);
      along[v] = d;
    }
    if (i < n - 1) {
      const a = i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setAttribute("along", new BufferAttribute(along, 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  const mat = vfxMaterial({
    vertexShader: CURTAIN_VERT,
    fragmentShader: o.look === "pane" ? PANE_FRAG : CURTAIN_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: o.additive ? AdditiveBlending : NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uCore: { value: new Color(o.core) },
      uGlow: { value: new Color(o.glow) },
      uEmber: { value: new Color(o.ember ?? o.glow) },
      uOpacity: { value: o.opacity ?? 0.9 },
      uSolid: { value: o.solid ? 1 : 0 },
      // Its length (the ends taper); a closed ring has none.
      uLen: { value: o.closed ? -1 : d },
    },
  });
  const m = new Mesh(g, mat);
  m.renderOrder = 11;
  m.raycast = () => {};
  return m;
}
