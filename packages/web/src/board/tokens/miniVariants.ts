import type { Material, Mesh, Object3D } from "three";
import { Group, Mesh as MeshCtor } from "three";
import { withFog } from "../vision/fogMaterial.ts";
import { GREY, withDesat } from "./desaturate.ts";
import { withMiniLights } from "./miniLights.ts";

/**
 * A hidden or dead mini's own copy of one of its materials (never the shared one, AC-TOK-10): see-through for a hidden
 * one (`opacity` < 1), grey and a shade darker for a dead one (§8.5 "desaturated").
 */
export function miniVariant(mat: Material, opacity: number, dead: boolean): Material {
  // (A clone drops its shader hooks: the fog and the mini lights go on again.)
  const c = withMiniLights(withFog(mat.clone(), "token"));
  c.transparent = opacity < 1;
  c.opacity = opacity;
  c.depthWrite = opacity >= 1;
  if (dead) {
    withDesat(c, GREY);
    const col = (c as { color?: { multiplyScalar(k: number): unknown } }).color;
    col?.multiplyScalar(0.85);
  }
  return c;
}

/**
 * Stand-ins drawn with each variant a mini's materials may take in play — hidden, dead, both — so the shader warm-up
 * for a newly loaded mini compiles them before it's shown (they'd otherwise compile the moment the DM hides it or it
 * dies). `dispose` frees the copies (their programs are pinned by then).
 */
export function miniVariantStandIns(root: Object3D): { group: Group; dispose(): void } {
  const group = new Group();
  const made: Material[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    for (const [opacity, dead] of [
      [0.4, false],
      [1, true],
      [0.4, true],
    ] as const) {
      const copies = (Array.isArray(m.material) ? m.material : [m.material]).map((mat) =>
        miniVariant(mat, opacity, dead),
      );
      made.push(...copies);
      group.add(new MeshCtor(m.geometry, Array.isArray(m.material) ? copies : copies[0]));
    }
  });
  return {
    group,
    dispose() {
      for (const m of made) m.dispose();
    },
  };
}
