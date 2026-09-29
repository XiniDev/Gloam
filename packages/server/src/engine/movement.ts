import { buildMoveWorld, type MoveWorld } from "@gloam/shared/movement";
import { effectSlow, effectWalls, slowingEffects } from "../vision/sources.ts";
import type { CampaignModel } from "./model.ts";

/**
 * The server's movement worlds (SPEC §16.1, the true obstacle set: every wall, hidden or not, and every zone),
 * one per scene and creature kind (swimmers treat water as normal ground; a creature an effect spares — Spirit
 * Guardians' designated creatures — doesn't pay its slowing). Rebuilt only when the scene's walls, zones, bounds or
 * movement-shaping effects change, so the pathfinder's caches inside the world live as long as that geometry does.
 */
const worlds = new WeakMap<CampaignModel, Map<string, { v: number; byKind: Map<string, MoveWorld> }>>();

export function moveWorldOf(
  model: CampaignModel,
  sceneId: string,
  creature: { swim: boolean; id?: string },
): MoveWorld {
  let perScene = worlds.get(model);
  if (!perScene) {
    perScene = new Map();
    worlds.set(model, perScene);
  }
  const v = model.geometryVersion(sceneId);
  let entry = perScene.get(sceneId);
  if (!entry || entry.v !== v) {
    entry = { v, byKind: new Map() };
    perScene.set(sceneId, entry);
  }
  const slow = slowingEffects(model, sceneId, creature.id);
  // Creatures spared by the same effects share a world.
  const key = `${creature.swim ? "swim" : "walk"}|${slow.map((e) => e.id).join(",")}`;
  let world = entry.byKind.get(key);
  if (!world) {
    const scene = model.get("scene", sceneId);
    if (!scene) throw new Error(`scene ${sceneId} not found`);
    world = buildMoveWorld({
      walls: model.inScene("wall", sceneId),
      zones: model.inScene("zone", sceneId),
      bounds: scene.bounds,
      creature,
      solid: effectWalls(model, sceneId, "move"),
      slow: effectSlow(model, slow),
    });
    entry.byKind.set(key, world);
  }
  return world;
}
