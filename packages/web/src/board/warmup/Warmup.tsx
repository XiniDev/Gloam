import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import {
  AgXToneMapping,
  type Camera,
  DataTexture,
  HalfFloatType,
  type Object3D,
  PerspectiveCamera,
  type Scene,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { diceShaders, diceSpecimen } from "../../dice/DiceOverlay.tsx";
import { useTable } from "../../net/table.ts";
import { provideTestHook } from "../../test/hooks.ts";
import { boardApi } from "../boardApi.ts";
import { cameraRig } from "../CameraRig.tsx";
import { DustMotes } from "../DustMotes.tsx";
import { setAnimating } from "../frames.ts";
import { imageMapMaterial } from "../map/MapLayer.tsx";
import { ProceduralFloor } from "../map/ProceduralFloor.tsx";
import { PathLine } from "../move/MoveLayer.tsx";
import { postfx } from "../PostFX.tsx";
import { chainFor, hasChain } from "../postChain.ts";
import { anchorShaders, pinPrograms, primeLights } from "../programs.ts";
import type { Bounds } from "../scene.ts";
import { TIER_ORDER, TIERS, type TierName, type TierSpec, tierSwitch, useTier } from "../tiers.ts";
import { MeasureShapeView } from "../tools/MeasureLayer.tsx";
import { Dots } from "../tools/marks.tsx";
import { vfxSpecimens } from "../vfx/specimens.ts";
import { warmVision } from "../vision/VisionLayer.tsx";
import {
  bindRenderer,
  captureSnapshot,
  compileNow,
  markPrepared,
  precompile,
  precompileChain,
  precompileShadows,
  prepareLive,
  prepareState,
  prepareTexts,
  type RenderState,
  stateOf,
  withFadesFlipped,
} from "./precompile.ts";
import { SPECIMEN, specimenData } from "./specimens.ts";
import { useSpecimens, useWarmup } from "./state.ts";

/**
 * Whether to warm up. Not under software GL (SwiftShader, llvmpipe): compiling everything there takes tens of
 * seconds behind the candle, and every frame is slow anyway — shaders compile as they're first drawn. Test builds
 * render in software, so they warm up only when a test asks (`localStorage["gloam:warmup"] = "on"`, before the board
 * mounts): the warm-up's own journey and the benchmark.
 */
function warmupWanted(): boolean {
  if (__GLOAM_TEST__) {
    try {
      return localStorage.getItem("gloam:warmup") === "on";
    } catch {
      return false;
    }
  }
  return useTier.getState().device?.software !== true;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Resolves once the board has drawn `n` more frames (the warm-up keeps them coming). */
function boardFrames(n: number): Promise<void> {
  const until = boardApi.frames + n;
  return new Promise((resolve) => {
    const check = () => (boardApi.frames >= until ? resolve() : requestAnimationFrame(check));
    check();
  });
}

/** Resolves once every troika text in `root` has laid out (its derived material exists then). */
function textsReady(root: Object3D, timeoutMs: number): Promise<void> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const check = () => {
      let waiting = false;
      root.traverse((o) => {
        const t = o as { textRenderInfo?: unknown; sync?: unknown; text?: unknown };
        if (typeof t.sync === "function" && "textRenderInfo" in t && t.text && !t.textRenderInfo)
          waiting = true;
      });
      if (!waiting || performance.now() - t0 > timeoutMs) resolve();
      else requestAnimationFrame(check);
    };
    check();
  });
}

/**
 * The dice's programs in a render state, compiled in parallel as the overlay draws them — to the screen, AgX, the
 * stage's key light shadowed as the state says — and as a gemstone's transmission pass draws the others behind it
 * (into a buffer: linear, untoned).
 */
