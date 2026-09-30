import {
  type Camera,
  type Material,
  Mesh,
  type Object3D,
  Scene,
  type ShaderMaterial,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";

const pinned = new WeakSet<object>();

/** A program the board compiled: three's program object, when it first showed up, and what compiled it. */
export interface CompiledProgram {
  program: { name: string; cacheKey: string; id: number };
  at: number;
  /** "warm": the shader warm-up compiling ahead (warmup/); "draw": a frame drawing something for the first time. */
  origin: "warm" | "draw";
}
type Listener = (p: CompiledProgram) => void;
const listeners = new Set<Listener>();

/** Tells `fn` about each program compiled from now on (the warm-up's proof and the test probe read these). */
export function onProgramCompiled(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Keeps every shader program the board has compiled for the rest of the session. three.js frees a program when the
 * last material using it is disposed, so overlays that come and go — a ruler, a move ribbon, a ping, the Walls tool's
 * selection glow — recompiled their shaders each time they reappeared: a stall of tens of milliseconds on a GPU
 * (and a second under software GL) at the moment the player starts to act. Programs are few (one per material
 * variant) and small, so holding them costs nothing that matters. Called once per frame; `renderer.info.programs` is
 * three's own list, and each program's `usedTimes` is the count three releases it by. The board calls it at each frame's
 * start (what the last frame compiled: "draw"); the warm-up right after each of its compiles ("warm").
 */
export function pinPrograms(gl: WebGLRenderer, origin: CompiledProgram["origin"] = "draw"): number {
  const list = gl.info.programs as unknown as ({ usedTimes: number } & CompiledProgram["program"])[] | null;
  if (!list) return 0;
  let fresh = 0;
  for (const p of list) {
    if (pinned.has(p)) continue;
    pinned.add(p);
    p.usedTimes++;
    fresh++;
    if (listeners.size) {
      const c = { program: p, at: performance.now(), origin };
      for (const fn of listeners) fn(c);
    }
  }
  return fresh;
}

const anchored = new Set<string>();
const anchors: Material[] = [];

/**
 * Keeps each custom shader's code known to the renderer for good. three keys a ShaderMaterial's program by ids its
 * shader-code cache hands out, and frees an id when the last material using that code is disposed: the next ping,
 * move ribbon, ruler, spell look or hit-point bar then gets a new id, misses the (pinned) program and compiles again —
 * each time one reappears. An anchor per code — a copy of the first material seen with it, compiled once as that
 * material is drawn (so it finds the same program) and never disposed — keeps the id. Materials drawn into other
 * targets than the board's (the vision passes, a post chain's) are kept alive by their owners instead.
 */
export function anchorShaders(
  gl: WebGLRenderer,
  root: Object3D,
  camera: Camera,
  lightsFrom: Scene,
  target: WebGLRenderTarget | null,
): void {
  const fresh = new Scene();
  root.traverse((o) => {
    for (const m of ([] as Material[]).concat((o as Mesh).material ?? [])) {
      const sm = m as ShaderMaterial;
      if (!sm.isShaderMaterial) continue;
      const code = `${sm.vertexShader}\n/* fragment */\n${sm.fragmentShader}`;
      if (anchored.has(code)) continue;
      anchored.add(code);
      const a = sm.clone();
      // (A clone drops its shader hooks: the same program needs them.)
      a.onBeforeCompile = sm.onBeforeCompile;
      a.customProgramCacheKey = sm.customProgramCacheKey;
      anchors.push(a);
      const stand = new Mesh((o as Mesh).geometry, a);
      stand.frustumCulled = false;
      fresh.add(stand);
    }
  });
  if (!fresh.children.length) return;
  const prev = gl.getRenderTarget();
  gl.setRenderTarget(target);
  try {
    gl.compile(fresh, camera, lightsFrom);
  } finally {
    gl.setRenderTarget(prev);
  }
  pinPrograms(gl, "warm");
}

const NOTHING = new Scene();

/**
 * Sets a scene's lights up now, as its next frame will. three draws a frame's shadow pass before it sets that frame's
 * lights up, so the first frame after shadows switch on (a step up from Low, a new dice stage) drew its shadows with
 * the old setup — no light casting — and compiled depth programs for that one frame. Called whenever the casting
 * lights change, it makes that frame like every other (whose programs the warm-up has made).
 */
export function primeLights(gl: WebGLRenderer, camera: Camera, scene: Scene): void {
  gl.compile(NOTHING, camera, scene);
}
