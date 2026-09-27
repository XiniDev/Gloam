import { useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { type ReactElement, useEffect } from "react";
import { AgXToneMapping, NoToneMapping } from "three";
import { boardDiag } from "./diag.ts";
import type { TierSpec } from "./tiers.ts";

/**
 * Post-processing by tier (SPEC §24.6): AgX tone mapping always; bloom with mipmap blur and a high threshold (only
 * lights, VFX and the selection glow bloom; half resolution on Medium); N8AO on Ultra; SMAA on High and up. Low skips
 * the composer entirely and tone-maps in the renderer — no bloom, no AO (AC-BRD-03). The vignette is a CSS overlay.
 */
export function PostFX({ tier }: { tier: TierSpec }) {
  const gl = useThree((s) => s.gl);
  const composer = Boolean(tier.bloom || tier.ao || tier.smaa);
  useEffect(() => {
    boardDiag.postfx = { composer, bloom: Boolean(tier.bloom), ao: tier.ao, smaa: tier.smaa };
    if (!composer) {
      gl.toneMapping = AgXToneMapping;
      gl.toneMappingExposure = 1;
    }
    return () => {
      if (!composer) gl.toneMapping = NoToneMapping;
    };
  }, [composer, tier.bloom, tier.ao, tier.smaa, gl]);
  if (!composer) return null;
  // The composer takes elements only (no nulls), so the tier's passes are collected in order.
  const effects: ReactElement[] = [];
  if (tier.ao)
    effects.push(
      <N8AO key="ao" aoRadius={2.5} distanceFalloff={1} intensity={1.6} quality="medium" halfRes />,
    );
  if (tier.bloom)
    effects.push(
      <Bloom
        key="bloom"
        mipmapBlur
        luminanceThreshold={0.92}
        luminanceSmoothing={0.12}
        intensity={0.75}
        resolutionScale={tier.bloom === "half" ? 0.5 : 1}
      />,
    );
  effects.push(<ToneMapping key="tone" mode={ToneMappingMode.AGX} />);
  if (tier.smaa) effects.push(<SMAA key="smaa" />);
  return (
    <EffectComposer multisampling={0} enableNormalPass={tier.ao}>
      {effects}
    </EffectComposer>
  );
}
