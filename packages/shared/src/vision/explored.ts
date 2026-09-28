/**
 * Explored memory (SPEC §15.5): the cells a player's viewers see now — in sight and lit, or within darkvision or
 * truesight — are ORed into the player's explored raster.
 */
import type { ViewerSight } from "./perceive.ts";
import { type CellRect, fillVis, type LightRaster, type Raster } from "./raster.ts";
import { DARK, type VisionWorld } from "./world.ts";

/**
 * Marks the cells the viewers see now in `out` (only within `clips` when given: the viewers haven't moved and only the
 * light there changed). Returns the rectangle of cells newly marked, or null when nothing new was seen.
 */
export function markSeen(
  world: VisionWorld,
  light: LightRaster,
  viewers: readonly ViewerSight[],
  out: Raster,
  clips?: readonly CellRect[],
): CellRect | null {
  let i0 = Number.POSITIVE_INFINITY;
  let j0 = Number.POSITIVE_INFINITY;
  let i1 = -1;
  let j1 = -1;
  for (const vs of viewers) {
    if (!vs.sight) continue;
    const v = vs.v;
    const dark = Math.max(v.senses.darkvision, v.senses.truesight);
    const dark2 = dark * dark - v.elevation * v.elevation;
    const checkDarkness = world.obscurers.length > 0;
    const mark = (k: number, cx: number, cy: number) => {
      if (out.data[k]) return;
      let seen = light.levelAt(cx, cy) > DARK;
      if (!seen && dark > 0) {
        const d2 = (cx - v.x) ** 2 + (cy - v.y) ** 2;
        seen =
          d2 <= dark2 &&
          (!checkDarkness ||
            !world.inMagicalDarkness(cx, cy) ||
            v.senses.truesight ** 2 >= d2 + v.elevation * v.elevation);
      }
      if (!seen) return;
      // Seen only if the sight line gets there (§15.3): not through fog or across magical darkness (truesight aside),
      // though a viewer inside fog still sees its own space.
      if (checkDarkness && !lineClear(world, vs, cx, cy)) return;
      out.data[k] = 1;
      const i = k % out.w;
      const j = (k - i) / out.w;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    };
    if (!clips) fillVis(out, vs.sight, mark);
    else for (const c of clips) if (c.w > 0 && c.h > 0) fillVis(out, vs.sight, mark, c);
  }
  return i1 < 0 ? null : { x: i0, y: j0, w: i1 - i0 + 1, h: j1 - j0 + 1 };
}

/** Whether no obscurer on the line from a viewer to a floor point hides that point from it (§15.3's volume test). */
function lineClear(world: VisionWorld, vs: ViewerSight, x: number, y: number): boolean {
  const v = vs.v;
  const d = Math.hypot(x - v.x, y - v.y, v.elevation);
  const truesight = v.senses.truesight >= d;
  const ownSpace = v.sizeFt !== undefined && Math.hypot(x - v.x, y - v.y) <= v.sizeFt / 2;
  for (const o of world.obscurersOn({ x: v.x, y: v.y, z: v.elevation }, { x, y, z: 0 })) {
    if (o.kind === "magicalDarkness" && !truesight) return false;
    if (o.kind === "heavy" && !ownSpace) return false;
  }
  return true;
}
