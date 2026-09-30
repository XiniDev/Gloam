import { Pass } from "postprocessing";
import {
  AgXToneMapping,
  BackSide,
  type BufferGeometry,
  Camera,
  DataTexture,
  type DirectionalLight,
  DoubleSide,
  FrontSide,
  HalfFloatType,
  InstancedMesh,
  type Light,
  Line,
  LineLoop,
  LineSegments,
  Material,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  type Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  Scene,
  type Side,
  Sprite,
  Texture,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { contextLost } from "../gpu.ts";
import { postfx } from "../PostFX.tsx";
import { hasChain, type PostChain } from "../postChain.ts";
import { pinPrograms } from "../programs.ts";
import type { TierSpec } from "../tiers.ts";

let bound: { gl: WebGLRenderer; scene: Scene; camera: () => Camera } | null = null;

/**
 * three's compileAsync, its new programs recorded at once as the warm-up's (programs.ts) — a frame drawn before they
 * are ready mustn't count them as its own. On a lost context it compiles nothing (three's compile throws there; the
 * restored board warms up again): a background step caught mid-way just ends.
 */
export function compileNow(gl: WebGLRenderer, root: Object3D, camera: Camera, target: Scene | null = null) {
  if (contextLost(gl)) return Promise.resolve();
  let ready: Promise<unknown>;
  try {
    ready = gl.compileAsync(root, camera, target).catch(() => {});
  } catch {
    return Promise.resolve();
  }
  pinPrograms(gl, "warm");
  return ready;
}

/** The board's renderer, scene and camera (the Warmup component binds them). */
export function bindRenderer(b: typeof bound): void {
  bound = b;
  if (!b) {
    snapshot = [];
    prepared.clear();
  }
}

/**
 * Compiles `root`'s shader programs as the board will draw them — into the post chain's buffer when there is one
 * (linear, not tone-mapped), else to the screen — in parallel where the browser can (KHR_parallel_shader_compile),
 * and resolves when they're ready. Content that arrives during play (a mini's model, a 3-D map) goes through this
 * before it's shown, so its first frame doesn't wait for the GPU to compile it.
 */
export async function precompile(root: Object3D, timeoutMs = 8000): Promise<void> {
  if (!bound) return;
  const { gl, scene } = bound;
  const target = postfx.chain?.composer.inputBuffer ?? null;
  const prev = gl.getRenderTarget();
  let done: Promise<unknown>;
  try {
    gl.setRenderTarget(target);
    done = compileNow(gl, root, bound.camera(), root === scene ? null : scene);
  } catch {
    return;
  } finally {
    gl.setRenderTarget(prev);
  }
  // Its shadow pass too, where shadow maps are on (a mini casts one) — not for the whole scene, done separately.
  const shadows = root === scene ? Promise.resolve() : precompileShadows(root);
  // A lost context never reports ready: whatever isn't done compiles when it's drawn.
  await Promise.race([
    Promise.all([done.catch(() => {}), shadows]),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  pinPrograms(gl, "warm");
}

/**
 * Runs `fn` with every material in `root` that fades (marked `userData.fades`: a token's, as it hides or crossfades)
 * turned the other way — see-through if opaque, opaque if see-through — then turns them back. three draws the two
 * with different programs (OPAQUE), so compiling in between compiles the other.
 */
export function withFadesFlipped<T>(root: Object3D | Object3D[], fn: () => T): T {
  const flipped: Material[] = [];
  for (const r of Array.isArray(root) ? root : [root])
    r.traverse((o) => {
      // (A troika text's too: a plate fades in the dark, behind a path, while decluttered.)
      for (const m of ([] as Material[]).concat((o as Mesh).material ?? []))
        if (
          (m.userData.fades || (m as { isTroikaTextMaterial?: boolean }).isTroikaTextMaterial) &&
          !flipped.includes(m)
        )
          flipped.push(m);
    });
  const flip = () => {
    for (const m of flipped) {
      m.transparent = !m.transparent;
      m.depthWrite = !m.transparent;
      m.needsUpdate = true;
    }
  };
  flip();
  try {
    return fn();
  } finally {
    flip();
  }
}

/**
 * Troika texts make their material (the SDF text shader over the base) when first drawn: done now, as a frame would,
 * so a compile finds it.
 */
export function prepareTexts(root: Object3D): void {
  if (!bound) return;
  const { gl, scene } = bound;
  const camera = bound.camera();
  root.traverse((o) => {
    const t = o as Mesh & { _prepareForRender?: unknown };
    if (typeof t._prepareForRender !== "function") return;
    for (const m of ([] as Material[]).concat(t.material))
      t.onBeforeRender(gl, scene, camera, t.geometry, m, null as never);
  });
}

// ── Other tiers' render states ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What of a tier decides its shader programs: whether the scene draws into a post chain's buffer (linear, not
 * tone-mapped) or to the screen (tone-mapped AgX), and whether shadow maps are on. Low is the one tier different from
 * the rest (SPEC §24.6); Ultra's softer shadows are a uniform (shadow.radius), not another program.
 */
export interface RenderState {
  chain: boolean;
  shadows: boolean;
}
export const stateOf = (t: TierSpec): RenderState => ({ chain: hasChain(t), shadows: t.shadowMap > 0 });
const keyOf = (s: RenderState) => `${s.chain ? "chain" : "screen"}|${s.shadows ? "shadows" : "flat"}`;

/** Plain stand-ins for everything the warm-up drew (specimens and scene): their materials and geometries. */
let snapshot: Object3D[] = [];
/** Render states whose programs are compiled (or being compiled). */
const prepared = new Map<string, Promise<void>>();

/** After the context was lost and given back: no render state's programs exist any more. */
export function forgetPrepared(): void {
  prepared.clear();
}

/** Whether a state's programs are known to be compiled (the warm-up's own, or prepared since). */
export function markPrepared(s: RenderState): void {
  prepared.set(keyOf(s), Promise.resolve());
}

/** A stand-in drawn like `o` (same kind of object, material and geometry), for compiling only. */
function standIn(o: Object3D, culled = false): Object3D | null {
  const x = o as Mesh & {
    isPoints?: boolean;
    isLine?: boolean;
    isLineSegments?: boolean;
    isLineLoop?: boolean;
    isSprite?: boolean;
    isInstancedMesh?: boolean;
    isSkinnedMesh?: boolean;
    isBatchedMesh?: boolean;
  };
  if (!x.material || x.isSkinnedMesh || x.isBatchedMesh) return null;
  let c: Object3D;
  if (x.isInstancedMesh) {
    const im = new InstancedMesh(x.geometry, x.material, 1);
    im.instanceColor = (o as InstancedMesh).instanceColor;
    c = im;
  } else if (x.isSprite) c = new Sprite(x.material as never);
  else if (x.isPoints) c = new Points(x.geometry, x.material);
  else if (x.isLineSegments) c = new LineSegments(x.geometry, x.material);
  else if (x.isLineLoop) c = new LineLoop(x.geometry, x.material);
  else if (x.isLine) c = new Line(x.geometry, x.material);
  else if (x.isMesh) c = new Mesh(x.geometry, x.material);
  else return null;
  c.castShadow = o.castShadow;
  c.receiveShadow = o.receiveShadow;
  c.layers.mask = o.layers.mask;
  c.frustumCulled = culled;
  return c;
}

/**
 * The board scene's lights (and its environment and fog), copied into a scene of their own, the key light casting a
 * shadow or not: compiling against it keys programs exactly as the board's would be, without touching the board
 * scene's own light setup (three draws the next frame's shadow pass with the last one it made).
 */
function mirrorOf(scene: Scene, casting: boolean): Scene {
  const m = new Scene();
  m.environment = scene.environment;
  m.fog = scene.fog;
  scene.traverseVisible((o) => {
    if (!(o as Light).isLight) return;
    const c = (o as Light).clone();
    if ((c as DirectionalLight).isDirectionalLight) c.castShadow = casting;
    m.add(c);
  });
  return m;
}

/** Stand-ins for every drawable in `root` (the warm-up keeps them to compile other tiers' states later). */
export function captureSnapshot(root: Object3D): void {
  const out: Object3D[] = [];
  root.traverse((o) => {
    const c = standIn(o);
    if (c) out.push(c);
  });
  snapshot = out;
}

/**
 * Casters of every kind the shadow pass tells apart — each side, cut out by a map's alpha or not, instanced or not
 * — whatever the scene holds now: a tier step or a new creature then finds its shadow's program made.
 */
function syntheticCasters(): Object3D[] {
  const out: Object3D[] = [];
  const g = new PlaneGeometry(1, 1);
  const tex = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  for (const side of [FrontSide, BackSide, DoubleSide])
    for (const cut of [false, true])
      for (const instanced of [false, true]) {
        const m = new MeshStandardMaterial({ side, ...(cut ? { map: tex, alphaTest: 0.5 } : {}) });
        const o = instanced ? new InstancedMesh(g, m, 1) : new Mesh(g, m);
        o.castShadow = true;
        out.push(o);
      }
  return out;
}

// three's shadow pass draws a front face's depth from its back (WebGLShadowMap's `shadowSide`).
const SHADOW_SIDE: Record<number, Side> = {
  [FrontSide]: BackSide,
  [BackSide]: FrontSide,
  [DoubleSide]: DoubleSide,
};

/**
 * The shadow pass's depth materials for these casters, as three picks them (WebGLShadowMap `getDepthMaterial`): one
 * per side, and a cut-out's own where a map's alpha test shapes its shadow (standees).
 */
function depthStandIns(objects: Object3D[], allCast = false): Object3D[] {
  const out: Object3D[] = [];
  const seen = new Set<string>();
  for (const o of objects) {
    // (Preparing another tier: what doesn't cast a shadow here may there — 3-D walls cast only with shadow maps on.)
    if (!o.castShadow && !allCast) continue;
    if (!(o as Mesh).isMesh) continue;
    for (const m of ([] as Material[]).concat((o as Mesh).material ?? [])) {
      // What three copies from the drawn material onto the depth material it draws the shadow with — shared or a
      // cut-out's own, the program is keyed by these (WebGLShadowMap getDepthMaterial).
      const mm = m as Material & {
        map?: unknown;
        alphaMap?: unknown;
        displacementMap?: unknown;
        displacementScale?: number;
        wireframe?: boolean;
      };
      const side = m.shadowSide ?? SHADOW_SIDE[m.side] ?? BackSide;
      const alphaTest = m.alphaToCoverage ? 0.5 : m.alphaTest;
      const kind = (o as InstancedMesh).isInstancedMesh ? "i" : (o as Points).isPoints ? "p" : "m";
      const key = [
        kind,
        side,
        mm.map ? "map" : "",
        mm.alphaMap ? "alpha" : "",
        alphaTest > 0 ? "test" : "",
        mm.displacementMap ? "disp" : "",
        mm.wireframe ? "wire" : "",
        m.clippingPlanes?.length ?? 0,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const d = new MeshDepthMaterial();
      d.side = side;
      d.map = (mm.map as never) ?? null;
      d.alphaMap = (mm.alphaMap as never) ?? null;
      d.alphaTest = alphaTest;
      d.displacementMap = (mm.displacementMap as never) ?? null;
      d.displacementScale = mm.displacementScale ?? 1;
      d.wireframe = mm.wireframe ?? false;
      d.clippingPlanes = m.clippingPlanes;
      d.clipShadows = m.clipShadows;
      const c = standIn(o);
      if (!c) continue;
      (c as Mesh).material = d;
      out.push(c);
    }
  }
  return out;
}

const idle = (): Promise<void> =>
  new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, 16);
  });

