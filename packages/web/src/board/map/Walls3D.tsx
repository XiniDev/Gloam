import type { P } from "@gloam/shared/geometry";
import type { WallView } from "@gloam/shared/state";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  type Float32BufferAttribute,
  FrontSide,
  type Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MathUtils,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  ShapeUtils,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import { useTable } from "../../net/table.ts";
import { boardData, useBoard, useEntities } from "../../state/entities.ts";
import { useUi } from "../../state/ui.ts";
import { useDmView } from "../../state/viewAs.ts";
import { boardApi } from "../boardApi.ts";
import { cameraRig } from "../CameraRig.tsx";
import { C, col } from "../colors.ts";
import { again } from "../frames.ts";
import { NOISE_GLSL } from "../glsl.ts";
import { useTier } from "../tiers.ts";
import { useWallTool } from "../tools/walls.ts";
import { withFog } from "../vision/fogMaterial.ts";
import { useDrawn, useWarming } from "../warmup/state.ts";
import { findPillars, pillarPrism } from "./pillars.ts";

/**
 * Walls in 3D (SPEC §8.7 3D walls; AC-WAL-06): with the scene's toggle on, walls stand 8 ft tall in procedural
 * masonry, doors are hinged wooden leaves that swing open and shut over 300 ms (under a stone lintel), windows are
 * thin glass with a faint fresnel sheen between a sill and a header, curtains hang in folds. For DMs a secret door is a
 * stone leaf, hidden walls are translucent ghosts and invisible walls a faint field; players get no geometry for
 * what they aren't meant to see — an occluder (a hidden wall that blocks sight) is never extruded, or it would
 * reveal itself. A small closed loop of walls is a pillar: one solid prism, not four walls round a hollow.
 *
 * All the stone is one instanced mesh (one draw call however many walls); its masonry is a function of the world
 * position, so walls meeting at a joint continue the same courses. The materials are made once for the page, so
 * toggling the scene or redrawing walls never recompiles a shader.
 */

export const WALL_HEIGHT_FT = 8;
const THICK = 0.75;
const DOOR_TOP = 7;
const SILL = 3;
const LINTEL = 7;
const LEAF = 0.18;
export const DOOR_SWING_MS = 300;
const OPEN_DEG = 88;

interface Box {
  a: P;
  b: P;
  y0: number;
  y1: number;
  thick: number;
  /** Stretch past both ends (joints close up). */
  extend: number;
  /** What its top shows from above: plain stone, a door's lintel (wood), a window's header (glass). */
  cap?: 0 | 1 | 2;
}

type Around = readonly [number, number, number, number];

/** How a pillar's top is graded: from the best-seen of four points just outside it, beyond its walls. */
function aroundOf(poly: readonly P[]): Around {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + THICK + 0.6, (y1 - y0) / 2 + THICK + 0.6];
}
interface Door {
  id: string;
  a: P;
  b: P;
  open: boolean;
  locked: boolean;
  stone: boolean;
}
interface Pieces {
  stone: Box[];
  ghost: Box[];
  glass: Box[];
  curtains: { id: string; a: P; b: P }[];
  fields: { id: string; a: P; b: P }[];
  doors: Door[];
  /** Pillars (small closed loops of solid wall): each one solid prism instead of its walls. */
  pillars: P[][];
}

