import type { Spell } from "@gloam/shared/schemas";
import type { Bounds } from "../../board/scene.ts";

interface At {
  id: string;
  pos: { x: number; y: number };
  sizeFt: number;
}

/** How far from its caster a spell reaches for aiming (ft): its range, a touch's 5, else its area's size. */
export function aimReach(spell: Pick<Spell, "range" | "area">): number {
  const r = spell.range;
  if (r.kind === "ranged" && typeof r.ft === "number") return r.ft;
  if (r.kind === "touch") return 5;
  if (r.kind === "self") {
    const a = spell.area as
      | { radius?: number; length?: number; size?: number; distance?: number }
      | undefined;
    return Math.max(5, a?.radius ?? a?.length ?? a?.size ?? a?.distance ?? 5);
  }
  // Sight, unlimited, special: as far as a phone's view of the table can usefully show.
  return 120;
}

/**
 * The part of the table a phone frames while a spell is aimed (critic P9 r1 #18: the whole scene letterboxed left
 * tokens 12–16 px, too small to tap): its caster and every creature within its reach, a margin round them, at least
 * `minFt` across, inside the scene. Null without a caster on the board.
 */
export function aimFrame(
  casterId: string,
  reachFt: number,
  tokens: Iterable<At>,
  scene: Bounds,
  minFt = 30,
): Bounds | null {
  const all = [...tokens];
  const caster = all.find((t) => t.id === casterId);
  if (!caster) return null;
  const c = caster.pos;
  let minX = c.x - 10;
  let maxX = c.x + 10;
  let minY = c.y - 10;
  let maxY = c.y + 10;
  for (const t of all) {
    if (t === caster) continue;
    if (Math.hypot(t.pos.x - c.x, t.pos.y - c.y) > reachFt + t.sizeFt / 2) continue;
    minX = Math.min(minX, t.pos.x - t.sizeFt / 2 - 5);
    maxX = Math.max(maxX, t.pos.x + t.sizeFt / 2 + 5);
    minY = Math.min(minY, t.pos.y - t.sizeFt / 2 - 5);
    maxY = Math.max(maxY, t.pos.y + t.sizeFt / 2 + 5);
  }
  // At least minFt across each way (about its middle), then slid inside the scene — not cut at its edge, which would
  // undo the least — and cut only where the scene itself is smaller.
  const fit = (lo: number, hi: number, smin: number, smax: number): [number, number] => {
    const need = minFt - (hi - lo);
    let a = need > 0 ? lo - need / 2 : lo;
    let b = need > 0 ? hi + need / 2 : hi;
    if (a < smin) [a, b] = [smin, b + (smin - a)];
    if (b > smax) [a, b] = [a - (b - smax), smax];
    return [Math.max(smin, a), Math.min(smax, b)];
  };
  [minX, maxX] = fit(minX, maxX, scene.minX, scene.maxX);
  [minY, maxY] = fit(minY, maxY, scene.minY, scene.maxY);
  return { minX, maxX, minY, maxY };
}
