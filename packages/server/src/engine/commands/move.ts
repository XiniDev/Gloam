import { SIZES, type Size } from "@gloam/shared";
import { dist, type P, pathLength } from "@gloam/shared/geometry";
import {
  clampToBudget,
  clearanceRadius,
  flightCost,
  hazardPrompts,
  lastClearPoint,
  maxMoveLength,
  pathCost,
  type SpaceCreature,
  validateMove,
  withCreatureSpaces,
} from "@gloam/shared/movement";
import { GloamError, MoveCommit } from "@gloam/shared/protocol";
import {
  controlsToken,
  effectiveTokenState,
  incapacitates,
  isDm,
  speedZeroCondition,
  statusName,
} from "@gloam/shared/rules";
import type { TokenEntity } from "@gloam/shared/schemas";
import type { z } from "zod";
import type { CommandDef, RoomEvent } from "../commandBus.ts";
import { moveWorldOf } from "../movement.ts";
import type { Op } from "../ops.ts";
import { mustGet, setOps, setPathOp } from "../plan.ts";
import { combatOn, dataOf, movementOf, onItsTurn } from "./combat.ts";

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
    // In combat (§16.5 step 1): only the creature whose turn it is, unless it (or everyone) moves freely.
    const c = combatOn(ctx.model, t.sceneId);
    if (c && dataOf(c).combatants.some((e) => e.tokenId === t.id) && !onItsTurn(ctx, c, t))
      throw new GloamError(
        "NOT_YOUR_TURN",
        dataOf(c).begun ? "It isn't this creature's turn." : "Initiative is still being found.",
      );
    // Speed-0 conditions (§16.5 step 2, AC-MOV-09): no move at all, and why.
    if (!t.overrides.ignoreConditionSpeed) {
      const actor = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
      const { status } = effectiveTokenState(t, actor);
      const zero = speedZeroCondition(status.conditions.map((x) => x.id));
      if (zero) throw new GloamError("SPEED_ZERO", `${t.name} can't move — ${statusName(zero)}.`);
    }
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
    if (pathLength(p.points) > maxMoveLength(b))
      throw new GloamError("INVALID", "That route is too long for one move — go in stages.");
    // The path begins exactly at the token (a sub-half-foot difference is the client's rounding).
    const points: P[] = [{ ...t.pos }, ...p.points.slice(1).map((q) => ({ x: q.x, y: q.y }))];
    const actor = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
    const { stats, status } = effectiveTokenState(t, actor);
    const rules = ctx.model.campaign.houseRules;
    const base = moveWorldOf(ctx.model, t.sceneId, { swim: stats.speeds.swim > 0, id: t.id });
    // Prone and not standing up: crawling, +1 per foot (§16.4); standing up is its own command (move.stand).
    const crawl = status.conditions.some((c) => c.id === "prone");
    // In combat on its turn (§16.5 step 5): what it may spend — unless it moves freely; a DM's move only when the
    // token's "Count as movement" is on (AC-MOV-07).
    const combat = combatOn(ctx.model, t.sceneId);
    const d = combat ? dataOf(combat) : null;
    const m = movementOf(ctx.model, t);
    const free = d?.freeMovement === true || t.overrides.freeMovement === true;
    const counts = !dm || t.overrides.countAsMovement === true;
    const budget = m?.active && !free && counts ? Math.max(0, m.budget - m.used) : null;
    // Creature spaces (§16.5 step 6, AC-MOV-16): players' moves, when the house rule enforces them.
    const spaces =
      !dm && (rules.creatureSpaces === "always" || (rules.creatureSpaces === "combat" && Boolean(combat)));
    const crowd = spaces ? creaturesAround(ctx, t) : [];
    const me = spaceOf(ctx, t);
    const world = spaces ? withCreatureSpaces(base, me, crowd, ctx.model.campaign.rulesPack) : base;
    let path = points;
    let bumped = false;
    let unseen = false;
    let cost: number;
    if (dm) {
      cost = pathCost(world, path, { crawl }).cost;
      if (budget !== null && cost > budget + 0.05) {
        path = clampToBudget(world, path, { crawl }, budget);
        cost = pathCost(world, path, { crawl }).cost;
      }
    } else {
      const rc = clearanceRadius(t.sizeFt, rules.squeeze);
      const v = validateMove(world, points, { rc, crawl }, budget, rules.overlongMoves);
      if ("error" in v)
        throw new GloamError(
          "OVER_BUDGET",
          `That move is ${Math.round(v.cost)} ft; ${Math.floor(budget ?? 0)} ft of movement left.`,
        );
      path = v.points;
      bumped = v.bumped;
      cost = v.cost;
      if (v.hitWall !== null) unseen = hiddenFromPlayers(ctx.model, world.walls[v.hitWall]?.id);
      // It may not end in another creature's space: back along the path to where it may (§16.5 step 6).
      if (spaces) {
        const clear = lastClearPoint(path, me, crowd);
        if (!clear) throw new GloamError("BLOCKED", "There's no room to end the move there.");
        if (clear.points.length !== path.length || dist(clear.at, path[path.length - 1] as P) > 1e-6) {
          path = clear.points;
          cost = pathCost(world, path, { rc, crawl }).cost;
        }
      }
    }
    // Flying: the 3D length, climbs and dives included (§16.4); from the token's own height.
    if (p.mode === "fly" && p.elevations && !bumped)
      cost = flightCost(path, [t.elevation, ...p.elevations.slice(1)]);
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
    // The turn's bookkeeping (§16.5 step 7): what it spent, and the move as a segment (undo refunds it).
    if (combat && d?.turn?.tokenId === t.id && budget !== null && patch.pos) {
      for (const op of [
        setPathOp("combat", combat, ["data", "turn", "usedFt"], d.turn.usedFt + cost),
        setPathOp("combat", combat, ["data", "turn", "segments"], [...d.turn.segments, { cost }]),
      ])
        if (op) ops.push(op);
    }
    const durationMs = moveDurationMs(pathLength(path));
    const events: RoomEvent[] = [];
    if (patch.pos)
      events.push({
        name: "token.moved",
        payload: { id: t.id, path, durationMs },
        to: { viewersOf: t.id },
      });
    // Hazards the move went into prompt the DM (SPEC §8.7 Zones: "on enter").
    if (patch.pos) {
      const prompts = hazardPrompts(ctx.model.inScene("zone", t.sceneId), { when: "enter", path });
      if (prompts.length)
        events.push({
          name: "hazard.prompt",
          payload: { tokenId: t.id, tokenName: t.name, prompts },
          to: { dms: true },
        });
    }
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