/** What each wall becomes in 3D, for this viewer. */
export function wallPieces(
  walls: Iterable<WallView>,
  dm: boolean,
  moved?: ReadonlyMap<string, { a: P; b: P }> | null,
): Pieces {
  const out: Pieces = { stone: [], ghost: [], glass: [], curtains: [], fields: [], doors: [], pillars: [] };
  const solid: { a: P; b: P; box: Box }[] = [];
  for (const w of walls) {
    const m = moved?.get(w.id);
    const a = m ? m.a : { x: w.ax, y: w.ay };
    const b = m ? m.b : { x: w.bx, y: w.by };
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.05) continue;
    const kind = dm ? (w.dmKind ?? w.kind) : w.kind;
    const door = (dm ? w.dmDoor || w.door : w.door) || "closed";
    // Hidden walls: DMs see a ghost; players never get them as geometry (an occluder included).
    if (dm && w.dmHidden) {
      if (kind !== "invisible")
        out.ghost.push({ a, b, y0: 0, y1: WALL_HEIGHT_FT, thick: THICK, extend: THICK / 2 });
      continue;
    }
    if (kind === "occluder") continue;
    if (kind === "wall") {
      const box: Box = { a, b, y0: 0, y1: WALL_HEIGHT_FT, thick: THICK, extend: THICK / 2 };
      out.stone.push(box);
      solid.push({ a, b, box });
    } else if (kind === "door" || kind === "secret") {
      out.stone.push({ a, b, y0: LINTEL, y1: WALL_HEIGHT_FT, thick: THICK, extend: 0, cap: 1 });
      out.doors.push({
        id: w.id,
        a,
        b,
        open: door === "open",
        locked: door === "locked",
        stone: kind === "secret",
      });
    } else if (kind === "window") {
      out.stone.push({ a, b, y0: 0, y1: SILL, thick: THICK, extend: THICK / 2 });
      out.stone.push({ a, b, y0: LINTEL, y1: WALL_HEIGHT_FT, thick: THICK, extend: THICK / 2, cap: 2 });
      out.glass.push({ a, b, y0: SILL, y1: LINTEL, thick: 0.06, extend: 0 });
    } else if (kind === "curtain") out.curtains.push({ id: w.id, a, b });
    else if (kind === "invisible" && dm) out.fields.push({ id: w.id, a, b });
  }
  // A pillar's walls give way to its prism: walls overlapping at its corners put an end face in the plane of the next
  // wall's side (they fought) and left a hollow to fill.
  const pillars = findPillars(solid);
  if (pillars.length) {
    const gone = new Set(pillars.flatMap((p) => p.members.map((i) => (solid[i] as { box: Box }).box)));
    out.stone = out.stone.filter((b) => !gone.has(b));
    out.pillars = pillars.map((p) => p.loop);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ materials (once)

const MASONRY_GLSL = /* glsl */ `
uniform vec3 uStoneA; uniform vec3 uStoneB; uniform vec3 uJoint; uniform vec3 uPlank; uniform vec3 uGlass;
varying vec3 vWall; varying float vAlong; varying float vTop; varying float vCap; varying vec3 vLocal;
${NOISE_GLSL}
// Ashlar courses 1 ft high, blocks 1.8 ft long, every course offset; mortar joints; per-block tint and grime low down.
// Filtered by the pattern's footprint on screen: joints widen and fade, fine noise fades, where a pixel covers more
// than a joint's width (grazing faces, distance) — they shimmered into speckle otherwise.
vec3 masonry(float u, float v, out float mortar) {
  vec2 fw = fwidth(vec2(u, v));
  float px = max(fw.x, fw.y);
  float row = floor(v);
  float x = u + g_hash(vec2(row, 3.1)) * 1.8;
  float cell = floor(x / 1.8);
  vec2 local = vec2(fract(x / 1.8) * 1.8, fract(v));
  float edge = min(min(local.x, 1.8 - local.x), min(local.y, 1.0 - local.y));
  mortar = (1.0 - smoothstep(0.035 - px, 0.075 + px, edge)) * (1.0 - smoothstep(0.12, 0.4, px));
  float h = g_hash(vec2(cell, row));
  vec3 c = mix(uStoneA, uStoneB, 0.25 + 0.55 * h + 0.2 * g_fbm(vec2(u, v) * 1.4));
  c *= 0.86 + 0.22 * mix(g_noise(vec2(u, v) * 5.0), 0.5, smoothstep(0.04, 0.16, px));
  // Contact shadow where the wall meets the floor, and grime in the lowest course.
  c *= mix(0.5, 1.0, smoothstep(0.0, 1.1, v)) * mix(0.9, 1.0, smoothstep(0.0, 2.4, v));
  return mix(c, uJoint, mortar);
}
// The wall's top: capstones laid along the wall, 1.5 ft long, with fine joints across it (overlapping tops at a joint
// sit at slightly different heights, so the nearer one simply covers the other).
vec3 capstone(float u, vec2 p, float cap, vec3 local, out float mortar) {
  float px = fwidth(u);
  float q = u / 1.5;
  float f = fract(q);
  mortar = (1.0 - smoothstep(0.02 - px, 0.045 + px, min(f, 1.0 - f) * 1.5)) * 0.7 * (1.0 - smoothstep(0.12, 0.4, px));
  // Well darker than the floor, so a wall reads as a wall from straight above...
  vec3 c = mix(uStoneA, uStoneB, 0.3 + 0.3 * g_hash(vec2(floor(q), 5.0)) + 0.1 * g_noise(p * 3.0)) * 0.5;
  // ...a door's lintel as its oak beam, a window's header with a strip of glass along it...
  if (cap > 1.5) c = mix(c, uGlass, smoothstep(0.2, 0.12, abs(local.z)) * 0.85);
  else if (cap > 0.5) { c = mix(uPlank, uPlank * 1.35, g_noise(vec2(u * 2.0, local.z * 9.0))); mortar = 0.0; }
  c = mix(c, uJoint, mortar);
  // ...with a lighter bevel along its long edges catching the light, and an ink rim outside it: from above every wall
  // has a crisp dark outline on any floor (the precise-measuring top-down view has no overlay to fall back on).
  float e = abs(local.z);
  float bevel = smoothstep(0.32, 0.43, e) * (1.0 - smoothstep(0.44, 0.465, e));
  c = mix(c, uStoneB * 1.1, bevel * 0.45);
  return mix(c, uJoint * 0.55, smoothstep(0.455, 0.49, e));
}
`;

/**
 * The camera cutaway: at a tabletop or low angle an 8-ft wall hides the floor behind it — a token just inside a room's
 * near wall would be invisible. Walls between the camera and the point it looks at are cut down to a 1.2-ft stub,
 * sloping over 2.5 ft from full height; and wherever a wall stands between the camera and a token in view (the
 * viewer's own first, then the selected, then the nearest; up to KEEP_MAX), it is cut down the same way over the
 * stretch that would hide the token's base (8 ft ÷ tan(pitch) toward the camera). Looking straight down nothing is cut.
 *
 * Solid pieces (the stone, a pillar, a door's leaf, glass) are cut by lowering their geometry: each stays a closed
 * box whose top is the cut, drawn as its capstone — no inside to show, no faces inside other pieces laid bare. A piece
 * wholly above the cut there (a lintel over a door) goes. The cut face is unlit: the shadow pass draws the walls uncut,
 * so a lit cut face would lie in its own wall's shadow. Cloth and iron (thin) are clipped. Pillars are cut flat at the
 * height for their centre.
 */
const KEEP_MAX = 16;
export const cutaway = {
  uCutOn: { value: 0 },
  uCutH: { value: 1.2 },
  uCutFull: { value: WALL_HEIGHT_FT + 0.05 },
  uCutGap: { value: 1.5 },
  uCutTarget: { value: new Vector2() },
  uCutDir: { value: new Vector2(0, -1) },
  uCutCam: { value: new Vector2() },
  /** Tokens kept in view: x, z, radius, and how far toward the camera a wall would hide them (ft). */
  uKeep: { value: Array.from({ length: KEEP_MAX }, () => new Vector4()) },
  uKeepN: { value: 0 },
};
const CUT_PITCH_DEG = 75;
/** How bright a cut face is drawn (it's unlit: a share of its stone colour). */
const CUT_FACE_LIGHT = 1.15;
/** Over how far (ft) the cut slopes from full height to the stub. */
const CUT_RAMP_FT = 2.5;

const CUT_GLSL = /* glsl */ `
uniform float uCutOn; uniform float uCutH; uniform float uCutFull; uniform float uCutGap; uniform vec2 uCutTarget;
uniform vec2 uCutDir; uniform vec2 uCutCam; uniform vec4 uKeep[${KEEP_MAX}]; uniform float uKeepN;
#ifdef GLOAM_CUT_AT_C
uniform vec2 uCutAtC;
#endif
// The height things are cut to at a table point (≥ uCutFull: not cut). Near the camera's target: full beyond the gap
// before it, sloping over ${CUT_RAMP_FT} ft to the stub nearer the camera. Near a token in view: down to the stub over
// the stretch between it and the camera that would hide its base, the edges eased over a foot.
float gloamCutHeight(vec2 xz) {
  float d = dot(xz - uCutTarget, uCutDir) + uCutGap;
  float h = mix(uCutH, uCutFull, smoothstep(-${CUT_RAMP_FT.toFixed(1)}, 0.0, d));
  for (int i = 0; i < ${KEEP_MAX}; i++) {
    if (float(i) >= uKeepN) break;
    vec4 k = uKeep[i];
    vec2 to = uCutCam - k.xy;
    float l = length(to);
    if (l < 1e-3) continue;
    vec2 dir = to / l;
    vec2 rel = xz - k.xy;
    float t = dot(rel, dir);
    float s = abs(dot(rel, vec2(-dir.y, dir.x)));
    float inside = (1.0 - smoothstep(k.z + 0.4, k.z + 1.4, s)) * (1.0 - smoothstep(k.w, k.w + 1.0, t))
      * smoothstep(-k.z - 1.0, -k.z, t);
    h = min(h, mix(uCutFull, uCutH, inside));
  }
  return h;
}
`;

/**
 * Adds the cutaway to a material: `unit` / `floor` lower the geometry (a unit box's bottom at −0.5, or a piece standing
 * on the floor at its local y = 0); `cut` clips fragments; `fade` fades them (DM-only fields).
 */
function withCutaway(
  shader: {
    uniforms: Record<string, unknown>;
    vertexShader: string;
    fragmentShader: string;
  },
  mode: "unit" | "floor" | "cut" | "fade",
) {
  Object.assign(shader.uniforms, cutaway);
  const lower = mode === "unit" || mode === "floor";
  const varyings = `varying vec3 vCutW; varying vec2 vCutAt;${lower ? " varying float vCutBottom; varying float vCutCap;" : ""}`;
  const hairAttr =
    mode === "unit"
      ? "\n#if defined(USE_INSTANCING) && defined(GLOAM_HAIR)\nattribute float aHair;\n#endif"
      : "";
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${varyings}${hairAttr}\n${CUT_GLSL}`)
    .replace(
      "#include <begin_vertex>",
      lower
        ? `#include <begin_vertex>
{
  mat4 gm = modelMatrix;
#ifdef USE_INSTANCING
  gm = modelMatrix * instanceMatrix;
#endif
  vec4 gwp = gm * vec4(transformed, 1.0);
  vec2 gat = gwp.xz;
#ifdef GLOAM_CUT_AT_C
  gat = uCutAtC;
#endif
  // Pieces stand upright (turned only about the vertical): world y = gm[1][1] · y + gm[3][1].
  float gbot = gm[1][1] * ${mode === "unit" ? "-0.5" : "0.0"} + gm[3][1];
  float gtop = max(uCutOn > 0.5 ? gloamCutHeight(gat) : uCutFull, gbot);
  vCutBottom = gbot;
  vCutCap = 0.0;
  if (gwp.y > gtop + 1e-4) {
    float hair = 0.0;
#if defined(USE_INSTANCING) && defined(GLOAM_HAIR)
    // Tops overlapping at a joint stay a hair apart, as uncut (StoneBoxes).
    hair = aHair;
#endif
    transformed.y = (gtop + hair - gm[3][1]) / gm[1][1];
    vCutCap = 1.0;
  }
}`
        : "#include <begin_vertex>",
    )
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>
vec4 gcw = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
gcw = instanceMatrix * gcw;
#endif
vCutW = (modelMatrix * gcw).xyz;
vCutAt = vCutW.xz;
#ifdef GLOAM_CUT_AT_C
vCutAt = uCutAtC;
#endif`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${varyings}\n${CUT_GLSL}`)
    .replace(
      mode === "fade" ? "#include <color_fragment>" : "#include <clipping_planes_fragment>",
      mode === "fade"
        ? `#include <color_fragment>
if (uCutOn > 0.5 && vCutW.y > gloamCutHeight(vCutAt)) diffuseColor.a *= 0.2;`
        : lower
          ? `#include <clipping_planes_fragment>
// Wholly above the cut here (a lintel over a doorway cut to its stub): gone.
if (uCutOn > 0.5 && vCutBottom > uCutH && vCutBottom > gloamCutHeight(vCutAt) + 0.005) discard;`
          : `#include <clipping_planes_fragment>
if (uCutOn > 0.5 && vCutW.y > gloamCutHeight(vCutAt)) discard;`,
    );
}

type StoneKind = "box" | "ghost" | "leaf" | "pillar";

/**
 * The stone: a lit standard material whose colour and roughness come from world-space masonry. `box`/`ghost`: the
 * instanced wall boxes; `leaf`: a secret door's leaf; `pillar`: a pillar's prism (its courses run on round its
 * corners, its top's rim from the prism's `aEdge`, cut flat at its centre `c`).
 */
function stoneMaterial(kind: StoneKind, c: Vector2 | null = null): MeshStandardMaterial {
  const ghost = kind === "ghost";
  const m = new MeshStandardMaterial({
    roughness: 0.92,
    metalness: 0,
    // A faint fill of its own: faces turned from the key light read as shaded stone, not black.
    emissive: col(C.stoneA),
    emissiveIntensity: 0.07,
    transparent: ghost,
    opacity: ghost ? 0.32 : 1,
    depthWrite: !ghost,
    side: FrontSide,
  });
  const u = {
    uStoneA: { value: col(C.stoneA) },
    uStoneB: { value: col(C.stoneB) },
    uJoint: { value: col(C.stoneJoint) },
    uPlank: { value: col(C.plankA) },
    uGlass: { value: col(C.ice300) },
    uCutAtC: { value: c ?? new Vector2() },
  };
  if (kind === "pillar") m.defines = { GLOAM_PILLAR: "", GLOAM_CUT_AT_C: "" };
  // The wall boxes carry their hair as an attribute (StoneBoxes).
  else if (kind === "box" || kind === "ghost") m.defines = { GLOAM_HAIR: "" };
  m.customProgramCacheKey = () =>
    kind === "box" || kind === "ghost" ? "gloam-wall-stone" : `gloam-wall-stone:${kind}`;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vWall; varying float vAlong; varying float vTop; varying float vCap; varying vec3 vLocal;
#ifdef USE_INSTANCING
attribute float aCap;
#endif
#ifdef GLOAM_PILLAR
attribute float aAlong; attribute float aEdge;
#endif`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
vec4 gw = vec4(transformed, 1.0);
vec4 gx = vec4(1.0, 0.0, 0.0, 0.0);
#ifdef USE_INSTANCING
gw = instanceMatrix * gw;
gx = instanceMatrix * gx;
#endif
gw = modelMatrix * gw;
vec2 gdir = normalize((modelMatrix * gx).xz);
vWall = gw.xyz;
vAlong = dot(gw.xz, gdir);
vTop = abs(normal.y);
vLocal = position;
#ifdef GLOAM_PILLAR
vAlong = vTop > 0.5 ? gw.x : aAlong;
vLocal = vec3(0.0, 0.0, 0.5 - (1.0 - aEdge) * 0.18);
#endif
#ifdef USE_INSTANCING
vCap = aCap;
#else
vCap = 0.0;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${MASONRY_GLSL}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
float gMortar;
diffuseColor.rgb = vTop > 0.5 ? capstone(vAlong, vWall.xz, vCap, vLocal, gMortar) : masonry(vAlong, vWall.y, gMortar);
// A top the cutaway lowered is its cut face: drawn evenly lit (see withCutaway).
float gCutFace = vTop > 0.5 ? clamp(vCutCap, 0.0, 1.0) : 0.0;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.86, 0.98, gMortar);",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
totalEmissiveRadiance = mix(totalEmissiveRadiance, diffuseColor.rgb * ${CUT_FACE_LIGHT.toFixed(2)}, gCutFace);
diffuseColor.rgb *= 1.0 - gCutFace;`,
      );
    withCutaway(shader, kind === "box" || kind === "ghost" ? "unit" : "floor");
  };
  return m;
}

/** Oak planks with two iron straps; the leaf's own coordinates (feet from the hinge). */
function woodMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
  const u = {
    uPlankA: { value: col(C.plankA) },
    uPlankB: { value: col(C.plankB) },
    uIron: { value: col(C.ink900) },
  };
  m.customProgramCacheKey = () => "gloam-door-wood";
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLeaf;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLeaf = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nuniform vec3 uPlankA; uniform vec3 uPlankB; uniform vec3 uIron; varying vec3 vLeaf;\n${NOISE_GLSL}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
float plank = floor(vLeaf.x / 0.55);
float px = fract(vLeaf.x / 0.55);
float seam = 1.0 - smoothstep(0.02, 0.06, min(px, 1.0 - px));
vec3 wood = mix(uPlankA, uPlankB, g_hash(vec2(plank, 7.0)) * 0.7 + 0.3 * g_fbm(vec2(vLeaf.x * 3.0, vLeaf.y * 0.4)));
wood = mix(wood, uPlankA * 0.45, seam);
float strap = step(abs(vLeaf.y - 1.4), 0.16) + step(abs(vLeaf.y - 5.6), 0.16);
diffuseColor.rgb = mix(wood, uIron, clamp(strap, 0.0, 1.0));`,
      );
    withCutaway(shader, "floor");
  };
  return m;
}