/**
 * Compiles, in idle moments and a few objects at a time, what the board would draw in another render state: the
 * warm-up's stand-ins and the scene as it is now, and (with shadows) their shadow pass. The renderer is put in that
 * state only for the synchronous part of each call and put back at once. Resolves when the programs are ready.
 */
export function prepareState(s: RenderState): Promise<void> {
  const k = keyOf(s);
  const known = prepared.get(k);
  if (known) return known;
  const p = compileState(s, true);
  prepared.set(k, p);
  return p;
}

/**
 * The scene as it is now in a render state (what's arrived since the warm-up: a scene's map, its minis): compiled
 * when a tier change is about to happen, which waits for it.
 */
export function prepareLive(s: RenderState): Promise<void> {
  return compileState(s, false);
}

function compileState(s: RenderState, withSnapshot: boolean): Promise<void> {
  return (async () => {
    const b = bound;
    if (!b) return;
    const { gl, scene } = b;
    const objects = withSnapshot ? [...snapshot] : [];
    scene.traverse((o) => {
      const c = standIn(o);
      if (c) objects.push(c);
    });
    const depth = s.shadows ? depthStandIns([...objects, ...syntheticCasters()], true) : [];
    const mirrors = { true: mirrorOf(scene, true), false: mirrorOf(scene, false) };
    const buffer = new WebGLRenderTarget(4, 4, { type: HalfFloatType });
    const CHUNK = 8;
    const pending: Promise<unknown>[] = [];
    const compileIn = (list: Object3D[], target: WebGLRenderTarget | null) => {
      const chunk = new Scene();
      for (const o of list) chunk.add(o);
      const lit = mirrors[s.shadows ? "true" : "false"];
      const saved = { target: gl.getRenderTarget(), tone: gl.toneMapping, shadows: gl.shadowMap.enabled };
      try {
        gl.setRenderTarget(target);
        gl.toneMapping = target ? NoToneMapping : AgXToneMapping;
        gl.shadowMap.enabled = s.shadows;
        pending.push(compileNow(gl, chunk, b.camera(), lit));
        pending.push(withFadesFlipped(list, () => compileNow(gl, chunk, b.camera(), lit)));
      } finally {
        gl.setRenderTarget(saved.target);
        gl.toneMapping = saved.tone;
        gl.shadowMap.enabled = saved.shadows;
      }
    };
    for (let i = 0; i < objects.length; i += CHUNK) {
      await idle();
      compileIn(objects.slice(i, i + CHUNK), s.chain ? buffer : null);
    }
    for (let i = 0; i < depth.length; i += CHUNK) {
      await idle();
      compileIn(depth.slice(i, i + CHUNK), buffer);
    }
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 20_000))]);
    pinPrograms(gl, "warm");
    for (const d of depth) ((d as Mesh).material as Material).dispose();
    buffer.dispose();
  })();
}

