/**
 * A persistent effect's area on the board (SPEC §8.13 Persistent effects, §17.1): the shape as stored (an origin with
 * its height, or the creature an emanation comes from) resolved to the geometry everything else reads — the vision
 * engine's obscuring volumes and lights, the movement world's slow ground, the triggers' "inside", the board's
 * drawing. One place, so what a player sees, pays to cross and gets hurt by are the same area.
 */
import { circlePolygon, type P } from "../geometry/index.ts";
import type { AreaShape as StoredShape } from "../schemas/entities.ts";
import { type AreaShape, footprint } from "./index.ts";

/** A creature's body where an area needs it: its base's centre and radius, its base elevation and height (ft). */
export interface Body {
  pos: P;
  r: number;
  z: number;
  height: number;
}

/**
 * The area of a stored shape: an emanation measured from its source's space (null while the source isn't on the
 * scene — the area goes with it).
 */
export function resolveArea(shape: StoredShape, source: (tokenId: string) => Body | null): AreaShape | null {
  switch (shape.kind) {
    case "sphere":
      return { kind: "sphere", origin: pt(shape.origin), z: shape.origin.z, radius: shape.radius };
    case "cylinder":
      return {
        kind: "cylinder",
        origin: pt(shape.origin),
        z: shape.origin.z,
        radius: shape.radius,
        height: shape.height,
      };
    case "cone":
      return {
        kind: "cone",
        origin: pt(shape.origin),
        z: shape.origin.z,
        dirDeg: shape.dirDeg,
        length: shape.length,
      };
    case "cube":
      return {
        kind: "cube",
        origin: pt(shape.origin),
        z: shape.origin.z,
        dirDeg: shape.dirDeg,
        size: shape.size,
        originOnFace: shape.originOnFace,
      };
    case "line":
      return {
        kind: "line",
        origin: pt(shape.origin),
        z: shape.origin.z,
        dirDeg: shape.dirDeg,
        length: shape.length,
        width: shape.width,
      };
    case "emanation": {
      const b = source(shape.sourceTokenId);
      if (!b) return null;
      return {
        kind: "emanation",
        source: b.pos,
        sourceRadius: b.r,
        z: b.z,
        sourceHeight: b.height,
        distance: shape.distance,
      };
    }
    case "wall":
      return {
        kind: "wall",
        points: shape.points,
        closed: shape.closed,
        height: shape.height,
        thickness: shape.thickness,
      };
  }
}

const pt = (v: { x: number; y: number }): P => ({ x: v.x, y: v.y });

/**
 * The area's outline as a polygon (circles as `n`-gons that contain the circle), for the vision engine and the
 * movement world; a wall is its segments' business, not an outline (null).
 */
export function areaPolygon(a: AreaShape, n = 48): P[] | null {
  const f = footprint(a);
  if (f.kind === "circle") return circlePolygon(f.c, f.r, n, true);
  if (f.kind === "poly") return f.points;
  return null;
}

/** The whole area's vertical extent (a cone's at its far end). */
export function areaHeight(a: AreaShape): [number, number] {
  const z = a.z ?? 0;
  switch (a.kind) {
    case "sphere":
      return [z - a.radius, z + a.radius];
    case "cylinder":
      return [z, z + a.height];
    case "cone":
      return [z - a.length / 2, z + a.length / 2];
    case "cube":
      return [z, z + a.size];
    case "line":
      return [z - a.width / 2, z + a.width / 2];
    case "emanation":
      return [z - a.distance, z + (a.sourceHeight ?? 0) + a.distance];
    case "wall":
      return [z, z + a.height];
  }
}