/** Glass: nearly clear, with a faint fresnel sheen at grazing angles (the "faint reflection"). */
function glassMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: col(C.ice300),
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: DoubleSide,
  });
  m.customProgramCacheKey = () => "gloam-wall-glass";
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      `float gFres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 3.0);
outgoingLight += vec3(0.55, 0.65, 0.75) * gFres * 0.6;
diffuseColor.a = min(1.0, diffuseColor.a + gFres * 0.45);
#include <opaque_fragment>`,
    );
    withCutaway(shader, "unit");
  };
  return m;
}

/** A plain standard material with the cutaway. */
function cutMaterial(
  key: string,
  params: ConstructorParameters<typeof MeshStandardMaterial>[0],
  mode: "cut" | "fade" = "cut",
): MeshStandardMaterial {
  const m = new MeshStandardMaterial(params);
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (shader) => withCutaway(shader, mode);
  return m;
}

let mats: {
  iron: MeshStandardMaterial;
  stone: MeshStandardMaterial;
  ghost: MeshStandardMaterial;
  stoneLeaf: MeshStandardMaterial;
  wood: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  cloth: MeshStandardMaterial;
  field: MeshStandardMaterial;
} | null = null;
/** The walls' materials, made on first use and kept for the page (never disposed: see programs.ts). */
function materials() {
  mats ??= {
    iron: withFog(
      cutMaterial("gloam-wall-iron", { color: col(C.ink900), roughness: 0.45, metalness: 0.6 }),
      "wall",
    ),
    stone: withFog(stoneMaterial("box"), "wall"),
    ghost: withFog(stoneMaterial("ghost"), "wall"),
    stoneLeaf: withFog(stoneMaterial("leaf"), "wall"),
    wood: withFog(woodMaterial(), "wall"),
    glass: withFog(glassMaterial(), "wall"),
    // Cloth is cut like masonry where the cutaway opens the view (a stub with its hem, the rod with it): a faded,
    // double-sided transparent cloth with deep folds couldn't sort against itself and read as broken.
    cloth: withFog(
      cutMaterial("gloam-wall-cloth", {
        color: col(C.blood500).clone().multiplyScalar(0.34),
        roughness: 0.95,
        side: DoubleSide,
      }),
      "wall",
    ),
    field: cutMaterial(
      "gloam-wall-field",
      {
        color: col(C.arcane400),
        emissive: col(C.arcane400),
        emissiveIntensity: 0.25,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        side: DoubleSide,
      },
      "fade",
    ),
  };
  return mats;
}

