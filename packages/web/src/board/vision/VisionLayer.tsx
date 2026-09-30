import type { P } from "@gloam/shared/geometry";
import { type VisPoly, visRing } from "@gloam/shared/geometry";
import type { LightView, TokenView, WallView } from "@gloam/shared/state";
import {
  facingAngle,
  groundRadii,
  rleDecode,
  VisionGeometry,
  type VisionLight,
  type VisionWall,
} from "@gloam/shared/vision";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BufferGeometry,
  Color,
  CustomBlending,
  DataTexture,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  MaxEquation,
  Mesh,
  OneFactor,
  OrthographicCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { useTable } from "../../net/table.ts";
import { useBoard, useEntities } from "../../state/entities.ts";
import { useFog } from "../../state/fog.ts";
import { prefersReducedMotion } from "../../state/settings.ts";
import { useViewAs } from "../../state/viewAs.ts";
import { again, setAmbient, setAnimating } from "../frames.ts";
import { moveAnimAt } from "../move/anims.ts";
import { pinPrograms } from "../programs.ts";
import type { Bounds } from "../scene.ts";
import { TIERS, useTier } from "../tiers.ts";
import { fogUniforms } from "./fogMaterial.ts";

/** When the vision target was last drawn, and how often (test builds read it: door → vision latency). */
export const visionDiag = {
  draws: 0,
  lastDrawAt: 0,
  lightDraws: 0,
  wallsAt: 0,
  computedAt: 0,
  wallsDrawnAt: 0,
  /** The flicker factor each light was last drawn with (by light id). */
  flicker: {} as Record<string, number>,
  /** The last reveal: when it began and ended, and the blend each frame drew in between. */
  reveal: { startedAt: 0, doneAt: 0, steps: [] as number[] },
};

/** The largest side of a vision or light target (px). */
const MAX_SIDE = 4096;
/** Reveals animate over this long (SPEC §15.7 step 6). */
const REVEAL_MS = 300;

const VERT = /* glsl */ `
uniform vec4 uRect;
varying vec2 vXZ;
void main() {
  vXZ = position.xz;
  // Table x/z straight to the target: x → u, z → v (the composite samples it the same way).
  gl_Position = vec4((position.xz - uRect.xy) / uRect.zw * 2.0 - 1.0, 0.0, 1.0);
}`;
const VISION_FRAG = /* glsl */ `
uniform vec2 uEye; uniform float uElev; uniform vec3 uRange; uniform float uKind;
varying vec2 vXZ;
void main() {
  float d = length(vec3(vXZ - uEye, uElev));
  if (uKind < 0.5) {
    float dv = uRange.x > 0.0 ? 1.0 - smoothstep(uRange.x - 0.4, uRange.x + 0.4, d) : 0.0;
    float ts = uRange.y > 0.0 ? 1.0 - smoothstep(uRange.y - 0.4, uRange.y + 0.4, d) : 0.0;
    gl_FragColor = vec4(1.0, dv, 0.0, ts);
  } else {
    gl_FragColor = vec4(0.0, 0.0, 1.0 - smoothstep(uRange.z - 0.4, uRange.z + 0.4, d), 0.0);
  }
}`;
const LIGHT_FRAG = /* glsl */ `
uniform vec2 uPos; uniform float uBright; uniform float uDim; uniform float uCosHalf; uniform vec2 uDir;
uniform float uFlick; uniform vec3 uColor; uniform float uMagical; uniform float uPass;
varying vec2 vXZ;
void main() {
  float r = length(vXZ - uPos);
  // A 2-ft soft edge on each radius.
  float b = uBright > 0.0 ? 1.0 - smoothstep(uBright - 1.0, uBright + 1.0, r) : 0.0;
  float d = uDim > 0.0 ? 1.0 - smoothstep(uBright + uDim - 1.0, uBright + uDim + 1.0, r) : b;
  if (uCosHalf > -1.5 && r > 0.01) {
    float k = smoothstep(uCosHalf - 0.02, uCosHalf + 0.02, dot((vXZ - uPos) / r, uDir));
    b *= k;
    d *= k;
  }
  d = max(d, b);
  // Coverage (what's lit, which decides what's seen) stays whole; the flicker is the light's intensity, in the colour
  // target's alpha (a guttering torch dims what it lights, it doesn't hide it).
  gl_FragColor = uPass < 0.5 ? vec4(b, d, uMagical * d, 1.0) : vec4(uColor * d, uFlick * d);
}`;

