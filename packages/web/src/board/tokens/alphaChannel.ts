import type { Material } from "three";

/**
 * A material whose `alphaMap` is read from the texture's alpha channel, not its green one (three's default, meant for
 * greyscale masks). A standee's back and cardboard edge are cut to the art's own outline with the art itself as the
 * alpha map: read by green, a dark picture's pixels fell under the alpha test and the card's back and edge vanished
 * wherever the art was dark (critic P7 r1). Chains any earlier shader hook, as `withFog` does.
 */
export function alphaFromAlphaChannel<M extends Material>(m: M): M {
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|alphaA`;
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <alphamap_fragment>",
      `#ifdef USE_ALPHAMAP
  diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).a;
#endif`,
    );
  };
  return m;
}