// ------------------------------------------------------------------------------------------------ the layer

export function Walls3DLayer() {
  // (While the shader warm-up runs, 3-D walls are drawn whatever the scene: their materials are compiled then.)
  const scene3d = useBoard((d) => d.scene?.walls3d === true);
  const warming = useWarming();
  const on = scene3d || warming;
  const walls = useDrawn("walls");
  const dm = useDmView();
  const preview = useWallTool((s) => s.preview);
  const shadows = useTier((s) => s.name !== "low");
  const pieces = useMemo(
    () => (on ? wallPieces(walls.values(), dm, preview) : null),
    [on, walls, dm, preview],
  );
  const tgt = useMemo(() => new Vector3(), []);
  const pos = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const c = cameraRig.controls;
    if (!c || !pieces) return;
    c.getTarget(tgt);
    c.getPosition(pos);
    cutaway.uCutTarget.value.set(tgt.x, tgt.z);
    cutaway.uCutCam.value.set(pos.x, pos.z);
    const d = cutaway.uCutDir.value.set(tgt.x - pos.x, tgt.z - pos.z);
    if (d.lengthSq() > 1e-6) d.normalize();
    const pitch = cameraRig.pitchDeg();
    const cut = pitch < CUT_PITCH_DEG;
    cutaway.uCutOn.value = cut ? 1 : 0;
    cutaway.uKeepN.value = cut ? keepInView(tgt, pitch) : 0;
  });
  if (!pieces) return null;
  const m = materials();
  return (
    <group name="walls3d" userData={{ part: "walls3d" }}>
      <StoneBoxes boxes={pieces.stone} material={m.stone} shadows={shadows} name="walls3d-stone" />
      <StoneBoxes boxes={pieces.ghost} material={m.ghost} shadows={false} name="walls3d-ghost" />
      {pieces.pillars.map((loop) => (
        <PillarBody key={loop.map((p) => `${p.x},${p.y}`).join("|")} loop={loop} shadows={shadows} />
      ))}
      {pieces.glass.map((g) => (
        <Slab key={`${g.a.x},${g.a.y},${g.b.x},${g.b.y}`} box={g} material={m.glass} name="window-glass" />
      ))}
      {pieces.curtains.map((c) => (
        <Curtain key={c.id} a={c.a} b={c.b} />
      ))}
      {pieces.fields.map((f) => (
        <Slab
          key={f.id}
          box={{ a: f.a, b: f.b, y0: 0, y1: WALL_HEIGHT_FT, thick: 0.02, extend: 0 }}
          material={m.field}
          name="force-field"
        />
      ))}
      {pieces.doors.map((d) => (
        <DoorLeaf key={d.id} door={d} shadows={shadows} />
      ))}
    </group>
  );
}

