import { SIZES, type Size } from "../constants.ts";
import type { P } from "../geometry/index.ts";
import { MoveWorld, type Region } from "./world.ts";

/**
 * Creature spaces (SPEC §8.6 "Creature spaces", SRD 5.2.1 p. 14; AC-MOV-16): what other creatures' bases do to a
 * player's move, when the house rule enforces it. An ally's space is free to pass through; a non-ally's space can be
 * passed through only if that creature is Tiny, Incapacitated, or two or more sizes larger or smaller than the mover —
 * and such a space (unless the creature is Tiny) is difficult terrain; any other non-ally blocks. A move may not end
 * with its base overlapping another creature's by more than half the smaller diameter. SRD 5.1: any non-hostile
 * creature can be passed through; a hostile one only if two or more sizes different. DM moves ignore all of this.
 */

export type Side = "party" | "friendly" | "neutral" | "hostile";

export interface SpaceCreature {
  id: string;
  pos: P;
  /** Its base's diameter (ft). */
  sizeFt: number;
  size: Size;
  disposition: Side;
  incapacitated: boolean;
}

/** Whether two creatures are on the same side (the party and its friends; hostiles together; a neutral alone). */
export function allies(a: Side, b: Side): boolean {
  const side = (s: Side) =>
    s === "party" || s === "friendly" ? "party" : s === "hostile" ? "hostile" : null;
  const x = side(a);
  return x !== null && x === side(b);
}

const sizeIndex = (s: Size) => SIZES.indexOf(s);

/** How another creature's space treats the mover: free, difficult to pass, or a wall. */
export function spaceFor(
  mover: Pick<SpaceCreature, "size" | "disposition">,
  other: Pick<SpaceCreature, "size" | "disposition" | "incapacitated">,
  pack: "srd-5.2.1" | "srd-5.1" | string = "srd-5.2.1",
): "free" | "difficult" | "blocked" {
  const apart = Math.abs(sizeIndex(mover.size) - sizeIndex(other.size)) >= 2;
  if (pack === "srd-5.1") {
    // 5.1 (p. 92): through any non-hostile creature, a hostile one only if two or more sizes different — and
    // another creature's space, friend or foe, is difficult terrain.
    const hostile = allies(mover.disposition, "hostile")
      ? other.disposition === "party" || other.disposition === "friendly"
      : other.disposition === "hostile";
    return !hostile || apart ? "difficult" : "blocked";
  }
  if (allies(mover.disposition, other.disposition)) return "free";
  if (other.size === "tiny") return "free";
  if (other.incapacitated || apart) return "difficult";
  return "blocked";
}

/**
 * The world a player's move is checked against: the scene's, plus the other creatures' bases — solid where they
 * block, difficult where they can be passed through.
 */
export function withCreatureSpaces(
  base: MoveWorld,
  mover: SpaceCreature,
  others: readonly SpaceCreature[],
  pack?: string,
): MoveWorld {
  const solids = [...base.solids];
  const regions: Region[] = [...base.regions];
  for (const o of others) {
    if (o.id === mover.id) continue;
    const kind = spaceFor(mover, o, pack);
    if (kind === "blocked") solids.push({ c: o.pos, r: o.sizeFt / 2, id: `creature:${o.id}` });
    else if (kind === "difficult") regions.push({ circle: { c: o.pos, r: o.sizeFt / 2 }, kind: "difficult" });
  }
  return new MoveWorld({ walls: base.walls, solids, regions, bounds: base.bounds });
}

/**
 * Whether a creature may end its move at `at`: its base overlapping no other's by more than half the smaller
 * diameter (the depth of overlap, r₁ + r₂ − d, more than the smaller radius — i.e. centres closer than the larger
 * radius).
 */
export function endsClear(
  at: P,
  mover: Pick<SpaceCreature, "id" | "sizeFt">,
  others: readonly SpaceCreature[],
): boolean {
  const rm = mover.sizeFt / 2;
  for (const o of others) {
    if (o.id === mover.id) continue;
    const ro = o.sizeFt / 2;
    const d = Math.hypot(at.x - o.pos.x, at.y - o.pos.y);
    if (rm + ro - d > Math.min(rm, ro) + 1e-6) return false;
  }
  return true;
}

/**
 * The last point along a path where the move may end (walking back from its end), or null when none may (§16.5
 * step 6). Checks the path's vertices and points every foot along it.
 */
export function lastClearPoint(
  points: readonly P[],
  mover: Pick<SpaceCreature, "id" | "sizeFt">,
  others: readonly SpaceCreature[],
): { points: P[]; at: P } | null {
  for (let i = points.length - 1; i >= 1; i--) {
    const a = points[i - 1] as P;
    const b = points[i] as P;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len));
    for (let s = steps; s >= 0; s--) {
      const t = s / steps;
      const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (endsClear(q, mover, others)) {
        if (i === 1 && s === 0) return null; // only the start itself: no move
        return { points: [...points.slice(0, i), ...(t > 0 ? [q] : [])] as P[], at: q };
      }
    }
  }
  return null;
}
