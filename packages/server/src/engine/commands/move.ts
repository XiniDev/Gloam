import { dist, type P, pathLength } from "@gloam/shared/geometry";
import { clearanceRadius, pathCost, validateMove } from "@gloam/shared/movement";
import { GloamError, MoveCommit } from "@gloam/shared/protocol";
import { controlsToken, effectiveTokenState, isDm } from "@gloam/shared/rules";
import type { TokenEntity } from "@gloam/shared/schemas";
import type { z } from "zod";
import type { CommandDef, RoomEvent } from "../commandBus.ts";
import { moveWorldOf } from "../movement.ts";
import type { Op } from "../ops.ts";
import { mustGet, setOps } from "../plan.ts";

/** Visual speed of a committed move (SPEC §8.6 Others see planning): 30 ft/s, at least 250 ms, at most 2 s. */
export const MOVE_FT_PER_S = 30;
export const moveDurationMs = (lengthFt: number): number =>
  Math.round(Math.min(2000, Math.max(250, (lengthFt / MOVE_FT_PER_S) * 1000)));

export interface MoveResult {
  /** The path as committed (truncated at a collision, if any). */
  points: P[];
  /** Its cost in feet (§16.4). */
  cost: number;
  /** Stopped short at an obstacle. */
  bumped: boolean;
  /** …one the mover couldn't see (the "You bump into something unseen" toast). */
  unseen: boolean;
  durationMs: number;
}

/**
 * `move.commit` (SPEC §8.6 Commit, §16.5): a controller's move along the path it previewed. The server walks it
 * against the true obstacles — every wall, hidden or not, and impassable zones — truncating at the first contact
 * (a hidden one gets the "unseen" toast), prices it, and moves the token; everyone who can see the token then
 * animates it along the committed path (`token.moved`). DM moves ignore blocking (§8.6 DM moves). Budgets, turn
 * order and speed-zero conditions join with combat (Phase 8), creature spaces with it too.
 */
export const moveCommit: CommandDef<z.infer<typeof MoveCommit>, MoveResult> = {
  type: "move.commit",
  schema: MoveCommit,
  undoable: true,
  authorize(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    if (!controlsToken(ctx.actor.role, ctx.actor.userId, t))
      throw new GloamError("FORBIDDEN", "You can't move that token.");
    if (isDm(ctx.actor.role)) return;
    if (t.locked) throw new GloamError("MOVEMENT_LOCKED", "The DM locked this token.");
    if (t.overrides.lockMovement) throw new GloamError("MOVEMENT_LOCKED", "This token's movement is locked.");
  },
  plan(ctx, p) {
    const t = mustGet(ctx, "token", p.tokenId);
    const scene = mustGet(ctx, "scene", t.sceneId);
    const dm = isDm(ctx.actor.role);
    // §16.5 step 3: the path starts where the token stands, stays in the scene, one elevation per point.
    if (dist(p.points[0] as P, t.pos) > 0.5)
      throw new GloamError("INVALID", "The move has to start where the token stands.");
    const b = scene.bounds;
    for (const q of p.points)
      if (q.x < b.minX - 1e-6 || q.x > b.maxX + 1e-6 || q.y < b.minY - 1e-6 || q.y > b.maxY + 1e-6)
        throw new GloamError("INVALID", "The path leaves the scene.");
    if (p.elevations && p.elevations.length !== p.points.length)
      throw new GloamError("INVALID", "One elevation per path point.");
    // The path begins exactly at the token (a sub-half-foot difference is the client's rounding).
    const points: P[] = [{ ...t.pos }, ...p.points.slice(1).map((q) => ({ x: q.x, y: q.y }))];
    const actor = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
    const { stats, status } = effectiveTokenState(t, actor);
    const world = moveWorldOf(ctx.model, t.sceneId, { swim: stats.speeds.swim > 0 });
    // Prone and not standing up: crawling, +1 per foot (§16.4). Standing up is a combat action (Phase 8).
    const crawl = status.conditions.some((c) => c.id === "prone");
    let path = points;
    let bumped = false;
    let unseen = false;
    let cost: number;
    if (dm) cost = pathCost(world, path, { crawl }).cost;
    else {
      const rc = clearanceRadius(t.sizeFt, ctx.model.campaign.houseRules.squeeze);
      const v = validateMove(world, points, { rc, crawl }, null);
      if ("error" in v) throw new GloamError("OVER_BUDGET", "Not enough movement left.");
      path = v.points;
      bumped = v.bumped;
      cost = v.cost;
      if (v.hitWall !== null) unseen = hiddenFromPlayers(ctx.model, world.walls[v.hitWall]?.id);
    }
    const end = path[path.length - 1] as P;
    const elevation =
      p.elevations && !bumped ? (p.elevations[p.elevations.length - 1] as number) : t.elevation;
    const patch: Partial<TokenEntity> = {};
    if (dist(end, t.pos) > 1e-6) patch.pos = end;
    // A 3D mini ends facing the way it walked (campaign setting Auto-facing, §16.7): its last real heading.
    if (patch.pos && t.appearance.mode === "model" && ctx.model.campaign.settings.autoFacing) {
      for (let i = path.length - 1; i > 0; i--) {
        const a = path[i - 1] as P;
        const b = path[i] as P;
        if (dist(a, b) < 0.05) continue;
        const heading = Math.atan2(b.x - a.x, b.y - a.y);
        const deg = Math.round(((((-heading * 180) / Math.PI) % 360) + 360) % 360);
        if (deg !== t.rotationDeg) patch.rotationDeg = deg;
        break;
      }
    }
    if (elevation !== t.elevation) patch.elevation = Math.max(-1000, Math.round(elevation / 5) * 5);
    const ops: Op[] = setOps("token", t, patch);
    const light = t.lightId ? ctx.model.get("light", t.lightId) : undefined;
    if (light && patch.pos) ops.push(...setOps("light", light, { pos: patch.pos }));
    if (ops.length)
      ops.push({ k: "set", e: "token", id: t.id, path: ["updatedAt"], value: ctx.now, prev: t.updatedAt });
    const durationMs = moveDurationMs(pathLength(path));
    const events: RoomEvent[] = [];
    if (patch.pos)
      events.push({
        name: "token.moved",
        payload: { id: t.id, path, durationMs },
        to: { viewersOf: t.id },
      });
    if (unseen)
      events.push({
        name: "toast",
        payload: { kind: "info", message: "You bump into something unseen." },
        to: { users: [ctx.actor.userId] },
      });
    return {
      ops,
      summary: `Moved ${t.name} ${Math.round(cost * 2) / 2} ft`,
      sceneId: t.sceneId,
      events,
      result: { points: path, cost, bumped, unseen, durationMs },
    };
  },
};

/** Is this wall (or impassable zone) something players aren't shown? */
function hiddenFromPlayers(model: Parameters<typeof moveWorldOf>[0], id: string | undefined): boolean {
  if (!id) return false;
  const wall = model.get("wall", id);
  if (wall) return wall.hidden;
  const zone = model.get("zone", id);
  return zone ? !zone.visible : false;
}

export const MOVE_COMMANDS = [moveCommit] as unknown as CommandDef<never, unknown>[];