const keepRank: { x: number; z: number; r: number; e: number; rank: number }[] = [];
/**
 * The tokens the cutaway keeps in view (`cutaway.uKeep`): the viewer's own first, then the selected, then the rest
 * nearest the camera's target — where they're drawn now (mid-glide included), each with how far toward the camera
 * a full-height wall would hide its base at this pitch. Returns how many.
 */
function keepInView(target: Vector3, pitchDeg: number): number {
  const group = boardApi.tokens;
  if (!group) return 0;
  const tokens = boardData(useEntities.getState()).tokens;
  const me = useTable.getState().me?.userId ?? "";
  const selected = useUi.getState().selection;
  const tan = Math.tan(MathUtils.degToRad(Math.max(10, pitchDeg)));
  keepRank.length = 0;
  for (const root of group.children) {
    const id = root.userData.tokenId as string | undefined;
    const t = id ? tokens.get(id) : undefined;
    if (!t || !root.visible) continue;
    const p = root.position;
    const near = (p.x - target.x) ** 2 + (p.z - target.z) ** 2;
    if (near > 120 * 120) continue;
    const tier = t.ownerIds.includes(me) ? 0 : selected.includes(t.id) ? 1 : 2;
    keepRank.push({
      x: p.x,
      z: p.z,
      r: Math.max(0.6, t.sizeFt / 2),
      e: Math.max(0, p.y),
      rank: tier * 1e9 + near,
    });
  }
  keepRank.sort((a, b) => a.rank - b.rank);
  let n = 0;
  for (const k of keepRank) {
    if (n >= KEEP_MAX) break;
    if (k.e >= WALL_HEIGHT_FT) continue;
    const reach = (WALL_HEIGHT_FT - k.e) / tan + k.r;
    (cutaway.uKeep.value[n++] as Vector4).set(k.x, k.z, k.r, reach);
  }
  return n;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpP = new Vector3();
const tmpS = new Vector3();
const UP = new Vector3(0, 1, 0);

/** A box's placement: centred on the segment, rotated to it, stretched to its length (plus `extend` at each end). */
function boxMatrix(b: Box, out: Matrix4, lift = 0): Matrix4 {
  const dx = b.b.x - b.a.x;
  const dy = b.b.y - b.a.y;
  const len = Math.hypot(dx, dy);
  const y1 = b.y1 + lift;
  tmpQ.setFromAxisAngle(UP, -Math.atan2(dy, dx));
  tmpP.set((b.a.x + b.b.x) / 2, (b.y0 + y1) / 2, (b.a.y + b.b.y) / 2);
  tmpS.set(len + 2 * b.extend, y1 - b.y0, b.thick);
  return out.compose(tmpP, tmpQ, tmpS);
}

/**
 * Unit boxes divided along their length, so the cutaway can lower a top vertex by vertex, following its slope: about
 * every 0.6 ft of wall (rounded up to a power of two, at most 128) — a short wall isn't paying for a long one's
 * divisions, so the vertices drawn follow the length of wall on the board, not the number of walls.
 */
const DIV_FT = 0.6;
const unitBoxes = new Map<number, BoxGeometry>();
function unitBox(segments: number): BoxGeometry {
  let g = unitBoxes.get(segments);
  if (!g) {
    g = new BoxGeometry(1, 1, 1, segments, 1, 1);
    unitBoxes.set(segments, g);
  }
  return g;
}
const segmentsFor = (lengthFt: number) =>
  Math.min(128, 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, Math.ceil(lengthFt / DIV_FT))))));