function fanMaterial(frag: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms: { uRect: fogUniforms.gRect, ...uniforms },
    blending: CustomBlending,
    blendEquation: MaxEquation,
    blendEquationAlpha: MaxEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
}

const visionMaterial = () =>
  fanMaterial(VISION_FRAG, {
    uEye: { value: [0, 0] },
    uElev: { value: 0 },
    uRange: { value: [0, 0, 0] },
    uKind: { value: 0 },
  });
const lightMaterial = () =>
  fanMaterial(LIGHT_FRAG, {
    uPos: { value: [0, 0] },
    uBright: { value: 0 },
    uDim: { value: 0 },
    uCosHalf: { value: -2 },
    uDir: { value: [1, 0] },
    uFlick: { value: 1 },
    uColor: { value: [1, 1, 1] },
    uMagical: { value: 0 },
    uPass: { value: 0 },
  });

/**
 * The shader warm-up's part (SPEC §24.7): one fan of each pass drawn into a small target, as the layer draws them,
 * so their programs exist before a scene with fog first needs them.
 */
export function warmVision(gl: WebGLRenderer): void {
  const rt = new WebGLRenderTarget(8, 8, {
    depthBuffer: false,
    stencilBuffer: false,
    type: UnsignedByteType,
  });
  const scene = new Scene();
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
  const mats = [visionMaterial(), lightMaterial()];
  for (const m of mats) {
    const mesh = new Mesh(g, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  drawInto(gl, rt, scene);
  pinPrograms(gl, "warm");
  // Its materials are kept: disposed, the shaders' ids would go with them and the layer's own would compile again
  // (programs.ts anchorShaders).
  rt.dispose();
}

/** A visibility polygon as a triangle fan around its eye (x/z on the table). */
function setFan(g: BufferGeometry, v: VisPoly): void {
  const ring = visRing(v);
  const n = ring.length / 2;
  const need = n * 9;
  let attr = g.getAttribute("position") as Float32BufferAttribute | undefined;
  if (!attr || attr.array.length < need) {
    attr = new Float32BufferAttribute(new Float32Array(Math.max(need, 96)), 3);
    g.setAttribute("position", attr);
  }
  const a = attr.array as Float32Array;
  const ex = v.eye.x;
  const ez = v.eye.y;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const o = k * 9;
    a[o] = ex;
    a[o + 1] = 0;
    a[o + 2] = ez;
    a[o + 3] = ring[k * 2] as number;
    a[o + 4] = 0;
    a[o + 5] = ring[k * 2 + 1] as number;
    a[o + 6] = ring[j * 2] as number;
    a[o + 7] = 0;
    a[o + 8] = ring[j * 2 + 1] as number;
  }
  attr.needsUpdate = true;
  g.setDrawRange(0, n * 3);
}

/** A pool of fan meshes in one scene, drawn in order into a target. */
class FanPass {
  readonly scene = new Scene();
  private readonly meshes: Mesh<BufferGeometry, ShaderMaterial>[] = [];
  private used = 0;
  private readonly make: () => ShaderMaterial;
  constructor(make: () => ShaderMaterial) {
    this.make = make;
  }
  begin(): void {
    this.used = 0;
  }
  add(v: VisPoly, set: (u: ShaderMaterial["uniforms"]) => void): void {
    let m = this.meshes[this.used];
    if (!m) {
      m = new Mesh(new BufferGeometry(), this.make());
      m.frustumCulled = false;
      this.meshes.push(m);
      this.scene.add(m);
    }
    setFan(m.geometry, v);
    set(m.material.uniforms);
    m.visible = true;
    this.used++;
  }
  end(): void {
    for (let i = this.used; i < this.meshes.length; i++) (this.meshes[i] as Mesh).visible = false;
  }
  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}

const anyCam = new OrthographicCamera();
const clear = new Color();

function drawInto(gl: WebGLRenderer, rt: WebGLRenderTarget, scene: Scene): void {
  const prevTarget = gl.getRenderTarget();
  gl.getClearColor(clear);
  const prevAlpha = gl.getClearAlpha();
  gl.setRenderTarget(rt);
  gl.setClearColor(0x000000, 0);
  gl.clear(true, false, false);
  gl.render(scene, anyCam);
  gl.setRenderTarget(prevTarget);
  gl.setClearColor(clear, prevAlpha);
}

interface ViewerIn {
  x: number;
  y: number;
  elevation: number;
  darkvision: number;
  blindsight: number;
  truesight: number;
  blinded: boolean;
  unconscious: boolean;
}

/** Flicker (SPEC §8.8 Light animation): gentle, well under 3 changes a second (WCAG 2.3.1); none under reduced motion. */
export function flicker(anim: string, t: number, seed: number): number {
  const s = (f: number, p: number) => Math.sin(t * f + seed * p);
  switch (anim) {
    case "torch":
      return 0.93 + 0.035 * s(2.1, 1.7) + 0.025 * s(4.3, 2.9) + 0.01 * s(6.1, 0.3);
    case "candle":
      return 0.95 + 0.025 * s(1.7, 1.1) + 0.02 * s(3.9, 2.3);
    case "pulse":
      return 0.9 + 0.08 * (0.5 + 0.5 * s(1.3, 0.7));
    case "shimmer":
      return 0.94 + 0.03 * s(2.6, 0.9) + 0.03 * s(5.2, 1.4);
    default:
      return 1;
  }
}

export const hashSeed = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h & 0xffff) / 6553.6;
};