/**
 * The shadow pass's programs for what's in `root`, in the renderer's current state, in parallel (the warm-up does this
 * before its real frames, which would otherwise compile them one at a time).
 */
export async function precompileShadows(root: Object3D): Promise<void> {
  if (!bound || !bound.gl.shadowMap.enabled) return;
  const { gl, scene } = bound;
  const objects: Object3D[] = [];
  root.traverse((o) => {
    const c = standIn(o);
    if (c) objects.push(c);
  });
  const depth = depthStandIns(root === scene ? [...objects, ...syntheticCasters()] : objects);
  if (!depth.length) return;
  const chunk = new Scene();
  for (const d of depth) chunk.add(d);
  const buffer = new WebGLRenderTarget(4, 4);
  const prev = gl.getRenderTarget();
  let ready: Promise<unknown> = Promise.resolve();
  try {
    gl.setRenderTarget(buffer);
    ready = compileNow(gl, chunk, bound.camera(), mirrorOf(scene, true));
  } finally {
    gl.setRenderTarget(prev);
  }
  await Promise.race([ready, new Promise((r) => setTimeout(r, 8000))]);
  pinPrograms(gl, "warm");
  for (const d of depth) ((d as Mesh).material as Material).dispose();
  buffer.dispose();
}

/**
 * Every material a post chain draws with — its passes' and their effects' own (bloom's luminance and blur, SMAA's
 * edges and weights, ambient occlusion's) — compiled in parallel as the chain draws them: its last pass to the
 * screen, the rest into its buffers. Found by walking the passes' fields (a few levels down).
 */
