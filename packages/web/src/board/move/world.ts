import { buildMoveWorld, type MoveWorld, navFor, type WorldZoneShape } from "@gloam/shared/movement";
import type { WallView, ZoneView } from "@gloam/shared/state";
import { boardData, useEntities } from "../../state/entities.ts";
import { boundsFromJson } from "../scene.ts";

/**
 * The browser's movement world (SPEC §16.1): the walls this viewer knows (a player's view has no hidden walls;
 * secret doors are walls to them) and the zones they can see, built with the same shared code as the server's. Kept
 * until the walls, zones or bounds change — so the pathfinder's caches inside it (nodes, edges, connectivity) serve
 * every preview of a drag.
 */
let cached: {
  walls: Map<string, WallView>;
  zones: Map<string, ZoneView>;
  bounds: string;
  byKind: Map<string, MoveWorld>;
} | null = null;

export function clientMoveWorld(creature: { swim: boolean } = { swim: false }): MoveWorld | null {
  const d = boardData(useEntities.getState());
  if (!d.scene) return null;
  if (!cached || cached.walls !== d.walls || cached.zones !== d.zones || cached.bounds !== d.scene.boundsJson)
    cached = { walls: d.walls, zones: d.zones, bounds: d.scene.boundsJson, byKind: new Map() };
  const key = creature.swim ? "swim" : "walk";
  let world = cached.byKind.get(key);
  if (!world) {
    world = buildMoveWorld({
      walls: [...d.walls.values()].map((w) => ({
        id: w.id,
        a: { x: w.ax, y: w.ay },
        b: { x: w.bx, y: w.by },
        // DMs hold the true kind; players the player-safe one (which is what their moves are planned against).
        kind: w.dmKind ?? w.kind,
        doorState: (w.door || null) as "open" | "closed" | "locked" | null,
      })),
      zones: [...d.zones.values()].flatMap((z) => {
        const shape = parseShape(z.shapeJson);
        return shape ? [{ id: z.id, kind: z.kind, shape }] : [];
      }),
      bounds: boundsFromJson(d.scene.boundsJson),
      creature,
    });
    cached.byKind.set(key, world);
  }
  return world;
}

function parseShape(json: string): WorldZoneShape | null {
  try {
    const s = JSON.parse(json) as WorldZoneShape;
    return s && typeof s === "object" && "kind" in s ? s : null;
  } catch {
    return null;
  }
}

/**
 * Builds a creature size's search structures ahead of its first drag (≈ 10 ms on 500 walls), in idle time — a
 * token was selected, so a drag may follow.
 */
export function prewarm(rc: number, creature: { swim: boolean } = { swim: false }): void {
  const run = () => {
    const w = clientMoveWorld(creature);
    if (w) navFor(w, rc);
  };
  const idle = (globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (idle) idle(run, { timeout: 500 });
  else setTimeout(run, 50);
}
