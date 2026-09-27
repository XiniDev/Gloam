import { circlePolygon, type P, rectPolygon } from "../geometry/index.ts";
import { blocksMove, type DoorState } from "./blocking.ts";
import { type Bounds, MoveWorld, type Region } from "./world.ts";

/** A wall as either side knows it (the server: every wall; a player: the walls in their view). */
export interface WorldWall {
  id: string;
  a: P;
  b: P;
  kind: string;
  doorState?: DoorState | null;
}

export type WorldZoneShape =
  | { kind: "polygon"; points: P[] }
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; x: number; y: number; r: number };

export interface WorldZone {
  id: string;
  kind: string;
  shape: WorldZoneShape;
}

export interface WorldCreature {
  /** Can swim: water isn't difficult terrain for it (§19.4). */
  swim?: boolean;
}

/** A zone's outline as a polygon (circles as 48-gons containing the circle). */
export function zonePolygon(shape: WorldZoneShape): P[] {
  if (shape.kind === "polygon") return shape.points;
  if (shape.kind === "rect") return rectPolygon(shape.x, shape.y, shape.w, shape.h);
  return circlePolygon({ x: shape.x, y: shape.y }, shape.r, 48, true);
}

/**
 * The movement world of a scene (§16.1) from its walls and zones, built the same way by the browser (its known walls
 * and visible zones) and the server (all of them): movement-blocking walls by the blocking matrix, impassable zones'
 * outlines as walls, difficult terrain as cost regions, and water as difficult terrain for creatures that can't swim.
 */
export function buildMoveWorld(input: {
  walls: Iterable<WorldWall>;
  zones: Iterable<WorldZone>;
  bounds: Bounds;
  creature?: WorldCreature;
}): MoveWorld {
  const walls: { a: P; b: P; id?: string }[] = [];
  for (const w of input.walls)
    if (blocksMove(w.kind, w.doorState)) walls.push({ a: { ...w.a }, b: { ...w.b }, id: w.id });
  const regions: Region[] = [];
  for (const z of input.zones) {
    if (z.kind === "impassable") {
      const poly = zonePolygon(z.shape);
      for (let i = 0; i < poly.length; i++)
        walls.push({ a: poly[i] as P, b: poly[(i + 1) % poly.length] as P, id: z.id });
    } else if (z.kind === "difficult" || (z.kind === "water" && !input.creature?.swim)) {
      if (z.shape.kind === "circle")
        regions.push({ circle: { c: { x: z.shape.x, y: z.shape.y }, r: z.shape.r } });
      else regions.push({ poly: zonePolygon(z.shape) });
    }
  }
  return new MoveWorld({ walls, regions, bounds: input.bounds });
}
