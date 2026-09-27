import { circleCrossings, inPolygon, type P, polygonCrossings } from "../geometry/index.ts";
import { type WorldZoneShape, zonePolygon } from "./build.ts";

/** Is p inside the zone (SPEC §8.7 Zones: polygon, rectangle or circle)? */
export function zoneContains(shape: WorldZoneShape, p: P): boolean {
  if (shape.kind === "circle") return Math.hypot(p.x - shape.x, p.y - shape.y) < shape.r;
  if (shape.kind === "rect")
    return p.x > shape.x && p.x < shape.x + shape.w && p.y > shape.y && p.y < shape.y + shape.h;
  return inPolygon(p, shape.points);
}

/**
 * Does a move along `points` go into the zone — starting outside it, and at some point inside? (A hazard's "on
 * enter" trigger fires once per move that does.)
 */
export function pathEnters(shape: WorldZoneShape, points: P[]): boolean {
  if (points.length < 2 || zoneContains(shape, points[0] as P)) return false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as P;
    const b = points[i] as P;
    if (zoneContains(shape, b)) return true;
    const crossings =
      shape.kind === "circle"
        ? circleCrossings(a, b, { x: shape.x, y: shape.y }, shape.r)
        : polygonCrossings(a, b, zonePolygon(shape));
    if (crossings.length) return true;
  }
  return false;
}

export interface HazardZoneLike {
  id: string;
  kind: string;
  label: string;
  shape: WorldZoneShape;
  triggers: {
    when: "enter" | "startTurn" | "endTurn";
    label: string;
    save?: { ability: string; dc: number; onSuccess: "half" | "none" };
    damage?: { formula: string; type: string };
  }[];
}

export interface HazardPrompt {
  zoneId: string;
  zoneLabel: string;
  when: "enter" | "startTurn" | "endTurn";
  label: string;
  save?: { ability: string; dc: number; onSuccess: "half" | "none" };
  damage?: { formula: string; type: string };
}

/**
 * The DM prompts a hazard owes (SPEC §8.7 Zones: on enter, at the start of a turn inside, at the end of a turn
 * inside): for a move (`path`), the enter triggers of every hazard it goes into; for a turn moment, the matching
 * triggers of every hazard the creature stands in.
 */
export function hazardPrompts(
  zones: Iterable<HazardZoneLike>,
  moment: { when: "enter"; path: P[] } | { when: "startTurn" | "endTurn"; at: P },
): HazardPrompt[] {
  const out: HazardPrompt[] = [];
  for (const z of zones) {
    if (z.kind !== "hazard") continue;
    const hit = moment.when === "enter" ? pathEnters(z.shape, moment.path) : zoneContains(z.shape, moment.at);
    if (!hit) continue;
    for (const t of z.triggers)
      if (t.when === moment.when)
        out.push({
          zoneId: z.id,
          zoneLabel: z.label,
          when: t.when,
          label: t.label,
          ...(t.save ? { save: t.save } : {}),
          ...(t.damage ? { damage: t.damage } : {}),
        });
  }
  return out;
}