/** A creature as creature spaces see it (§16.5 step 6). */
function spaceOf(ctx: Parameters<CommandDef["plan"]>[0], t: TokenEntity): SpaceCreature {
  const actor = t.actorId ? ctx.model.get("actor", t.actorId) : undefined;
  const { stats, status } = effectiveTokenState(t, actor && actor.deletedAt === null ? actor : undefined);
  const size: Size = (SIZES as readonly string[]).includes(stats.size) ? stats.size : "medium";
  return {
    id: t.id,
    pos: t.pos,
    sizeFt: t.sizeFt,
    size,
    disposition: t.disposition,
    incapacitated: incapacitates(status.conditions.map((x) => x.id as string)),
  };
}

/** The other creatures on the scene (every one — the true set, hidden ones too, as for walls). */
function creaturesAround(ctx: Parameters<CommandDef["plan"]>[0], t: TokenEntity): SpaceCreature[] {
  return ctx.model
    .inScene("token", t.sceneId)
    .filter((o) => o.id !== t.id)
    .map((o) => spaceOf(ctx, o));
}

/** Is this wall (or impassable zone) something players aren't shown? */
function hiddenFromPlayers(model: Parameters<typeof moveWorldOf>[0], id: string | undefined): boolean {
  if (!id) return false;
  const wall = model.get("wall", id);
  if (wall) return wall.hidden;
  const zone = model.get("zone", id);
  return zone ? !zone.visible : false;
}

export const MOVE_COMMANDS = [moveCommit] as unknown as CommandDef<never, unknown>[];