/** Every stone box, drawn as a few instanced meshes (one per division count). */
function StoneBoxes({
  boxes,
  material,
  shadows,
  name,
}: {
  boxes: Box[];
  material: MeshStandardMaterial;
  shadows: boolean;
  name: string;
}) {
  const buckets = useMemo(() => {
    const by = new Map<number, { box: Box; hair: number }[]>();
    boxes.forEach((b, i) => {
      const n = segmentsFor(Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) + 2 * b.extend);
      const list = by.get(n) ?? [];
      // Each box a hair taller than the last few (0–12 thousandths of a foot), counted along all the boxes: where
      // tops overlap at a joint, one covers the other instead of the two flickering (the cutaway keeps the hair).
      list.push({ box: b, hair: (i % 5) * 0.003 });
      by.set(n, list);
    });
    return [...by.entries()].sort((a, b) => a[0] - b[0]);
  }, [boxes]);
  return (
    <>
      {buckets.map(([n, items]) => (
        <BoxBucket key={n} segments={n} items={items} material={material} shadows={shadows} name={name} />
      ))}
    </>
  );
}

function BoxBucket({
  segments,
  items,
  material,
  shadows,
  name,
}: {
  segments: number;
  items: { box: Box; hair: number }[];
  material: MeshStandardMaterial;
  shadows: boolean;
  name: string;
}) {
  const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, items.length))));
  const mesh = useMemo(() => {
    // Its own copy of the box, carrying the per-instance cap kind and hair.
    const g = unitBox(segments).clone();
    g.setAttribute("aCap", new InstancedBufferAttribute(new Float32Array(capacity), 1));
    g.setAttribute("aHair", new InstancedBufferAttribute(new Float32Array(capacity), 1));
    const im = new InstancedMesh(g, material, capacity);
    im.frustumCulled = false;
    im.raycast = () => {};
    im.name = name;
    return im;
  }, [capacity, material, name, segments]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.dispose();
    },
    [mesh],
  );
  useLayoutEffect(() => {
    const caps = mesh.geometry.getAttribute("aCap") as InstancedBufferAttribute;
    const hairs = mesh.geometry.getAttribute("aHair") as InstancedBufferAttribute;
    for (let i = 0; i < items.length; i++) {
      const { box, hair } = items[i] as { box: Box; hair: number };
      mesh.setMatrixAt(i, boxMatrix(box, tmpM, hair));
      caps.setX(i, box.cap ?? 0);
      hairs.setX(i, hair);
    }
    caps.needsUpdate = true;
    hairs.needsUpdate = true;
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
  }, [mesh, items, shadows]);
  return <primitive object={mesh} />;
}

