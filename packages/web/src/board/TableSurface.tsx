import { useEffect, useMemo } from "react";
import { MeshStandardMaterial, Vector4 } from "three";
import { C, col } from "./colors.ts";
import { disposeLater } from "./dispose.ts";
import { NOISE_GLSL } from "./glsl.ts";
import type { Bounds } from "./scene.ts";

/** How far beyond the map edge the table fades into darkness (SPEC §8.4). */
export const TABLE_FADE_FT = 60;

/** The empty table (no scene yet): a pool of lamplight this big, fading out over this many feet. */
const EMPTY_POOL = { halfX: 9, halfY: 6, fadeFt: 36 };

/**
 * The oak table the maps lie on (SPEC §8.4, §24.3): a standard material whose colour and roughness come from fbm
 * grain in world space (planks along X, rings, per-plank tint), fading to black 60 ft from the map's edge. With no
 * scene on it, a smaller pool under the lamp fades out sooner, so the empty table still sits in deep, soft darkness.
 */
export function TableSurface({ bounds, empty = false }: { bounds: Bounds; empty?: boolean }) {
  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ color: C.oak, roughness: 0.62, metalness: 0 });
    const uRect = { value: new Vector4() };
    const uFade = { value: TABLE_FADE_FT };
    m.userData.uRect = uRect;
    m.userData.uFade = uFade;
    m.customProgramCacheKey = () => "gloam-table";
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uRect = uRect;
      shader.uniforms.uFade = uFade;
      shader.uniforms.uOak = { value: col(C.oak) };
      shader.uniforms.uOakDark = { value: col(C.oakDark) };
      shader.uniforms.uOakLight = { value: col(C.oakLight) };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vWorldPos;
uniform vec4 uRect; uniform float uFade; uniform vec3 uOak; uniform vec3 uOakDark; uniform vec3 uOakLight;
${NOISE_GLSL}`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
vec2 wp = vWorldPos.xz;
float plank = floor(wp.y / 3.2);
float jitter = g_hash(vec2(plank, 7.0));
vec2 gp = vec2(wp.x * 0.035 + jitter * 40.0, wp.y * 0.9);
float grain = g_fbm(gp * vec2(1.0, 4.0));
float rings = 0.5 + 0.5 * sin((wp.y * 2.3 + grain * 7.0 + jitter * 12.0) * 2.2);
vec3 wood = mix(uOakDark, uOak, 0.35 + 0.45 * rings);
wood = mix(wood, uOakLight, smoothstep(0.62, 0.95, grain) * 0.35);
wood *= 0.82 + 0.3 * jitter;
// Distance to the nearest plank seam, in feet (seams every 3.2 ft); dark only within ~0.05 ft of it.
float seamFt = (0.5 - abs(fract(wp.y / 3.2) - 0.5)) * 3.2;
float seam = 1.0 - smoothstep(0.0, 0.05, seamFt);
wood = mix(wood, uOakDark * 0.4, seam);
diffuseColor.rgb = wood;`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor = clamp(0.5 + 0.25 * g_fbm(vWorldPos.xz * 0.6), 0.35, 0.85);",
        )
        .replace(
          "#include <dithering_fragment>",
          `vec2 halfSize = 0.5 * (uRect.zw - uRect.xy);
vec2 centre = 0.5 * (uRect.xy + uRect.zw);
float edge = length(max(abs(vWorldPos.xz - centre) - halfSize, 0.0));
gl_FragColor.rgb *= 1.0 - smoothstep(0.0, uFade, edge);
#include <dithering_fragment>`,
        );
    };
    return m;
  }, []);

  useEffect(() => {
    const rect = material.userData.uRect as { value: Vector4 };
    const fade = material.userData.uFade as { value: number };
    if (empty) {
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      rect.value.set(
        cx - EMPTY_POOL.halfX,
        cy - EMPTY_POOL.halfY,
        cx + EMPTY_POOL.halfX,
        cy + EMPTY_POOL.halfY,
      );
      fade.value = EMPTY_POOL.fadeFt;
    } else {
      rect.value.set(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
      fade.value = TABLE_FADE_FT;
    }
  }, [bounds, material, empty]);
  useEffect(() => () => disposeLater(material), [material]);

  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minY + bounds.maxY) / 2;
  return (
    <mesh rotation-x={-Math.PI / 2} position={[cx, -0.06, cz]} receiveShadow material={material}>
      <planeGeometry args={[1400, 1400, 1, 1]} />
    </mesh>
  );
}