async function warmDice(gl: WebGLRenderer, s: RenderState): Promise<void> {
  const d = diceSpecimen(gl, s.shadows);
  const transmission = new WebGLRenderTarget(4, 4, { type: HalfFloatType });
  const saved = { target: gl.getRenderTarget(), tone: gl.toneMapping, shadows: gl.shadowMap.enabled };
  let ready: Promise<unknown> = Promise.resolve();
  try {
    gl.toneMapping = AgXToneMapping;
    gl.shadowMap.enabled = s.shadows;
    gl.setRenderTarget(null);
    const screen = compileNow(gl, d.scene, d.camera);
    gl.setRenderTarget(transmission);
    const behind = compileNow(gl, d.scene, d.camera);
    ready = Promise.all([screen, behind]);
  } finally {
    gl.setRenderTarget(saved.target);
    gl.toneMapping = saved.tone;
    gl.shadowMap.enabled = saved.shadows;
  }
  await Promise.race([ready, new Promise((r) => setTimeout(r, 8000))]);
  d.dispose();
  transmission.dispose();
}

/**
 * The dice's shadow pass programs (made only by drawing): the dice stage drawn once, its lights set up as a throw's
 * stage sets them (DiceOverlay primes them), into a pixel-sized target from a camera looking away — only the shadow
 * pass draws anything. Behind the candle.
 */
function diceShadowEntry(gl: WebGLRenderer): void {
  const d = diceSpecimen(gl, true);
  const away = new PerspectiveCamera(30, 1, 1, 10);
  away.position.set(0, 0, 5000);
  away.lookAt(0, 0, 10_000);
  const target = new WebGLRenderTarget(4, 4);
  const saved = { target: gl.getRenderTarget(), shadows: gl.shadowMap.enabled };
  try {
    gl.setRenderTarget(target);
    gl.shadowMap.enabled = true;
    primeLights(gl, away, d.scene);
    gl.render(d.scene, away);
  } finally {
    gl.setRenderTarget(saved.target);
    gl.shadowMap.enabled = saved.shadows;
    d.key.shadow.map?.dispose();
    target.dispose();
    d.dispose();
  }
}

/**
 * A tier's post chain's own programs (bloom, SMAA, ambient occlusion, the tone-mapping pass), compiled in parallel
 * in the chain the board will use for that tier (kept, parked, until it does).
 */
async function warmChain(gl: WebGLRenderer, scene: Scene, camera: Camera, spec: TierSpec): Promise<void> {
  if (!hasChain(spec)) return;
  const chain = chainFor(gl, scene, camera, spec);
  await precompileChain(chain);
  if (postfx.chain !== chain) chain.park();
}

/**
 * The shader warm-up (SPEC §24.7; AC-PERF-05). Mounted with the board: before the board is shown — under the intro's
 * candle, or with the canvas hidden when the board mounts again later — it has every layer draw its specimens (one
 * of each token look, wall, door, light, zone, lasting area; every spell look; the dust; the dice). With the board's
 * frames paused, it compiles them all in parallel (where the browser can) as the current tier draws them, then lets
 * the board draw a couple of frames for what compiles only when drawn, and every other tier's post chain once. Then
 * it keeps stand-ins of everything (captureSnapshot), takes the specimens away and says it's done — the intro waits
 * for that. Afterwards, in idle moments, it compiles the stand-ins as the other tiers draw them; a tier change waits
 * for those (tiers.ts `tierSwitch`). Programs stay pinned (programs.ts): nothing play draws compiles again.
 */
