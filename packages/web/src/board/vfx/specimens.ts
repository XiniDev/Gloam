import type { Object3D } from "three";
import { PRESETS } from "./palette.ts";
import { areaBurst, areaLoop, projectile, type V3, whereOf } from "./presets.ts";

const noBody = () => null;

/**
 * One of every spell look (SPEC §24.5, §24.7) round a point on the table: each preset's cast burst over every shape of
 * area, its projectile, its lasting loop, the lasting looks their properties give (a haze, a cloud, darkness, silence,
 * difficult ground, a creature's aura, Moonbeam's column), and walls both see-through and solid. The shader warm-up
 * draws them under the intro's candle; many share programs — enough are built that none is missed.
 */
export function vfxSpecimens(at: { x: number; y: number }, scale: number): Object3D[] {
  const o = { x: at.x, y: at.y, z: 0 };
  const shapes: Record<string, Record<string, unknown>> = {
    sphere: { kind: "sphere", origin: o, radius: 5 },
    cylinder: { kind: "cylinder", origin: o, radius: 5, height: 20 },
    cone: { kind: "cone", origin: o, dirDeg: 30, length: 15 },
    line: { kind: "line", origin: o, dirDeg: 250, length: 30, width: 5 },
    cube: { kind: "cube", origin: o, dirDeg: 0, size: 10, originOnFace: false },
    wall: {
      kind: "wall",
      points: [
        { x: at.x - 5, y: at.y },
        { x: at.x + 5, y: at.y + 3 },
      ],
      closed: false,
      height: 10,
      thickness: 1,
    },
  };
  const out: Object3D[] = [];
  const where = (k: string) => whereOf(shapes[k], null, noBody);
  const from: V3 = [at.x - 10, 0, at.y];
  const to: V3 = [at.x, 0, at.y];
  const looks = [
    {},
    { obscurement: "light" },
    { obscurement: "heavy" },
    { magicalDarkness: true },
    { silence: true },
    { speedHalved: true },
    { outline: true },
    { difficult: true },
    { bodyFt: 5 },
  ];
  let seed = 1;
  for (const preset of PRESETS) {
    for (const k of Object.keys(shapes)) {
      const w = where(k);
      if (w) out.push(areaBurst(preset, w, scale, seed++).root);
    }
    out.push(projectile(preset, from, to, scale, seed++).root);
    const round = where("sphere");
    if (round)
      for (const props of looks)
        for (const dm of [false, true])
          out.push(areaLoop(preset, round, props, "Specimen", "sphere", scale, seed++, undefined, { dm }));
    const wall = where("wall");
    const pts = shapes.wall?.points as { x: number; y: number }[];
    if (wall)
      for (const solid of [false, true])
        out.push(areaLoop(preset, wall, {}, "Specimen", "wall", scale, seed++, pts, { height: 10, solid }));
  }
  // The looks particular to a shape or a name: Web over a cube, Moonbeam's column, the gases of Stinking Cloud and
  // Cloudkill.
  const cube = where("cube");
  if (cube)
    out.push(areaLoop("arcane", cube, { difficult: true, obscurement: "light" }, "Web", "cube", scale, 90));
  const column = where("cylinder");
  if (column)
    out.push(
      areaLoop("radiant", column, { light: { bright: 5, dim: 0 } }, "Moonbeam", "cylinder", scale, 91),
    );
  const round = where("sphere");
  if (round)
    for (const name of ["Stinking Cloud", "Cloudkill"])
      out.push(areaLoop("poison", round, { obscurement: "heavy" }, name, "sphere", scale, 92));
  return out;
}
