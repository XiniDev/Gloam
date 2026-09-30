import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { AgXToneMapping, NoToneMapping } from "three";
import { boardDiag } from "./diag.ts";
import { chainFor, disposeChains, hasChain, type PostChain } from "./postChain.ts";
import type { TierSpec } from "./tiers.ts";

/** The chain drawing the board now (null on Low): the shader warm-up renders through it. */
export const postfx: { chain: PostChain | null } = { chain: null };

/**
 * Post-processing by tier (SPEC §24.6): the tier's chain (`chainFor`, one kept per tier) — AgX tone mapping, bloom (half resolution on
 * Medium), N8AO on Ultra, SMAA on High and up. Low has no composer and tone-maps in the renderer — no bloom, no AO
 * (AC-BRD-03). The vignette is a CSS overlay. The chain draws the frame (priority 1, as the dice overlay expects).
 */
export function PostFX({ tier }: { tier: TierSpec }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const on = hasChain(tier);
  const chain = useMemo(() => (on ? chainFor(gl, scene, camera, tier) : null), [on, gl, scene, camera, tier]);
  // Every tier's chain is kept for this renderer (chainFor), and freed with it.
  useEffect(() => () => disposeChains(gl), [gl]);
  useEffect(() => {
    boardDiag.postfx = { composer: on, bloom: Boolean(tier.bloom), ao: tier.ao, smaa: tier.smaa };
    postfx.chain = chain;
    // With a chain, tone mapping is its last effect and the scene renders linear; without, the renderer tone-maps.
    // Between frames the renderer doesn't clear on its own (the chain and the dice overlay clear when they draw).
    gl.toneMapping = chain ? NoToneMapping : AgXToneMapping;
    gl.toneMappingExposure = 1;
    if (chain) gl.autoClear = false;
    return () => {
      if (postfx.chain === chain) postfx.chain = null;
      chain?.park();
      gl.toneMapping = NoToneMapping;
      gl.autoClear = true;
    };
  }, [chain, on, tier.bloom, tier.ao, tier.smaa, gl]);
  useFrame((_, dt) => chain?.render(dt), chain ? 1 : 0);
  return null;
}