export function Warmup({ bounds }: { bounds: Bounds }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const setFrameloop = useThree((s) => s.setFrameloop);
  const [roots, setRoots] = useState<Object3D[] | null>(null);
  const [centre, setCentre] = useState({ x: 0, y: 0 });

  useEffect(() => {
    bindRenderer({ gl, scene, camera: () => boardApi.camera ?? camera });
    provideTestHook("warmup", () => ({ ...useWarmup.getState() }));
    return () => {
      bindRenderer(null);
      // A board mounted again (a new renderer) warms again.
      useWarmup.setState({ phase: "waiting", tier: null });
    };
  }, [gl, scene, camera]);

  // Once per renderer. (Read, not subscribed: its own progress mustn't restart it.)
  useEffect(() => {
    if (useWarmup.getState().phase !== "waiting") return;
    if (!warmupWanted()) {
      useWarmup.setState({ phase: "done", tier: useTier.getState().name, skipped: true });
      return;
    }
    const tier = useTier.getState().name;
    const me = useTable.getState().me?.userId ?? "";
    let cancelled = false;
    const t0 = performance.now();
    const before = gl.info.programs?.length ?? 0;
    const steps: Record<string, number> = {};
    const ends: Record<string, number> = {};
    let last = t0;
    const count = () => gl.info.programs?.length ?? 0;
    const step = (name: string) => {
      const now = performance.now();
      steps[`${name}(${count()})`] = Math.round(now - last);
      ends[name] = now;
      last = now;
    };
    useWarmup.setState((s) => ({ phase: "warming", tier, rounds: s.rounds + 1 }));
    // Nothing drawn until the specimens are compiled: a frame then would compile them one at a time. (Frames already
    // asked for still come: the specimens go in once those are drawn.)
    setFrameloop("never");
    const target = cameraRig.controls?.getTarget(new Vector3()) ?? new Vector3();
    const c = { x: target.x, y: target.z };
    let made: Object3D[] = [];
    void (async () => {
      await nextFrame();
      await nextFrame();
      await nextFrame();
      if (cancelled) return;
      useSpecimens.setState({ data: specimenData(c, me) });
      setCentre(c);
      made = vfxSpecimens(c, TIERS[tier].particles);
      setRoots(made);
      // (React mounts the layers' specimens on its next commit.)
      await nextFrame();
      await nextFrame();
      await textsReady(scene, 3000);
      step("mount");
      if (cancelled) return;
      warmVision(gl);
      // Everything in the scene, as this tier draws it, and its shadow pass, in parallel — fading materials both
      // opaque and see-through…
      prepareTexts(scene);
      const compiled = [precompile(scene), precompileShadows(scene)];
      compiled.push(withFadesFlipped(scene, () => precompile(scene)));
      await Promise.all(compiled);
      if (postfx.chain) await precompileChain(postfx.chain);
      step("compile");
      if (cancelled) return;
      // …then real frames: what compiles only when drawn compiles here.
      setFrameloop("demand");
      setAnimating("warmup", true);
      await boardFrames(2);
      step("frames");
      if (cancelled) return;
      captureSnapshot(scene);
      // The dice's shadow pass (its depth programs are made only by drawing).
      diceShadowEntry(gl);
      pinPrograms(gl, "warm");
      // The specimens' custom shaders keep their ids when the specimens go (programs.ts anchorShaders).
      anchorShaders(gl, scene, boardApi.camera ?? camera, scene, postfx.chain?.composer.inputBuffer ?? null);
      useSpecimens.setState({ data: null });
      setRoots(null);
      await boardFrames(1);
      setAnimating("warmup", false);
      if (cancelled) return;
      markPrepared(stateOf(TIERS[tier]));
      useWarmup.setState({
        phase: "done",
        tier,
        programsBefore: before,
        programsAfter: count(),
        ms: Math.round(performance.now() - t0),
        steps,
        ends,
      });
      // After the board shows, in parallel and in idle moments: the dice (the first throw waits for them), then the
      // other tiers — their post chains, and their render state's programs for everything the warm-up saw. A tier
      // change waits for its own.
      const cam = () => boardApi.camera ?? camera;
      diceShaders.ready = warmDice(gl, stateOf(TIERS[tier]));
      const tierReady = new Map<TierName, Promise<void>>();
      const prepareTier = (name: TierName) => {
        let p = tierReady.get(name);
        if (!p) {
          const spec = TIERS[name];
          p = Promise.all([
            prepareState(stateOf(spec)),
            warmChain(gl, scene, cam(), spec),
            warmDice(gl, stateOf(spec)),
          ]).then(() => {});
          tierReady.set(name, p);
        }
        return p;
      };
      tierReady.set(tier, diceShaders.ready);
      let wanted = 0;
      tierSwitch.apply = (name, patch) => {
        const mine = ++wanted;
        // Its programs for everything the warm-up saw, and for the scene as it is now.
        void Promise.all([prepareTier(name), prepareLive(stateOf(TIERS[name]))]).then(() => {
          if (mine === wanted) useTier.getState().set({ ...patch, name });
        });
      };
      await diceShaders.ready;
      for (const name of TIER_ORDER) {
        if (cancelled) return;
        await prepareTier(name);
      }
      useWarmup.setState({ allTiersMs: Math.round(performance.now() - t0), programsAfter: count() });
    })();
    return () => {
      cancelled = true;
      setFrameloop("demand");
      // Stopped half-way (the board unmounted, or React's development double mount): the next mount warms again.
      if (useWarmup.getState().phase === "warming") useWarmup.setState({ phase: "waiting" });
      useSpecimens.setState({ data: null });
      setRoots(null);
      setAnimating("warmup", false);
      tierSwitch.apply = (name, patch) => useTier.getState().set({ ...patch, name });
      for (const r of made) r.traverse((o) => disposeObject(o));
    };
  }, [gl, scene, camera, setFrameloop]);

  if (!roots) return null;
  return (
    <group name="warmup">
      {roots.map((r) => (
        <primitive key={r.uuid} object={r} />
      ))}
      {/* The dust, which only some tiers show. */}
      <DustMotes bounds={bounds} count={8} specimen />
      <OverlaySpecimens at={centre} />
    </group>
  );
}

