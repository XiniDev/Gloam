import type { Material } from "three";

const patched = new WeakSet<Material>();

/**
 * A token's material that can go grey (SPEC §8.5 States: a dead creature is "desaturated, lying down"): its lit colour
 * mixed toward its own luminance, a shade darker, by `amount.value` (0 as it was, 1 grey). One program for every token
 * (the uniform is always there), so a creature dying never compiles a shader mid-fight.
 */
export function withDesat<M extends Material>(m: M, amount: { value: number }): M {
  if (patched.has(m)) return m;
  patched.add(m);
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|desat`;
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uDesat = amount;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uDesat;")
      .replace(
        "#include <opaque_fragment>",
        `outgoingLight = mix(outgoingLight, vec3(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722))) * 0.78, uDesat);
#include <opaque_fragment>`,
      );
  };
  m.needsUpdate = true;
  return m;
}

/** Fully grey (a dead creature's mini copies). */
export const GREY = { value: 1 };