/**
 * A pillar: one closed prism of stone (pillars.ts) — its loop grown by half the walls' thickness, as tall as the walls,
 * its courses running on round its corners, its top rimmed like a wall's. Its top is graded from just outside it (its
 * footprint is never seen from anywhere); its sides by the room each faces.
 */
function PillarBody({ loop, shadows }: { loop: P[]; shadows: boolean }) {
  const geo = useMemo(() => {
    const d = pillarPrism(loop, THICK, WALL_HEIGHT_FT - 0.002, (c) =>
      ShapeUtils.triangulateShape(
        c.map((p) => new Vector2(p.x, p.y)),
        [],
      ),
    );
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(d.position, 3));
    g.setAttribute("normal", new BufferAttribute(d.normal, 3));
    g.setAttribute("aAlong", new BufferAttribute(d.along, 1));
    g.setAttribute("aEdge", new BufferAttribute(d.edge, 1));
    g.computeBoundingSphere();
    return g;
  }, [loop]);
  const material = useMemo(() => {
    const [cx, cy, rx, ry] = aroundOf(loop);
    const c = new Vector2(cx, cy);
    return withFog(stoneMaterial("pillar", c), "wall", { around: { c, r: new Vector2(rx, ry) } });
  }, [loop]);
  useEffect(
    () => () => {
      geo.dispose();
      material.dispose();
    },
    [geo, material],
  );
  return (
    <mesh
      geometry={geo}
      material={material}
      castShadow={shadows}
      receiveShadow={shadows}
      raycast={() => null}
      name="walls3d-pillar"
    />
  );
}

/** One thin box (a window's glass, an invisible wall's field). */
function Slab({ box, material, name }: { box: Box; material: MeshStandardMaterial; name: string }) {
  const matrix = useMemo(() => boxMatrix(box, new Matrix4()), [box]);
  return (
    <mesh
      name={name}
      geometry={unitBox(segmentsFor(Math.hypot(box.b.x - box.a.x, box.b.y - box.a.y)))}
      material={material}
      matrixAutoUpdate={false}
      matrix={matrix}
      raycast={() => null}
      renderOrder={3}
    />
  );
}

