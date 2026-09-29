import { areaPolygon, resolveViewArea } from "@gloam/shared/aoe";
import type { P } from "@gloam/shared/geometry";
import { buildMoveWorld, type MoveWorld, navFor, type WorldZoneShape } from "@gloam/shared/movement";
import type { AreaShape as StoredShape } from "@gloam/shared/schemas";
import type { EffectView, TokenView, WallView, ZoneView } from "@gloam/shared/state";
import { boardData, useEntities } from "../../state/entities.ts";
import { boundsFromJson } from "../scene.ts";

/**
 * The browser's movement world (SPEC §16.1): the walls this viewer knows (a player's view has no hidden walls;
 * secret doors are walls to them), the zones they can see, and the effects they can see that shape movement (solid
 * walls; slowing ground — Web, Spike Growth; halved Speed — Spirit Guardians, unless it spares this creature), built
 * with the same shared code as the server's. Kept until any of that changes — so the pathfinder's caches inside it
 * (nodes, edges, connectivity) serve every preview of a drag.
 */
let cached: {
  walls: Map<string, WallView>;
  zones: Map<string, ZoneView>;
  bounds: string;
  effects: string;
  byKind: Map<string, MoveWorld>;
} | null = null;

interface EffectGround {
  id: string;
  props: { difficult?: boolean; speedHalved?: boolean; opaque?: boolean };
  shape: StoredShape;
}

function groundOf(e: EffectView): EffectGround | null {
  try {
    const shape = JSON.parse(e.shapeJson) as StoredShape;
    const props = JSON.parse(e.propsJson) as EffectGround["props"];
    const walls = shape.kind === "wall" && shape.blocksMove;
    return walls || props.difficult || props.speedHalved ? { id: e.id, props, shape } : null;
  } catch {
    return null;
  }
}

/** The effects a creature is spared (Spirit Guardians' designated creatures): on its token, for its controllers. */
function sparedBy(t: TokenView | undefined): Set<string> {
  try {
    const ids = JSON.parse(t?.own?.spared || "[]") as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function clientMoveWorld(
  creature: { swim: boolean; id?: string } = { swim: false },
): MoveWorld | null {
  const d = boardData(useEntities.getState());
  if (!d.scene) return null;
  const ground = [...d.effects.values()].flatMap((e) => groundOf(e) ?? []);
  // What the effects are and where (an emanation's shape carries where its creature stands: it moves with it).
  const fx = ground.map((g) => `${g.id}:${JSON.stringify(g.shape)}:${JSON.stringify(g.props)}`).join("|");
  if (
    !cached ||
    cached.walls !== d.walls ||
    cached.zones !== d.zones ||
    cached.bounds !== d.scene.boundsJson ||
    cached.effects !== fx
  )
    cached = { walls: d.walls, zones: d.zones, bounds: d.scene.boundsJson, effects: fx, byKind: new Map() };
  // The effects this creature is spared (its controllers are told, on the token: the effect names no one, §13.4).
  const spared = sparedBy(creature.id ? d.tokens.get(creature.id) : undefined);
  const slowing = ground.filter(
    (g) => g.shape.kind !== "wall" && (g.props.difficult || g.props.speedHalved) && !spared.has(g.id),
  );
  // Creatures spared by the same effects share a world.
  const key = `${creature.swim ? "swim" : "walk"}|${slowing.map((g) => g.id).join(",")}`;
  let world = cached.byKind.get(key);
  if (!world) {
    const solid: { a: P; b: P; id: string }[] = [];
    for (const g of ground) {
      const sh = g.shape;
      if (sh.kind !== "wall" || !sh.blocksMove) continue;
      for (let i = 0; i + 1 < sh.points.length + (sh.closed ? 1 : 0); i++)
        solid.push({ a: sh.points[i] as P, b: sh.points[(i + 1) % sh.points.length] as P, id: g.id });
    }
    const slow = slowing.flatMap((g) => {
      // As sent (§13.4): an emanation where its creature stands, without naming it.
      const area = resolveViewArea(g.shape);
      const poly = area ? areaPolygon(area, 48) : null;
      return poly ? [{ poly, difficult: !!g.props.difficult, halved: !!g.props.speedHalved }] : [];
    });
    world = buildMoveWorld({
      walls: [...d.walls.values()].map((w) => ({
        id: w.id,
        a: { x: w.ax, y: w.ay },
        b: { x: w.bx, y: w.by },
        // DMs hold the true kind; players the player-safe one (which is what their moves are planned against).
        kind: w.dmKind ?? w.kind,
        doorState: (w.dmDoor || w.door || null) as "open" | "closed" | "locked" | null,
      })),
      zones: [...d.zones.values()].flatMap((z) => {
        const shape = parseShape(z.shapeJson);
        return shape ? [{ id: z.id, kind: z.kind, shape }] : [];
      }),
      bounds: boundsFromJson(d.scene.boundsJson),
      creature,
      solid,
      slow,
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
export function prewarm(rc: number, creature: { swim: boolean; id?: string } = { swim: false }): void {
  const run = () => {
    const w = clientMoveWorld(creature);
    if (w) navFor(w, rc);
  };
  const idle = (globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (idle) idle(run, { timeout: 500 });
  else setTimeout(run, 50);
}
