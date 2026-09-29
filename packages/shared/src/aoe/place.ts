/**
 * Placing a spell's area (SPEC §17.1–17.2): the template the caster aims becomes the area stored on its effect and its
 * card. Spheres and cylinders stand on the chosen point; self-origin cones, lines and cubes start at the caster's base
 * edge in the aimed direction (the caster is outside them); a ranged cube is centred on its point; an emanation comes
 * from the caster (or what it's cast on); a wall runs along its points. The client's live template and the server's
 * cast both place it here.
 */
import type { AreaShape } from "../schemas/entities.ts";
import type { SpellArea } from "../schemas/spell.ts";
import { dirOf } from "./index.ts";

export interface Placement {
  origin: { x: number; y: number; z: number };
  dirDeg: number;
  /** A wall's points as drawn, and whether it closes into a ring. */
  points?: { x: number; y: number }[] | undefined;
  closed?: boolean | undefined;
  /** The DM's own size (radius, length, side or distance). */
  size?: number | undefined;
  /** What an emanation comes from, when not the caster (Darkness on a held object). */
  attachTo?: string | undefined;
}

export interface CasterBody {
  id: string;
  pos: { x: number; y: number };
  sizeFt: number;
  elevation: number;
}

/**
 * The area as placed. `area` is already at its slot (areaAtSlot); `self` says the spell's range is Self (its cones,
 * lines and cubes start at the caster).
 */
export function placeArea(area: SpellArea, self: boolean, pl: Placement, caster: CasterBody): AreaShape {
  const size = pl.size;
  const d = dirOf(pl.dirDeg);
  const r = caster.sizeFt / 2;
  const edge = { x: caster.pos.x + d.x * r, y: caster.pos.y + d.y * r, z: caster.elevation };
  const at = { x: pl.origin.x, y: pl.origin.y, z: pl.origin.z };
  switch (area.shape) {
    case "sphere":
      return {
        kind: "sphere",
        origin: self ? { x: caster.pos.x, y: caster.pos.y, z: caster.elevation } : at,
        radius: size ?? area.radius,
      };
    case "cylinder":
      return { kind: "cylinder", origin: at, radius: size ?? area.radius, height: area.height };
    case "cone":
      return { kind: "cone", origin: edge, dirDeg: pl.dirDeg, length: size ?? area.length };
    case "line":
      return {
        kind: "line",
        origin: self ? edge : at,
        dirDeg: pl.dirDeg,
        length: size ?? area.length,
        width: area.width,
      };
    case "cube":
      return self
        ? { kind: "cube", origin: edge, dirDeg: pl.dirDeg, size: size ?? area.size, originOnFace: true }
        : { kind: "cube", origin: at, dirDeg: pl.dirDeg, size: size ?? area.size, originOnFace: false };
    case "emanation":
      return { kind: "emanation", sourceTokenId: pl.attachTo ?? caster.id, distance: size ?? area.distance };
    case "wall":
      return {
        kind: "wall",
        points: pl.points ?? [
          { x: at.x, y: at.y },
          { x: at.x + d.x * area.length, y: at.y + d.y * area.length },
        ],
        closed: pl.closed === true,
        height: pl.closed && area.ringHeight ? area.ringHeight : area.height,
        thickness: area.thickness,
        opaque: area.opaque,
        blocksMove: area.blocksMove,
        ...(area.damagingSide ? { damagingSide: area.damagingSide } : {}),
      };
  }
}

/** A wall's drawn length (a ring's circumference, closing back to its start). */
export function wallLength(points: readonly { x: number; y: number }[], closed: boolean): number {
  let len = 0;
  const n = points.length;
  for (let i = 0; i + 1 < n + (closed ? 1 : 0); i++) {
    const a = points[i] as { x: number; y: number };
    const b = points[(i + 1) % n] as { x: number; y: number };
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

/** The longest a wall of this spell may be drawn (a ring's circumference when it closes). */
export function wallMax(area: SpellArea, closed: boolean): number {
  if (area.shape !== "wall") return 0;
  return closed && area.ring ? Math.PI * area.ring : area.length;
}