/** A curtain: heavy cloth hanging in soft folds from an iron rod, flaring a little at the hem. */
function Curtain({ a, b }: { a: P; b: P }) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const H = WALL_HEIGHT_FT - 0.55;
  const geometry = useMemo(() => {
    const g = new PlaneGeometry(len, H, Math.max(24, Math.round(len * 16)), 6);
    const pos = g.getAttribute("position") as Float32BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + len / 2;
      const t = 1 - (pos.getY(i) + H / 2) / H; // 0 at the rod, 1 at the hem
      // Deep, soft folds (they read as cloth edge-on and from above), a little fuller at the hem.
      pos.setZ(i, Math.sin((x / 1.7) * Math.PI * 2) * (0.3 + 0.12 * t));
    }
    g.translate(len / 2, H / 2 + 0.12, 0);
    g.computeVertexNormals();
    return g as BufferGeometry;
  }, [len, H]);
  const rod = useMemo(() => {
    const g = new CylinderGeometry(0.06, 0.06, len + 0.4, 10);
    g.rotateZ(Math.PI / 2);
    g.translate(len / 2, WALL_HEIGHT_FT - 0.35, 0);
    return g;
  }, [len]);
  useEffect(
    () => () => {
      geometry.dispose();
      rod.dispose();
    },
    [geometry, rod],
  );
  const m = materials();
  return (
    <group position={[a.x, 0, a.y]} rotation-y={-Math.atan2(b.y - a.y, b.x - a.x)}>
      <mesh
        name="curtain"
        geometry={geometry}
        material={m.cloth}
        raycast={() => null}
        castShadow
        receiveShadow
      />
      <mesh geometry={rod} material={m.iron} raycast={() => null} />
    </group>
  );
}

const leafAngles = new Map<string, number>();
const leafSwings = new Map<string, { from: number; to: number; t0: number }>();
/** Door leaves' current angles (degrees), for the test hooks. */
export function doorLeafAngles(): Record<string, number> {
  return Object.fromEntries(leafAngles);
}
/** A door's latest swing, and its angle `ms` after the swing began (test hooks). */
export function doorSwing(id: string, ms?: number[]): { from: number; to: number; at: number[] } | null {
  const s = leafSwings.get(id);
  return s ? { from: s.from, to: s.to, at: (ms ?? []).map((t) => angleAt(s, s.t0 + t)) } : null;
}

/**
 * A door leaf hinged at the wall's first end, swinging to open (88°) or shut over 300 ms, eased. A secret door is a
 * stone leaf (DMs only — to players it is a wall until it opens, and then an opened door).
 */
function DoorLeaf({ door, shadows }: { door: Door; shadows: boolean }) {
  const len = Math.hypot(door.b.x - door.a.x, door.b.y - door.a.y);
  const hinge = useRef<Group>(null);
  const target = door.open ? OPEN_DEG : 0;
  // A door seen for the first time is drawn as it is; after that it swings.
  const anim = useRef<{ from: number; to: number; t0: number }>({ from: target, to: target, t0: 0 });
  const geometry = useMemo(() => {
    // Divided across its width, so the cutaway can lower it following the slope.
    const g = new BoxGeometry(Math.max(0.1, len - 0.1), DOOR_TOP, LEAF, 12, 1, 1);
    g.translate(len / 2, DOOR_TOP / 2, 0);
    return g;
  }, [len]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => {
    const a = anim.current;
    const now = performance.now();
    const cur = angleAt(a, now);
    anim.current = { from: cur, to: target, t0: now };
    if (cur !== target) leafSwings.set(door.id, anim.current);
    again();
  }, [target, door.id]);
  useEffect(
    () => () => {
      leafAngles.delete(door.id);
      leafSwings.delete(door.id);
    },
    [door.id],
  );
  useFrame(() => {
    const g = hinge.current;
    if (!g) return;
    const now = performance.now();
    const deg = angleAt(anim.current, now);
    g.rotation.y = (deg * Math.PI) / 180;
    leafAngles.set(door.id, deg);
    if (deg !== anim.current.to) again();
  });
  const m = materials();
  return (
    <group
      position={[door.a.x, 0, door.a.y]}
      rotation-y={-Math.atan2(door.b.y - door.a.y, door.b.x - door.a.x)}
    >
      <group ref={hinge} name={`door-leaf:${door.id}`} userData={{ part: "doorLeaf", wallId: door.id }}>
        <mesh
          geometry={geometry}
          material={door.stone ? m.stoneLeaf : m.wood}
          raycast={() => null}
          castShadow={shadows}
          receiveShadow={shadows}
        />
      </group>
    </group>
  );
}

function angleAt(a: { from: number; to: number; t0: number }, now: number): number {
  if (a.from === a.to) return a.to;
  const t = Math.min(1, (now - a.t0) / DOOR_SWING_MS);
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  return t >= 1 ? a.to : a.from + (a.to - a.from) * e;
}
