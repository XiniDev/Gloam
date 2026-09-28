import type { P } from "@gloam/shared/geometry";
import type { WallView } from "@gloam/shared/state";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  type Float32BufferAttribute,
  FrontSide,
  type Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector2,
  Vector3,
} from "three";
import { useTable } from "../../net/table.ts";
import { useBoard } from "../../state/entities.ts";
import { cameraRig } from "../CameraRig.tsx";
import { C, col } from "../colors.ts";
import { again } from "../frames.ts";
import { NOISE_GLSL } from "../glsl.ts";
import { useTier } from "../tiers.ts";
import { useWallTool } from "../tools/walls.ts";

/**
 * Walls in 3D (SPEC §8.7 3D walls; AC-WAL-06): with the scene's toggle on, walls stand 8 ft tall in procedural
 * masonry, doors are hinged wooden leaves that swing open and shut over 300 ms (under a stone lintel), windows are
 * thin glass with a faint fresnel sheen between a sill and a header, curtains hang in folds. For DMs a secret door is a
 * stone leaf, hidden walls are translucent ghosts and invisible walls a faint field; players get no geometry for
 * what they aren't meant to see — an occluder (a hidden wall that blocks sight) is never extruded, or it would
 * reveal itself.
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
}

/** What each wall becomes in 3D, for this viewer. */
export function wallPieces(
  walls: Iterable<WallView>,
  dm: boolean,
  moved?: ReadonlyMap<string, { a: P; b: P }> | null,
): Pieces {
  const out: Pieces = { stone: [], ghost: [], glass: [], curtains: [], fields: [], doors: [] };
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
    if (kind === "wall") out.stone.push({ a, b, y0: 0, y1: WALL_HEIGHT_FT, thick: THICK, extend: THICK / 2 });
    else if (kind === "door" || kind === "secret") {
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
  return out;
}

// ------------------------------------------------------------------------------------------------ materials (once)

const MASONRY_GLSL = /* glsl */ `
uniform vec3 uStoneA; uniform vec3 uStoneB; uniform vec3 uJoint; uniform vec3 uPlank; uniform vec3 uGlass;
varying vec3 vWall; varying float vAlong; varying float vTop; varying float vCap; varying vec3 vLocal;
${NOISE_GLSL}
// Ashlar courses 1 ft high, blocks 1.8 ft long, every course offset; mortar joints; per-block tint and grime low down.
vec3 masonry(float u, float v, out float mortar) {
  float row = floor(v);
  float x = u + g_hash(vec2(row, 3.1)) * 1.8;
  float cell = floor(x / 1.8);
  vec2 local = vec2(fract(x / 1.8) * 1.8, fract(v));
  float edge = min(min(local.x, 1.8 - local.x), min(local.y, 1.0 - local.y));
  mortar = 1.0 - smoothstep(0.035, 0.075, edge);
  float h = g_hash(vec2(cell, row));
  vec3 c = mix(uStoneA, uStoneB, 0.25 + 0.55 * h + 0.2 * g_fbm(vec2(u, v) * 1.4));
  c *= 0.86 + 0.22 * g_noise(vec2(u, v) * 5.0);
  // Contact shadow where the wall meets the floor, and grime in the lowest course.
  c *= mix(0.5, 1.0, smoothstep(0.0, 1.1, v)) * mix(0.9, 1.0, smoothstep(0.0, 2.4, v));
  return mix(c, uJoint, mortar);
}
// The wall's top: capstones laid along the wall, 1.5 ft long, with fine joints across it (overlapping tops at a joint
// sit at slightly different heights, so the nearer one simply covers the other).
vec3 capstone(float u, vec2 p, float cap, vec3 local, out float mortar) {
  float q = u / 1.5;
  float f = fract(q);
  mortar = (1.0 - smoothstep(0.02, 0.045, min(f, 1.0 - f) * 1.5)) * 0.7;
  // Darker than the floor, so a wall reads as a wall from straight above...
  vec3 c = mix(uStoneA, uStoneB, 0.3 + 0.3 * g_hash(vec2(floor(q), 5.0)) + 0.1 * g_noise(p * 3.0)) * 0.72;
  // ...a door's lintel as its oak beam, a window's header with a strip of glass along it...
  if (cap > 1.5) c = mix(c, uGlass, smoothstep(0.2, 0.12, abs(local.z)) * 0.85);
  else if (cap > 0.5) { c = mix(uPlank, uPlank * 1.35, g_noise(vec2(u * 2.0, local.z * 9.0))); mortar = 0.0; }
  c = mix(c, uJoint, mortar);
  // ...with a bright bevel along its long edges catching the light.
  float bevel = smoothstep(0.36, 0.5, abs(local.z));
  return mix(c, uStoneB * 1.25, bevel * 0.55);
}
`;

/**
 * The camera cutaway: at a tabletop or low angle an 8-ft wall hides the floor behind it — a token just inside a room's
 * near wall would be invisible. Walls between the camera and the point it looks at are cut down to a 1.2-ft stub
 * (with a solid cap, not a hollow box); walls level with or beyond that point stand full height, and looking straight
 * down nothing is cut. Shadows still come from the full walls (the shadow pass doesn't cut).
 */
export const cutaway = {
  uCutOn: { value: 0 },
  uCutH: { value: 1.2 },
  uCutGap: { value: 1.5 },
  uCutTarget: { value: new Vector2() },
  uCutDir: { value: new Vector2(0, -1) },
};
const CUT_PITCH_DEG = 75;

function withCutaway(
  shader: {
    uniforms: Record<string, unknown>;
    vertexShader: string;
    fragmentShader: string;
  },
  mode: "cut" | "fade" = "cut",
) {
  Object.assign(shader.uniforms, cutaway);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vCutW;")
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>
vec4 gcw = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
gcw = instanceMatrix * gcw;
#endif
vCutW = (modelMatrix * gcw).xyz;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      "#include <common>\nvarying vec3 vCutW; uniform float uCutOn; uniform float uCutH; uniform float uCutGap; uniform vec2 uCutTarget; uniform vec2 uCutDir;",
    )
    .replace(
      mode === "cut" ? "#include <clipping_planes_fragment>" : "#include <color_fragment>",
      mode === "cut"
        ? `#include <clipping_planes_fragment>
if (uCutOn > 0.5 && vCutW.y > uCutH && dot(vCutW.xz - uCutTarget, uCutDir) < -uCutGap) discard;`
        : `#include <color_fragment>
if (uCutOn > 0.5 && vCutW.y > uCutH && dot(vCutW.xz - uCutTarget, uCutDir) < -uCutGap) diffuseColor.a *= 0.2;`,
    );
}

