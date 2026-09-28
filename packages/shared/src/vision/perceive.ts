/**
 * Perception (SPEC §15.3–15.4): what a viewer perceives at a point, and whether a player's viewers see a creature,
 * sense it (tremorsense), or neither.
 */
import type { VisPoly } from "../geometry/index.ts";
import { visContains } from "../geometry/index.ts";
import type { SensesT } from "../schemas/entities.ts";
import { BRIGHT, DARK, DIM, type LightLevel, type VisionWorld } from "./world.ts";

/** What a viewer perceives at a point. */
export const NONE = 0;
export const BLIND = 1;
export const SEE_BRIGHT = 2;
export const SEE_DIM = 3;
export const DARKVISION = 4;
export type Perceived = 0 | 1 | 2 | 3 | 4;

export interface Viewer {
  x: number;
  y: number;
  elevation: number;
  senses: SensesT;
  seeInvisible?: boolean;
  blinded?: boolean;
  unconscious?: boolean;
}

/** A viewer with its line-of-sight polygons (compute once per viewer position). */
export interface ViewerSight {
  v: Viewer;
  /** `LOS_sight` out to the scene's diagonal (null when the viewer can't see: Blinded or Unconscious). */
  sight: VisPoly | null;
  /** `LOS_blind` out to its blindsight range (null without blindsight). */
  blind: VisPoly | null;
}

export function prepareViewer(world: VisionWorld, v: Viewer): ViewerSight {
  const canSee = !v.blinded && !v.unconscious;
  return {
    v,
    sight: canSee ? world.geo.losSight(v.x, v.y, world.sightRadius) : null,
    blind:
      !v.unconscious && v.senses.blindsight > 0
        ? world.geo.losBlind(v.x, v.y, v.senses.blindsight + v.elevation + 1)
        : null,
  };
}

/**
 * `perceive(v, p)` (§15.3). z is p's height above the table; `minLight` raises the light there (a creature carrying
 * its own light is lit where it stands).
 */
export function perceivePoint(
  world: VisionWorld,
  vs: ViewerSight,
  x: number,
  y: number,
  z = 0,
  minLight: LightLevel = DARK,
): Perceived {
  const v = vs.v;
  if (v.unconscious) return NONE;
  const d = Math.hypot(x - v.x, y - v.y, z - v.elevation);
  if (vs.blind && v.senses.blindsight >= d && visContains(vs.blind, x, y)) return BLIND;
  if (v.blinded || !vs.sight) return NONE;
  if (!visContains(vs.sight, x, y)) return NONE;
  const truesight = v.senses.truesight >= d;
  if (world.obscurers.length) {
    for (const o of world.obscurersOn({ x: v.x, y: v.y, z: v.elevation }, { x, y, z })) {
      if (o.kind === "magicalDarkness" && !truesight) return NONE;
      if (o.kind === "heavy") return NONE;
    }
  }
  const L = Math.max(world.lightLevelCached(x, y, z), minLight);
  if (L === BRIGHT) return SEE_BRIGHT;
  if (L === DIM) return v.senses.darkvision >= d ? SEE_BRIGHT : SEE_DIM;
  if (truesight) return DARKVISION;
  if (v.senses.darkvision >= d && !world.inMagicalDarkness(x, y, z)) return DARKVISION;
  return NONE;
}

export interface Creature {
  x: number;
  y: number;
  elevation: number;
  /** The creature's space (ft); its base radius is half that. */
  sizeFt: number;
  invisible?: boolean;
  /** Outlined (Faerie Fire): invisibility doesn't hide it. */
  outlined?: boolean;
  /** Flying or incorporeal: tremorsense can't feel it. */
  flying?: boolean;
}

/** The 9 sample points of a creature (§15.4): its centre and 8 around it at 0.8 × its base radius. */
export function creatureSamples(c: Creature): { x: number; y: number }[] {
  const r = 0.8 * (c.sizeFt / 2);
  const out = [{ x: c.x, y: c.y }];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return out;
}

export type CreaturePerception = "seen" | "sensed" | "none";

/** Whether a player's viewers perceive a creature (§15.4 steps 2–4; ownership and `revealTo` are the caller's). */
export function perceiveCreature(
  world: VisionWorld,
  viewers: readonly ViewerSight[],
  c: Creature,
  selfLight: LightLevel = DARK,
): CreaturePerception {
  if (!viewers.length) return "none";
  const samples = creatureSamples(c);
  const hidden = c.invisible === true && c.outlined !== true;
  for (const vs of viewers) {
    const v = vs.v;
    if (v.unconscious) continue;
    for (const s of samples) {
      const p = perceivePoint(world, vs, s.x, s.y, c.elevation, selfLight);
      if (p === NONE) continue;
      if (!hidden || p === BLIND) return "seen";
      const d = Math.hypot(s.x - v.x, s.y - v.y, c.elevation - v.elevation);
      if (v.senses.truesight >= d || v.seeInvisible) return "seen";
    }
  }
  if (c.elevation === 0 && !c.flying)
    for (const vs of viewers) {
      const v = vs.v;
      if (v.unconscious || v.senses.tremorsense <= 0) continue;
      if (v.senses.tremorsense >= Math.hypot(c.x - v.x, c.y - v.y, c.elevation - v.elevation))
        return "sensed";
    }
  return "none";
}

/** Grading classes a client renders (§15.7): the best a player's viewers get at a point. */
export function bestPerceived(
  world: VisionWorld,
  viewers: readonly ViewerSight[],
  x: number,
  y: number,
): Perceived {
  let best: Perceived = NONE;
  for (const vs of viewers) {
    const p = perceivePoint(world, vs, x, y);
    if (p === SEE_BRIGHT) return p;
    if (p !== NONE && (best === NONE || rank(p) > rank(best))) best = p;
  }
  return best;
}
const rank = (p: Perceived) =>
  p === SEE_BRIGHT ? 4 : p === SEE_DIM ? 3 : p === DARKVISION ? 2 : p === BLIND ? 1 : 0;
