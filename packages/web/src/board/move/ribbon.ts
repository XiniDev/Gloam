import type { P } from "@gloam/shared/geometry";
import type { MoveWorld } from "@gloam/shared/movement";
import { BufferAttribute, type BufferGeometry, Color, ShaderMaterial } from "three";

/**
 * The movement path line (SPEC §8.6): a ribbon on the floor, 0.6 ft wide, with dashes flowing toward the
 * destination — verdigris, a double dash through difficult terrain; past the budget (or with no way there) a still
 * hatch in --path-over.
 * The geometry is a mitred triangle strip carrying, per vertex, the arc length (for the dashes) and whether that
 * stretch is difficult; the shader animates the dashes.
 */
export const RIBBON_WIDTH_FT = 0.6;
const LIFT = 0.06;

/** Splits a path at difficult-terrain boundaries: [points, difficult flag per piece start]. */
export function difficultPieces(world: MoveWorld | null, points: P[]): { pts: P[]; hard: number[] } {
  if (!world?.regions.length || points.length < 2) return { pts: points, hard: points.map(() => 0) };
  const pts: P[] = [points[0] as P];
  const hard: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as P;
    const b = points[i] as P;
    const ts = [0, ...world.regionCrossings(a, b), 1];
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1] as number;
      const t1 = ts[k] as number;
      if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2;
      hard.push(world.inRegion({ x: a.x + (b.x - a.x) * tm, y: a.y + (b.y - a.y) * tm }) ? 1 : 0);
      pts.push({ x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 });
    }
  }
  hard.push(hard[hard.length - 1] ?? 0);
  return { pts, hard };
}

/** Writes the ribbon for `points` into `geo` (reusing its buffers when they're big enough). */
export function buildRibbon(geo: BufferGeometry, points: P[], hard: number[], width = RIBBON_WIDTH_FT): void {
  const n = points.length;
  const verts = Math.max(0, n * 2);
  const pos = new Float32Array(verts * 3);
  const along = new Float32Array(verts);
  const diff = new Float32Array(verts);
  const side = new Float32Array(verts);
  const index: number[] = [];
  let s = 0;
  const half = width / 2;
  for (let i = 0; i < n; i++) {
    const p = points[i] as P;
    const prev = points[Math.max(0, i - 1)] as P;
    const next = points[Math.min(n - 1, i + 1)] as P;
    if (i > 0) s += Math.hypot(p.x - prev.x, p.y - prev.y);
    // Mitred normal: the average of the neighbouring segments' normals, lengthened to keep the width (capped).
    let nx = 0;
    let ny = 0;
    const add = (a: P, b: P) => {
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l < 1e-9) return;
      nx += -(b.y - a.y) / l;
      ny += (b.x - a.x) / l;
    };
    if (i > 0) add(prev, p);
    if (i < n - 1) add(p, next);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    let miter = 1;
    if (i > 0 && i < n - 1) {
      const l = Math.hypot(next.x - p.x, next.y - p.y) || 1;
      const segNx = -(next.y - p.y) / l;
      const segNy = (next.x - p.x) / l;
      miter = Math.min(3, 1 / Math.max(0.2, nx * segNx + ny * segNy));
    }
    for (const k of [0, 1]) {
      const v = i * 2 + k;
      const sgn = k === 0 ? 1 : -1;
      pos[v * 3] = p.x + nx * half * miter * sgn;
      pos[v * 3 + 1] = LIFT;
      pos[v * 3 + 2] = p.y + ny * half * miter * sgn;
      along[v] = s;
      diff[v] = hard[i] ?? 0;
      side[v] = sgn;
    }
    if (i < n - 1) {
      const a = i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("along", new BufferAttribute(along, 1));
  geo.setAttribute("difficult", new BufferAttribute(diff, 1));
  geo.setAttribute("side", new BufferAttribute(side, 1));
  geo.setIndex(index);
  geo.computeBoundingSphere();
}

const VERT = /* glsl */ `
attribute float along; attribute float difficult; attribute float side;
varying float vAlong; varying float vDiff; varying float vSide;
void main() {
  vAlong = along; vDiff = difficult; vSide = side;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uColor; uniform vec3 uEdge; uniform float uOpacity; uniform float uLength;
uniform float uSolid; uniform float uHatch; uniform float uHalf;
varying float vAlong; varying float vDiff; varying float vSide;
void main() {
  // Dashes 1.2 ft long every 2 ft, flowing toward the destination.
  float phase = fract((vAlong - uTime * 3.0) / 2.0);
  float dash = step(phase, 0.6);
  // Difficult terrain: a double dash (two thin lines along the ribbon's edges) instead of one wide one.
  float across = abs(vSide);
  float twin = step(0.35, across) * step(across, 0.95);
  float body = mix(dash, dash * twin, vDiff);
  body = max(body, uSolid);
  // Past the budget (§8.6, §27.2): a still 45° hatch between two edge rules instead of the flowing dash — a
  // pattern, not only a hue, so the colour-blind palette's split never rests on colour alone.
  float stripe = step(fract((vAlong + vSide * uHalf) / 0.55), 0.45);
  float rules = step(0.72, across);
  body = mix(body, max(stripe, rules), uHatch);
  // Fade in over the first foot and out over the last, so the ends are soft.
  float ends = smoothstep(0.0, 1.0, vAlong) * smoothstep(0.0, 0.6, uLength - vAlong);
  float edge = smoothstep(0.75, 1.0, across);
  vec3 col = mix(uColor, uEdge, edge * 0.5);
  gl_FragColor = vec4(col, body * uOpacity * ends);
  // Out in the output's colour space, as three's own materials are: without it the linear colour reads dark and
  // oversaturated beside the HUD's --path-ok (critic P8 r1 #25).
  #include <colorspace_fragment>
}`;

export function createRibbonMaterial(color: string, edge: string, hatch = false): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(color) },
      uEdge: { value: new Color(edge) },
      uOpacity: { value: 0.95 },
      uLength: { value: 1 },
      uSolid: { value: 0 },
      uHatch: { value: hatch ? 1 : 0 },
      uHalf: { value: RIBBON_WIDTH_FT / 2 },
    },
  });
}