/**
 * What play draws for a moment and the scene layers don't hold: a planned move (its ribbon within reach and past it,
 * its ghost, another player's, the waypoints and marks), and measurements of every shape (a ruler's dashed line).
 */
function OverlaySpecimens({ at }: { at: { x: number; y: number } }) {
  const p = (dx: number, dy: number) => ({ x: at.x + dx, y: at.y + dy });
  const token = `${SPECIMEN}token:1`;
  const path = [p(-10, -5), p(-6, -2), p(-2, -2)];
  const m3 = (dx: number, dy: number) => ({ ...p(dx, dy), z: 0 });
  const shapes = ["ruler", "radius", "cone", "line", "cube"] as const;
  const maps = useMemo(() => {
    // An image map as it shows while its image loads (its colour) and after (its texture).
    const tex = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    tex.needsUpdate = true;
    const loading = imageMapMaterial();
    const loaded = imageMapMaterial();
    loaded.map = tex;
    return { tex, loading, loaded };
  }, []);
  useEffect(
    () => () => {
      maps.tex.dispose();
      maps.loading.dispose();
      maps.loaded.dispose();
    },
    [maps],
  );
  const floor = { minX: at.x - 20, minY: at.y + 14, maxX: at.x - 14, maxY: at.y + 20 };
  return (
    <group name="overlay-specimens">
      {/* The floors a scene can have: a procedural floor (every style is a uniform of one program), an image map. */}
      <ProceduralFloor bounds={floor} style="stone" />
      {[maps.loading, maps.loaded].map((m, i) => (
        <mesh
          key={m.uuid}
          material={m}
          rotation-x={-Math.PI / 2}
          position={[at.x - 12 + i * 3, 0, at.y + 16]}
        >
          <planeGeometry args={[2, 2]} />
        </mesh>
      ))}
      <PathLine tokenId={token} points={path} ok opacity={0.95} ghost />
      <PathLine tokenId={token} points={path} ok={false} opacity={0.95} onTop />
      <PathLine tokenId={token} points={path} ok opacity={0.7} mover="#C9A45C" ghost />
      {(["ring", "cross", "swords", "diamond", "dot"] as const).map((kind) => (
        <Dots key={kind} points={[p(-4, 4)]} kind={kind} px={16} color="#C9A45C" />
      ))}
      {shapes.map((shape, i) => (
        <MeasureShapeView
          key={shape}
          m={{ shape, points: [m3(i * 3, 8), m3(i * 3 + 2, 11)], widthFt: 5 }}
          color="#C9A45C"
        />
      ))}
    </group>
  );
}

function disposeObject(o: Object3D): void {
  const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[] };
  m.geometry?.dispose();
  for (const x of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) x.dispose();
}