export async function precompileChain(chain: PostChain): Promise<void> {
  if (!bound) return;
  const { gl } = bound;
  const passes = chain.composer.passes;
  const last = passes[passes.length - 1]?.fullscreenMaterial ?? null;
  const found = new Map<Material, BufferGeometry>();
  const seen = new Set<object>();
  const fallback = (Pass as unknown as { fullscreenGeometry: BufferGeometry }).fullscreenGeometry;
  const walk = (o: unknown, depth: number, geometry: BufferGeometry) => {
    if (!o || typeof o !== "object" || seen.has(o) || depth > 7) return;
    seen.add(o);
    if (o instanceof Material) {
      if (!found.has(o)) found.set(o, geometry);
      return;
    }
    if (
      o instanceof Texture ||
      o instanceof WebGLRenderTarget ||
      o instanceof Scene ||
      o instanceof Camera ||
      ArrayBuffer.isView(o) ||
      (o as { isWebGLRenderer?: boolean }).isWebGLRenderer
    )
      return;
    // A pass's (or a helper's) own quad: its materials compile on its geometry.
    const own = (o as { screen?: Mesh; geometry?: BufferGeometry }).screen?.geometry ?? geometry;
    for (const v of Object.values(o)) walk(v, depth + 1, own);
  };
  for (const p of passes) walk(p, 0, fallback);
  const toScreen = new Scene();
  const intoBuffer = new Scene();
  for (const [m, g] of found) {
    const mesh = new Mesh(g, m);
    mesh.frustumCulled = false;
    (m === last ? toScreen : intoBuffer).add(mesh);
  }
  const buffer = new WebGLRenderTarget(4, 4, { type: HalfFloatType });
  const camera = new OrthographicCamera();
  const prev = gl.getRenderTarget();
  const tone = gl.toneMapping;
  const ready: Promise<unknown>[] = [];
  try {
    gl.toneMapping = NoToneMapping;
    gl.setRenderTarget(buffer);
    ready.push(compileNow(gl, intoBuffer, camera));
    gl.setRenderTarget(null);
    ready.push(compileNow(gl, toScreen, camera));
  } finally {
    gl.setRenderTarget(prev);
    gl.toneMapping = tone;
  }
  await Promise.race([Promise.all(ready), new Promise((r) => setTimeout(r, 8000))]);
  buffer.dispose();
}
