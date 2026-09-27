import { useEffect, useMemo } from "react";
import { MeshStandardMaterial } from "three";
import { col } from "../colors.ts";
import { disposeLater } from "../dispose.ts";
import { FLOOR_PATTERN_GLSL, PALETTE, ROUGHNESS, STYLE_INDEX } from "../floors.ts";
import { NOISE_GLSL } from "../glsl.ts";
import type { Bounds, FloorStyle } from "../scene.ts";

export { FLOOR_STYLES } from "../floors.ts";

const FLOOR_GLSL = /* glsl */ `
uniform float uStyle; uniform vec3 uA; uniform vec3 uB; uniform vec3 uJ;
${FLOOR_PATTERN_GLSL}
vec3 floorColour(vec2 p, out float rough) { return floorPattern(uStyle, p, uA, uB, uJ, rough); }
`;

export function ProceduralFloor({ bounds, style }: { bounds: Bounds; style: FloorStyle }) {
  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    const u = {
      uStyle: { value: 0 },
      uA: { value: col(PALETTE.stone[0]) },
      uB: { value: col(PALETTE.stone[1]) },
      uJ: { value: col(PALETTE.stone[2]) },
    };
    m.userData.u = u;
    m.customProgramCacheKey = () => "gloam-floor";
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\nvarying vec3 vWorldPos;\n${NOISE_GLSL}\n${FLOOR_GLSL}`,
        )
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\nfloat floorRough;\ndiffuseColor.rgb = floorColour(vWorldPos.xz, floorRough);",
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor = min(roughnessFactor, floorRough + 0.05);",
        );
    };
    return m;
  }, []);

  useEffect(() => {
    const u = material.userData.u as {
      uStyle: { value: number };
      uA: { value: unknown };
      uB: { value: unknown };
      uJ: { value: unknown };
    };
    const [a, b, j] = PALETTE[style];
    u.uStyle.value = STYLE_INDEX[style];
    u.uA.value = col(a);
    u.uB.value = col(b);
    u.uJ.value = col(j);
    material.roughness = ROUGHNESS[style];
  }, [style, material]);
  useEffect(() => () => disposeLater(material), [material]);

  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[(bounds.minX + bounds.maxX) / 2, 0, (bounds.minY + bounds.maxY) / 2]}
      receiveShadow
      material={material}
      userData={{ floorStyle: style }}
    >
      <planeGeometry args={[w, h, 1, 1]} />
    </mesh>
  );
}
