import { N8AOPostPass } from "n8ao";
import {
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  type Pass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing";
import { type Camera, HalfFloatType, type Scene, Vector2, type WebGLRenderer } from "three";
import type { TierSpec } from "./tiers.ts";

/** Whether a tier post-processes at all: Low tone-maps in the renderer instead (no composer, AC-BRD-03). */
export const hasChain = (t: Pick<TierSpec, "bloom" | "ao" | "smaa">): boolean =>
  Boolean(t.bloom || t.ao || t.smaa);

export interface PostChain {
  composer: EffectComposer;
  /** A frame through the chain: the scene into the composer's buffers, the last pass to the screen. */
  render(dt: number): void;
  /** Set aside (another tier draws): its buffers shrink to a pixel; its materials — and their programs — stay. */
  park(): void;
  dispose(): void;
}

// Effects merge into one pass as @react-three/postprocessing's "auto" mode does: a convolution effect doesn't share a
// pass with another, nor with one that samples `mainUv` (postprocessing's EffectAttribute.CONVOLUTION = 2).
const isConvolution = (e: Effect) => (e.getAttributes() & 2) === 2;
const hasMainUv = (e: Effect) => /mainUv/.test(e.getFragmentShader() ?? "");

function mergeEffects(nodes: (Effect | Pass)[], camera: Camera): Pass[] {
  const passes: Pass[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Effect | Pass;
    if (!(node instanceof Effect)) {
      passes.push(node);
      continue;
    }
    const effects = [node];
    let conv = isConvolution(node);
    let mainUv = hasMainUv(node);
    for (let next = nodes[i + 1]; next instanceof Effect; next = nodes[i + 1]) {
      const nConv = isConvolution(next);
      const nMainUv = hasMainUv(next);
      if ((conv && nConv) || (conv && nMainUv) || (mainUv && nConv)) break;
      effects.push(next);
      conv ||= nConv;
      mainUv ||= nMainUv;
      i++;
    }
    passes.push(new EffectPass(camera, ...effects));
  }
  return passes;
}

/**
 * The tier's post-processing chain (SPEC §24.6), built in one place for the board and for the shader warm-up (§24.7):
 * AgX tone mapping always; bloom with mipmap blur and a high threshold (half resolution on Medium); N8AO on Ultra
 * (normals from depth — no normal pass); SMAA on High and up. The same code building both is what makes the warm-up
 * compile exactly the programs the board will use. Low has no chain (`hasChain`).
 */
export function buildChain(gl: WebGLRenderer, scene: Scene, camera: Camera, tier: TierSpec): PostChain {
  const composer = new EffectComposer(gl, { multisampling: 0, frameBufferType: HalfFloatType });
  composer.autoRenderToScreen = true;
  composer.addPass(new RenderPass(scene, camera));
  const nodes: (Effect | Pass)[] = [];
  if (tier.ao) {
    const ao = new N8AOPostPass(scene, camera);
    Object.assign(ao.configuration, {
      aoRadius: 2.5,
      distanceFalloff: 1,
      intensity: 1.6,
      halfRes: true,
      depthAwareUpsampling: true,
      renderMode: 0,
    });
    ao.setQualityMode("Medium");
    nodes.push(ao);
  }
  if (tier.bloom)
    nodes.push(
      new BloomEffect({
        mipmapBlur: true,
        luminanceThreshold: 0.92,
        luminanceSmoothing: 0.12,
        intensity: 0.75,
        resolutionScale: tier.bloom === "half" ? 0.5 : 1,
      }),
    );
  nodes.push(new ToneMappingEffect({ mode: ToneMappingMode.AGX }));
  if (tier.smaa) nodes.push(new SMAAEffect());
  for (const p of mergeEffects(nodes, camera)) composer.addPass(p);
  const size = new Vector2();
  const applied = { width: -1, height: -1 };
  return {
    composer,
    render(dt) {
      // The renderer's logical size (as @react-three/postprocessing sizes it): the composer sizes its buffers from the
      // drawing buffer itself.
      gl.getSize(size);
      if (size.width !== applied.width || size.height !== applied.height) {
        composer.setSize(size.width, size.height);
        applied.width = size.width;
        applied.height = size.height;
      }
      const auto = gl.autoClear;
      gl.autoClear = true;
      composer.render(dt);
      gl.autoClear = auto;
    },
    park() {
      composer.inputBuffer.setSize(1, 1);
      composer.outputBuffer.setSize(1, 1);
      for (const p of composer.passes) p.setSize(1, 1);
      applied.width = -1;
      applied.height = -1;
    },
    dispose() {
      // (The composer disposes its passes, and an effect pass its effects.)
      composer.dispose();
    },
  };
}

const chains = new WeakMap<WebGLRenderer, Map<string, PostChain>>();

/**
 * The tier's chain for this renderer, scene and camera — built once and kept (parked while another tier draws): a
 * chain built again would get new materials, and custom shaders' programs are keyed by ids their materials hold, so
 * switching back would compile its shaders again (§24.7; programs.ts).
 */
export function chainFor(gl: WebGLRenderer, scene: Scene, camera: Camera, tier: TierSpec): PostChain {
  let byKey = chains.get(gl);
  if (!byKey) {
    byKey = new Map();
    chains.set(gl, byKey);
  }
  const key = `${tier.name}|${scene.uuid}|${camera.uuid}`;
  let c = byKey.get(key);
  if (!c) {
    c = buildChain(gl, scene, camera, tier);
    byKey.set(key, c);
  }
  return c;
}

/** Frees every chain kept for a renderer (the board unmounting). */
export function disposeChains(gl: WebGLRenderer): void {
  for (const c of chains.get(gl)?.values() ?? []) c.dispose();
  chains.delete(gl);
}