/** The stone: a lit standard material whose colour and roughness come from world-space masonry. */
function stoneMaterial(ghost: boolean): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    roughness: 0.92,
    metalness: 0,
    // A faint fill of its own: faces turned from the key light read as shaded stone, not black.
    emissive: col(C.stoneA),
    emissiveIntensity: 0.07,
    transparent: ghost,
    opacity: ghost ? 0.32 : 1,
    depthWrite: !ghost,
    // Back faces show where the cutaway opens a wall: they're drawn as its solid cap.
    side: ghost ? FrontSide : DoubleSide,
  });
  const u = {
    uStoneA: { value: col(C.stoneA) },
    uStoneB: { value: col(C.stoneB) },
    uJoint: { value: col(C.stoneJoint) },
    uPlank: { value: col(C.plankA) },
    uGlass: { value: col(C.ice300) },
  };
  m.customProgramCacheKey = () => "gloam-wall-stone";
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWall; varying float vAlong; varying float vTop; varying float vCap; varying vec3 vLocal;\n#ifdef USE_INSTANCING\nattribute float aCap;\n#endif",
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
vec4 gw = vec4(transformed, 1.0);
vec2 gdir = vec2(1.0, 0.0);
#ifdef USE_INSTANCING
gw = instanceMatrix * gw;
gdir = normalize(instanceMatrix[0].xz);
#endif
gw = modelMatrix * gw;
vWall = gw.xyz;
vAlong = dot(gw.xz, gdir);
vTop = abs(normal.y);
vLocal = position;
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
if (!gl_FrontFacing) diffuseColor.rgb = mix(uStoneA, uJoint, 0.45);`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(0.86, 0.98, gMortar);",
      );
    withCutaway(shader);
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
    withCutaway(shader);
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
    withCutaway(shader);
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
  wood: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  cloth: MeshStandardMaterial;
  field: MeshStandardMaterial;
} | null = null;
/** The walls' materials, made on first use and kept for the page (never disposed: see programs.ts). */
function materials() {
  mats ??= {
    iron: cutMaterial("gloam-wall-iron", { color: col(C.ink900), roughness: 0.45, metalness: 0.6 }),
    stone: stoneMaterial(false),
    ghost: stoneMaterial(true),
    wood: woodMaterial(),
    glass: glassMaterial(),
    // Cloth isn't cut like masonry where the cutaway opens the view: it thins to a veil.
    cloth: cutMaterial(
      "gloam-wall-cloth",
      {
        color: col(C.blood500).clone().multiplyScalar(0.34),
        roughness: 0.95,
        side: DoubleSide,
        transparent: true,
      },
      "fade",
    ),
    field: cutMaterial("gloam-wall-field", {
      color: col(C.arcane400),
      emissive: col(C.arcane400),
      emissiveIntensity: 0.25,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: DoubleSide,
    }),
  };
  return mats;
}

// ------------------------------------------------------------------------------------------------ the layer

export function Walls3DLayer() {
  const on = useBoard((d) => d.scene?.walls3d === true);
  const walls = useBoard((d) => d.walls);
  const dm = useTable((s) => s.me?.role === "dm" || s.me?.role === "admin");
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
    const d = cutaway.uCutDir.value.set(tgt.x - pos.x, tgt.z - pos.z);
    if (d.lengthSq() > 1e-6) d.normalize();
    cutaway.uCutOn.value = cameraRig.pitchDeg() < CUT_PITCH_DEG ? 1 : 0;
  });
  if (!pieces) return null;
  const m = materials();
  return (
    <group name="walls3d" userData={{ part: "walls3d" }}>
      <StoneBoxes boxes={pieces.stone} material={m.stone} shadows={shadows} name="walls3d-stone" />
      <StoneBoxes boxes={pieces.ghost} material={m.ghost} shadows={false} name="walls3d-ghost" />
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

const unitBox = new BoxGeometry(1, 1, 1);

/** Every stone box in one instanced mesh; its capacity doubles as the walls grow. */
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
  const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, boxes.length))));
  const mesh = useMemo(() => {
    // Its own copy of the box, carrying the per-instance cap kind.
    const g = unitBox.clone();
    g.setAttribute("aCap", new InstancedBufferAttribute(new Float32Array(capacity), 1));
    const im = new InstancedMesh(g, material, capacity);
    im.frustumCulled = false;
    im.raycast = () => {};
    im.name = name;
    return im;
  }, [capacity, material, name]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.dispose();
    },
    [mesh],
  );
  useLayoutEffect(() => {
    // Each box a hair taller than the last few (0–12 thousandths of a foot): where tops overlap at a joint, one
    // covers the other instead of the two flickering.
    const caps = mesh.geometry.getAttribute("aCap") as InstancedBufferAttribute;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i] as Box;
      mesh.setMatrixAt(i, boxMatrix(b, tmpM, (i % 5) * 0.003));
      caps.setX(i, b.cap ?? 0);
    }
    caps.needsUpdate = true;
    mesh.count = boxes.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
  }, [mesh, boxes, shadows]);
  return <primitive object={mesh} />;
}

/** One thin box (a window's glass, an invisible wall's field). */
function Slab({ box, material, name }: { box: Box; material: MeshStandardMaterial; name: string }) {
  const matrix = useMemo(() => boxMatrix(box, new Matrix4()), [box]);
  return (
    <mesh
      name={name}
      geometry={unitBox}
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
    const g = new BoxGeometry(Math.max(0.1, len - 0.1), DOOR_TOP, LEAF);
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
          material={door.stone ? m.stone : m.wood}
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