/**
 * Vision and light, drawn (SPEC §15.7): each viewer's sight and blindsight polygons (from the shared visibility code
 * and the walls this client has) into the vision target, each light's lit area into the light targets — redrawn only
 * when their inputs change (or while a viewer glides along its path, or a light flickers). The composite in the
 * patched materials reads them (fogMaterial.ts). Nothing here decides what the player may know: tokens the player
 * can't perceive aren't in their state at all.
 */
export function VisionLayer({ bounds }: { bounds: Bounds }) {
  const gl = useThree((s) => s.gl);
  const scene = useBoard((d) => d.scene);
  const walls = useBoard((d) => d.walls);
  const lights = useBoard((d) => d.lights);
  const tokens = useBoard((d) => d.tokens);
  const prep = useEntities((s) => s.prep !== null);
  const me = useTable((s) => s.me);
  const viewAs = useViewAs((s) => (s.userId ? s.data : null));
  const fogVersion = useFog((s) => s.version);
  const tier = useTier((s) => s.name);
  const dm = me?.role === "dm" || me?.role === "admin";
  const dmView = dm && !viewAs;
  const mode = prep || !scene ? 0 : scene.fogMode === "dynamic" ? 2 : scene.fogMode === "painted" ? 1 : 0;

  // Targets over the scene's bounds at the tier's resolution (capped).
  const targets = useMemo(() => {
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    const px = Math.min(TIERS[tier].fogPxPerFt, MAX_SIDE / w, MAX_SIDE / h);
    const W = Math.max(8, Math.ceil(w * px));
    const H = Math.max(8, Math.ceil(h * px));
    const opts = {
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    const half = gl.capabilities.isWebGL2 && gl.extensions.has("EXT_color_buffer_float");
    return {
      W,
      H,
      visA: new WebGLRenderTarget(W, H, { ...opts, type: UnsignedByteType }),
      visB: new WebGLRenderTarget(W, H, { ...opts, type: UnsignedByteType }),
      light: new WebGLRenderTarget(W, H, { ...opts, type: half ? HalfFloatType : UnsignedByteType }),
      lightCol: new WebGLRenderTarget(W, H, { ...opts, type: UnsignedByteType }),
    };
  }, [bounds, tier, gl]);
  useEffect(
    () => () => {
      targets.visA.dispose();
      targets.visB.dispose();
      targets.light.dispose();
      targets.lightCol.dispose();
    },
    [targets],
  );
  const passes = useMemo(
    () => ({ vision: new FanPass(visionMaterial), light: new FanPass(lightMaterial) }),
    [],
  );
  useEffect(
    () => () => {
      passes.vision.dispose();
      passes.light.dispose();
    },
    [passes],
  );

  // The walls this client knows, as blocking sets (a hidden sight-blocker comes as an "occluder"). A change keeps the
  // polygons it can't touch (a door opening recomputes only the views and lights near it).
  const lastGeo = useRef<VisionGeometry | null>(null);
  const geo = useMemo(() => {
    const next = VisionGeometry.after(
      lastGeo.current,
      [...walls.values()].map(
        (w: WallView): VisionWall => ({
          a: { x: w.ax, y: w.ay },
          b: { x: w.bx, y: w.by },
          kind: w.kind,
          door: (w.door || null) as VisionWall["door"],
        }),
      ),
    );
    lastGeo.current = next;
    return next;
  }, [walls]);
  // New walls (a door opened): the viewers' sight is computed at once, not at the next frame — the frame then only
  // draws polygons already in the geometry's cache (the vision this client shows is up to date as soon as the walls
  // are; under software GL the next frame can be far off).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per geometry (tokens moving recompute in frames)
  useEffect(() => {
    visionDiag.wallsAt = performance.now();
    if (mode !== 2 || !scene) return;
    const sight = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    for (const t of viewersOf(tokens, dmView, viewAs?.viewers ?? null)) {
      if (t.vis?.unconscious) continue;
      if (!t.vis?.blinded) geo.losSight(t.pos.x, t.pos.y, sight);
      if ((t.vis?.blindsight ?? 0) > 0) geo.losBlind(t.pos.x, t.pos.y, (t.vis?.blindsight ?? 0) + 1);
    }
    visionDiag.computedAt = performance.now();
  }, [geo]);

  // Anything vision depends on changed (a door, a wall, a light, a token, a viewer's senses): draw it in the next frame —
  // with on-demand rendering nothing else would ask for one (a door opening must show within 200 ms, AC-WAL-03).
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the triggers (the frame reads them itself)
  useEffect(() => {
    if (mode === 2) again();
  }, [mode, geo, lights, tokens, viewAs]);

  // Memory (explored or revealed) as a texture over the fog raster.
  const mem = useRef<DataTexture | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fogVersion stands for the fog store's contents
  useEffect(() => {
    const f = viewAs?.fog ?? null;
    const st = useFog.getState();
    const shape = f ?? st.shape;
    if (!shape || mode === 0) {
      mem.current?.dispose();
      mem.current = null;
      fogUniforms.gMem.value = null;
      return;
    }
    const n = shape.w * shape.h;
    const layers = new Map<string, Uint8Array>();
    let explored: Uint8Array | null = null;
    if (f) {
      for (const l of f.layers) layers.set(l.layer, rleDecode(l.runs, n));
      explored = f.explored ? rleDecode(f.explored, n) : null;
    } else {
      for (const [k, v] of st.layers) layers.set(k, v);
      explored = st.explored;
    }
    const mine = me?.userId ? `reveal:${me.userId}` : "";
    const cells = new Uint8Array(n);
    for (const [name, l] of layers) {
      // A player's revealed area: all players' layer and their own (the DM's hatch: what isn't revealed to all).
      if (name !== "reveal:all" && (dmView || (!f && name !== mine))) continue;
      for (let k = 0; k < n; k++) if (l[k]) cells[k] = 255;
    }
    if (mode === 2 && explored) for (let k = 0; k < n; k++) if (explored[k]) cells[k] = 255;
    let tex = mem.current;
    if (!tex || tex.image.width !== shape.w || tex.image.height !== shape.h) {
      tex?.dispose();
      tex = new DataTexture(cells, shape.w, shape.h, RedFormat, UnsignedByteType);
      tex.magFilter = LinearFilter;
      tex.minFilter = LinearFilter;
      mem.current = tex;
    } else (tex.image.data as Uint8Array).set(cells);
    tex.needsUpdate = true;
    fogUniforms.gMem.value = tex;
    fogUniforms.gMemTexel.value.set(1 / shape.w, 1 / shape.h);
    fogUniforms.gMemRect.value.set(shape.x0, shape.y0, shape.w * shape.cell, shape.h * shape.cell);
    again();
  }, [fogVersion, viewAs, mode, dmView, me?.userId]);
  useEffect(() => () => mem.current?.dispose(), []);

  const state = useRef({
    visKey: "",
    lightKey: "",
    cur: 0,
    blendStart: 0,
    geo: null as VisionGeometry | null,
    geoN: 0,
    lightGeo: null as VisionGeometry | null,
  });

  useEffect(() => {
    fogUniforms.gRect.value.set(
      bounds.minX,
      bounds.minY,
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
    );
    fogUniforms.gTexel.value.set(1 / targets.W, 1 / targets.H);
    state.current.visKey = "";
    state.current.lightKey = "";
    again();
  }, [bounds, targets]);

  useEffect(() => {
    fogUniforms.gMode.value = mode;
    fogUniforms.gDm.value = dmView ? 1 : 0;
    fogUniforms.gAmbient.value = scene?.ambient === "bright" ? 2 : scene?.ambient === "dim" ? 1 : 0;
    state.current.visKey = "";
    again();
  }, [mode, dmView, scene?.ambient]);

  useEffect(
    () => () => {
      fogUniforms.gMode.value = 0;
      setAnimating("vision", false);
      setAmbient("fog-drift", false);
      setAmbient("light-flicker", false);
    },
    [],
  );

  useFrame(({ clock }) => {
    const reduced = prefersReducedMotion();
    if (!reduced) fogUniforms.gTime.value = clock.elapsedTime;
    // The war fog drifts, at the tier's pace (still on Low): timed frames, never continuous rendering for it.
    const spec = TIERS[tier];
    setAmbient("fog-drift", mode !== 0 && !reduced && spec.fogDriftFps > 0, spec.fogDriftFps);
    const st = state.current;
    if (mode !== 2) {
      setAnimating("vision", false);
      setAmbient("light-flicker", false);
      return;
    }
    const now = performance.now();
    // Viewers: the tokens this client sees through, where they stand this frame (gliding ones mid-path).
    const viewerTokens = viewersOf(tokens, dmView, viewAs?.viewers ?? null);
    let gliding = false;
    const viewers: ViewerIn[] = viewerTokens.map((t) => {
      const a = moveAnimAt(t.id, now);
      if (a) gliding = true;
      const v = t.vis;
      return {
        x: a ? a.pos.x : t.pos.x,
        y: a ? a.pos.y : t.pos.y,
        elevation: t.elevation,
        darkvision: v?.darkvision ?? 0,
        blindsight: v?.blindsight ?? 0,
        truesight: v?.truesight ?? 0,
        blinded: v?.blinded === true,
        unconscious: v?.unconscious === true,
      };
    });
    const sight = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    if (st.geo !== geo) {
      st.geo = geo;
      st.geoN++;
    }
    const visKey = `${viewers.map((v) => Object.values(v).join(",")).join("|")}#${st.geoN}`;
    if (visKey !== st.visKey) {
      // A discrete change (a door, a light's reach, a token appearing) blends in over 300 ms; a glide follows at once.
      const animate = !gliding && st.visKey !== "" && !reduced;
      st.visKey = visKey;
      const into = animate ? 1 - st.cur : st.cur;
      passes.vision.begin();
      for (const v of viewers) {
        if (v.unconscious) continue;
        if (!v.blinded)
          passes.vision.add(geo.losSight(v.x, v.y, sight), (u) => {
            (u.uEye as { value: number[] }).value = [v.x, v.y];
            (u.uElev as { value: number }).value = v.elevation;
            (u.uRange as { value: number[] }).value = [v.darkvision, v.truesight, 0];
            (u.uKind as { value: number }).value = 0;
          });
        if (v.blindsight > 0)
          passes.vision.add(geo.losBlind(v.x, v.y, v.blindsight + 1), (u) => {
            (u.uEye as { value: number[] }).value = [v.x, v.y];
            (u.uElev as { value: number }).value = v.elevation;
            (u.uRange as { value: number[] }).value = [0, 0, v.blindsight];
            (u.uKind as { value: number }).value = 1;
          });
      }
      passes.vision.end();
      const rtInto = into === 0 ? targets.visA : targets.visB;
      drawInto(gl, rtInto, passes.vision.scene);
      visionDiag.draws++;
      visionDiag.lastDrawAt = now;
      // The first draw with walls that changed (door → vision latency, AC-WAL-03).
      if (visionDiag.wallsDrawnAt < visionDiag.wallsAt) visionDiag.wallsDrawnAt = now;
      const other = into === 0 ? targets.visB : targets.visA;
      if (animate) {
        fogUniforms.gVisPrev.value = other.texture;
        st.blendStart = now;
        visionDiag.reveal = { startedAt: now, doneAt: 0, steps: [] };
      } else fogUniforms.gVisPrev.value = rtInto.texture;
      fogUniforms.gVis.value = rtInto.texture;
      st.cur = into;
    }
    const k = Math.min(1, (now - st.blendStart) / REVEAL_MS);
    fogUniforms.gBlend.value = k;
    const rv = visionDiag.reveal;
    if (rv.startedAt === st.blendStart && !rv.doneAt) {
      if (k < 1) rv.steps.push(k);
      else rv.doneAt = now;
    }

    // Lights: where they are this frame (carried ones with their carrier), flickering if they do.
    const ls = lightsOf(lights, tokens, now);
    const flickers = !reduced && ls.some((l) => l.anim !== "none");
    setAmbient("light-flicker", flickers, spec.flickerFps);
    const t = clock.elapsedTime;
    const lightKey = ls
      .map((l) => `${l.id},${l.x},${l.y},${l.bright},${l.dim},${l.coneDeg},${l.directionDeg}`)
      .join("|");
    if (lightKey !== st.lightKey || flickers || geo !== st.lightGeo) {
      st.lightKey = lightKey;
      st.lightGeo = geo;
      passes.light.begin();
      const colour = new Color();
      for (const l of ls) {
        const f = reduced ? 1 : flicker(l.anim, t, hashSeed(l.id));
        visionDiag.flicker[l.id] = f;
        const cone = l.coneDeg !== null && l.coneDeg < 360;
        const dir = facingAngle(l.directionDeg);
        colour.set(l.color || "#ffffff");
        passes.light.add(geo.lit(l.x, l.y, l.bright + l.dim), (u) => {
          (u.uPos as { value: number[] }).value = [l.x, l.y];
          (u.uBright as { value: number }).value = l.bright;
          (u.uDim as { value: number }).value = l.dim;
          (u.uCosHalf as { value: number }).value = cone
            ? Math.cos(((l.coneDeg as number) * Math.PI) / 360)
            : -2;
          (u.uDir as { value: number[] }).value = [Math.cos(dir), Math.sin(dir)];
          (u.uFlick as { value: number }).value = f;
          (u.uColor as { value: number[] }).value = [colour.r, colour.g, colour.b];
          (u.uMagical as { value: number }).value = l.magical ? 1 : 0;
        });
      }
      passes.light.end();
      setPass(passes.light, 0);
      drawInto(gl, targets.light, passes.light.scene);
      setPass(passes.light, 1);
      drawInto(gl, targets.lightCol, passes.light.scene);
      visionDiag.lightDraws++;
      fogUniforms.gLight.value = targets.light.texture;
      fogUniforms.gLightCol.value = targets.lightCol.texture;
    }
    if (!fogUniforms.gLight.value) {
      fogUniforms.gLight.value = targets.light.texture;
      fogUniforms.gLightCol.value = targets.lightCol.texture;
    }
    setAnimating("vision", k < 1);
  });
  return null;
}

function setPass(p: FanPass, pass: number): void {
  p.scene.traverse((o) => {
    const m = (o as Mesh).material as ShaderMaterial | undefined;
    if (m?.uniforms?.uPass) (m.uniforms.uPass as { value: number }).value = pass;
  });
}

/** The tokens a client sees through: its own and shared ones (it holds their senses); the DM: every player's. */
function viewersOf(tokens: Map<string, TokenView>, dmView: boolean, asViewers: string[] | null): TokenView[] {
  if (asViewers) return asViewers.map((id) => tokens.get(id)).filter((t): t is TokenView => Boolean(t));
  const out: TokenView[] = [];
  for (const t of tokens.values()) {
    if (dmView ? t.ownerIds.length > 0 && t.dm?.dmHidden !== true : Boolean(t.vis)) out.push(t);
  }
  return out;
}

export interface LightIn extends VisionLight {
  anim: string;
  color: string;
}

/** The lights that light what players see (DM-only ones are a DM aid), where they are this frame. */
export function lightsOf(
  lights: Map<string, LightView>,
  tokens: Map<string, TokenView>,
  now: number,
): LightIn[] {
  const out: LightIn[] = [];
  for (const l of lights.values()) {
    if (!l.on || l.dmOnly || l.bright + l.dim <= 0) continue;
    let p: P = { x: l.x, y: l.y };
    let dir = l.dirDeg;
    const carrier = l.link?.tokenId;
    if (carrier) {
      const a = moveAnimAt(carrier, now);
      if (a) {
        p = a.pos;
        if (a.heading !== null) dir = (-a.heading * 180) / Math.PI;
      } else {
        const t = tokens.get(carrier);
        if (t) p = t.pos;
      }
    }
    // Its circles where they meet the table (a light up high lights less of the floor; the server's rule too).
    const g = groundRadii(l.bright, l.dim, l.elevation);
    if (g.bright + g.dim <= 0) continue;
    out.push({
      id: l.id,
      x: p.x,
      y: p.y,
      bright: g.bright,
      dim: g.dim,
      coneDeg: l.coneDeg >= 360 || l.coneDeg <= 0 ? null : l.coneDeg,
      directionDeg: dir,
      magical: l.magical,
      pierceDarkness: l.pierceDarkness,
      anim: l.anim,
      color: l.color,
    });
  }
  return out;
}
