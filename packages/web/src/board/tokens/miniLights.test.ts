import { Matrix4, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { TIERS } from "../tiers.ts";
import {
  MINI_LIGHTS_MAX,
  miniLightUniforms,
  pickMiniLights,
  setMiniLights,
  withMiniLights,
} from "./miniLights.ts";

const src = (id: string, x: number, y: number) => ({
  id,
  x,
  y,
  bright: 20,
  dim: 20,
  color: "#FFB86B",
  flicker: 1,
});

/** SPEC §15.7 step 5: 3-D minis receive real point lights from the N nearest light sources (tier: 8 / 4 / 2 / 0). */
describe("mini point lights", () => {
  it("each tier lights minis with its count of the nearest sources — nearest first, none on Low", () => {
    const sources = Array.from({ length: 12 }, (_, i) => src(`l${i}`, i * 10, 0));
    expect(TIERS.ultra.pointLights).toBe(8);
    expect(TIERS.high.pointLights).toBe(4);
    expect(TIERS.medium.pointLights).toBe(2);
    expect(TIERS.low.pointLights).toBe(0);
    const focus = { x: 52, y: 0 };
    expect(pickMiniLights(sources, focus, TIERS.high.pointLights).map((s) => s.id)).toEqual([
      "l5",
      "l6",
      "l4",
      "l7",
    ]);
    expect(pickMiniLights(sources, focus, TIERS.medium.pointLights).map((s) => s.id)).toEqual(["l5", "l6"]);
    expect(pickMiniLights(sources, focus, TIERS.low.pointLights)).toEqual([]);
    expect(pickMiniLights(sources, focus, 99)).toHaveLength(MINI_LIGHTS_MAX);
    // Equally near: always the same one first (the pick doesn't flutter between frames).
    expect(pickMiniLights([src("b", 1, 0), src("a", -1, 0)], { x: 0, y: 0 }, 1)[0]?.id).toBe("a");
  });

  it("the uniforms carry each light in view space, its reach and bright radius, its colour at its flicker", () => {
    const view = new Matrix4().makeTranslation(0, 0, -100);
    setMiniLights([{ ...src("a", 10, 20), flicker: 0.5 }], view);
    expect(miniLightUniforms.gMiniLightCount.value).toBe(1);
    const p = miniLightUniforms.gMiniLightPos.value[0];
    expect([p?.x, p?.y, p?.z, p?.w]).toEqual([10, 5, -80, 40]);
    const c = miniLightUniforms.gMiniLightCol.value[0];
    expect(c?.w).toBe(20);
    const full = miniLightUniforms.gMiniLightCol.value[0]?.x ?? 0;
    setMiniLights([{ ...src("a", 10, 20), flicker: 1 }], view);
    expect((miniLightUniforms.gMiniLightCol.value[0]?.x ?? 0) / full).toBeCloseTo(2, 5);
  });

  it("one program for every tier: the count is a uniform, and the patch keys the material once", () => {
    const m = withMiniLights(new MeshStandardMaterial());
    expect(m.customProgramCacheKey()).toContain("|minilights");
    expect(
      withMiniLights(m)
        .customProgramCacheKey()
        .match(/minilights/g),
    ).toHaveLength(1);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: "",
      fragmentShader: "#include <common>\nvoid main(){\n#include <lights_fragment_end>\n}",
    };
    m.onBeforeCompile(shader as never, {} as never);
    expect(shader.uniforms.gMiniLightCount).toBe(miniLightUniforms.gMiniLightCount);
    expect(shader.fragmentShader).toContain("if (i >= gMiniLightCount) break;");
    expect(shader.fragmentShader).not.toMatch(/#define\s+\w*MINI/);
  });
});
