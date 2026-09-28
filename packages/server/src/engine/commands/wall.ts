import { pointSegDist } from "@gloam/shared/geometry";
import {
  DoorToggle,
  GloamError,
  WallCreate,
  WallDelete,
  WallJoin,
  type WallPatch,
  WallSplit,
  WallUpdate,
} from "@gloam/shared/protocol";
import { controlsToken, isDm } from "@gloam/shared/rules";
import type { WallEntity } from "@gloam/shared/schemas";
import type { z } from "zod";
import { newId } from "../../ids.ts";
import type { CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps } from "../plan.ts";

/**
 * Wall commands (SPEC §8.7, §13.5; DM): create (Generate walls, the Walls tool's chains and rooms), update (one wall
 * or a batch — moving a joint, bulk kind changes), split, join, delete. Doors default to closed.
 */

const isDoor = (k: WallEntity["kind"]) => k === "door" || k === "secret";
/** Endpoints closer than this are the same joint; a wall shorter than it is a point. */
export const JOINT_EPS_FT = 0.01;
const same = (p: { x: number; y: number }, q: { x: number; y: number }) =>
  Math.hypot(p.x - q.x, p.y - q.y) < JOINT_EPS_FT;

export const wallCreate: CommandDef<z.infer<typeof WallCreate>, { wallIds: string[] }> = {
  type: "wall.create",
  schema: WallCreate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    mustGet(ctx, "scene", p.sceneId);
    const ops: Op[] = [];
    const ids: string[] = [];
    for (const w of p.walls) {
      if (w.a.x === w.b.x && w.a.y === w.b.y) continue; // zero-length
      const wall: WallEntity = {
        id: newId("wal"),
        sceneId: p.sceneId,
        a: { x: w.a.x, y: w.a.y },
        b: { x: w.b.x, y: w.b.y },
        kind: w.kind,
        doorState: isDoor(w.kind) ? (w.doorState ?? "closed") : null,
        hidden: w.hidden,
      };
      ids.push(wall.id);
      ops.push(createOp("wall", wall));
    }
    const n = ids.length;
    return {
      ops,
      summary: `Added ${n} wall${n === 1 ? "" : "s"}`,
      sceneId: p.sceneId,
      result: { wallIds: ids },
    };
  },
};

function wallPatch(w: WallEntity, p: z.infer<typeof WallPatch>): Partial<WallEntity> {
  const patch: Partial<WallEntity> = {};
  if (p.a) patch.a = { x: p.a.x, y: p.a.y };
  if (p.b) patch.b = { x: p.b.x, y: p.b.y };
  if (p.hidden !== undefined) patch.hidden = p.hidden;
  if (p.kind !== undefined) {
    patch.kind = p.kind;
    if (!isDoor(p.kind)) patch.doorState = null;
    else if (!w.doorState) patch.doorState = "closed";
  }
  if (p.doorState !== undefined && isDoor(patch.kind ?? w.kind)) patch.doorState = p.doorState;
  return patch;
}

export const wallUpdate: CommandDef<z.infer<typeof WallUpdate>> = {
  type: "wall.update",
  schema: WallUpdate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const list = "walls" in p ? p.walls : [p];
    const ops: Op[] = [];
    let sceneId: string | null = null;
    let removed = 0;
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.wallId)) throw new GloamError("INVALID", "A wall appears twice in one edit.");
      seen.add(item.wallId);
      const w = mustGet(ctx, "wall", item.wallId);
      if (sceneId && w.sceneId !== sceneId)
        throw new GloamError("INVALID", "Those walls are in different scenes.");
      sceneId = w.sceneId;
      const patch = wallPatch(w, item);
      // Dragging one end onto the other leaves no wall.
      if (same(patch.a ?? w.a, patch.b ?? w.b)) {
        ops.push(deleteOp("wall", w));
        removed++;
      } else ops.push(...setOps("wall", w, patch));
    }
    const n = list.length;
    const summary =
      removed === n
        ? `Removed ${n === 1 ? "a wall" : `${n} walls`}`
        : `Edited ${n === 1 ? "a wall" : `${n} walls`}`;
    return { ops, summary, sceneId };
  },
};

export const wallSplit: CommandDef<z.infer<typeof WallSplit>, { wallIds: [string, string] }> = {
  type: "wall.split",
  schema: WallSplit,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const w = mustGet(ctx, "wall", p.wallId);
    const dx = w.b.x - w.a.x;
    const dy = w.b.y - w.a.y;
    const len2 = dx * dx + dy * dy;
    const t = ((p.at.x - w.a.x) * dx + (p.at.y - w.a.y) * dy) / len2;
    const len = Math.sqrt(len2);
    if (pointSegDist(p.at, w.a, w.b) > 1) throw new GloamError("INVALID", "That point isn't on the wall.");
    if (!(t * len >= 0.25 && (1 - t) * len >= 0.25))
      throw new GloamError("INVALID", "Split a wall at least 3 inches from its ends.");
    const at = { x: w.a.x + dx * t, y: w.a.y + dy * t };
    const half: WallEntity = { ...w, id: newId("wal"), a: at, b: { ...w.b } };
    return {
      ops: [...setOps("wall", w, { b: { ...at } }), createOp("wall", half)],
      summary: "Split a wall",
      sceneId: w.sceneId,
      result: { wallIds: [w.id, half.id] },
    };
  },
};

export const wallJoin: CommandDef<z.infer<typeof WallJoin>, { wallId: string }> = {
  type: "wall.join",
  schema: WallJoin,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const w1 = mustGet(ctx, "wall", p.wallIds[0]);
    const w2 = mustGet(ctx, "wall", p.wallIds[1]);
    if (w1.id === w2.id || w1.sceneId !== w2.sceneId)
      throw new GloamError("INVALID", "Pick two walls of the same scene.");
    // The shared end is the joint between them; the joined wall runs from the first's other end to the second's.
    const ends = ["a", "b"] as const;
    let far1: WallEntity["a"] | null = null;
    let far2: WallEntity["a"] | null = null;
    for (const e1 of ends)
      for (const e2 of ends)
        if (!far1 && same(w1[e1], w2[e2])) {
          far1 = e1 === "a" ? w1.b : w1.a;
          far2 = e2 === "a" ? w2.b : w2.a;
        }
    if (!far1 || !far2) throw new GloamError("INVALID", "Those walls don't meet at an end.");
    if (same(far1, far2)) throw new GloamError("INVALID", "Joined, those walls would be a point.");
    return {
      ops: [...setOps("wall", w1, { a: { ...far1 }, b: { ...far2 } }), deleteOp("wall", w2)],
      summary: "Joined two walls",
      sceneId: w1.sceneId,
      result: { wallId: w1.id },
    };
  },
};

export const wallDelete: CommandDef<z.infer<typeof WallDelete>> = {
  type: "wall.delete",
  schema: WallDelete,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const ops: Op[] = [];
    let sceneId: string | null = null;
    for (const id of p.wallIds) {
      const w = ctx.model.get("wall", id);
      if (!w) continue;
      sceneId = w.sceneId;
      ops.push(deleteOp("wall", w));
    }
    const n = ops.length;
    return { ops, summary: `Removed ${n} wall${n === 1 ? "" : "s"}`, sceneId };
  },
};

/** A player can work a door within this many feet of their token's base edge (SPEC §8.7 Doors). */
export const DOOR_REACH_FT = 5;

/**
 * `door.toggle` (SPEC §8.7 Doors; AC-WAL-03): players open and close unlocked doors within 5 ft of a token they
 * control; a locked door refuses them ("It's locked" — the client rattles it). DMs open, close, lock and unlock any
 * door anywhere, secret doors included. To players a shut secret door is a wall, so trying one gets exactly a wall's
 * answer; one the DM has opened is a door they can see, and may shut (it then reads as a wall again). Movement uses
 * the new state at once (the scene's geometry version changes).
 */
export const doorToggle: CommandDef<z.infer<typeof DoorToggle>, { doorState: string }> = {
  type: "door.toggle",
  schema: DoorToggle,
  undoable: true,
  authorize(ctx, p) {
    const w = ctx.model.get("wall", p.wallId);
    const dm = isDm(ctx.actor.role);
    if (!w || (!dm && w.hidden)) throw new GloamError("NOT_FOUND", "That no longer exists.");
    const shown = w.kind === "secret" && w.doorState === "open";
    if (!(w.kind === "door" || (w.kind === "secret" && (dm || shown))))
      throw new GloamError("FORBIDDEN", "That isn't a door.");
    if (dm) return;
    if (ctx.actor.role === "spectator") throw new GloamError("FORBIDDEN");
    if (p.action === "lock" || p.action === "unlock")
      throw new GloamError("FORBIDDEN", "Only the DM can lock or unlock doors.");
    const near = ctx.model
      .inScene("token", w.sceneId)
      .some(
        (t) =>
          controlsToken(ctx.actor.role, ctx.actor.userId, t) &&
          pointSegDist(t.pos, w.a, w.b) - t.sizeFt / 2 <= DOOR_REACH_FT + 1e-6,
      );
    if (!near) throw new GloamError("FORBIDDEN", "Get within 5 ft of the door first.");
    if (w.doorState === "locked") throw new GloamError("BLOCKED", "It's locked.");
  },
  plan(ctx, p) {
    const w = mustGet(ctx, "wall", p.wallId);
    const cur = w.doorState ?? "closed";
    const next =
      p.action === "open"
        ? "open"
        : p.action === "close"
          ? "closed"
          : p.action === "lock"
            ? "locked"
            : p.action === "unlock"
              ? "closed"
              : cur === "open"
                ? "closed"
                : "open";
    const verb = { open: "Opened", closed: cur === "locked" ? "Unlocked" : "Closed", locked: "Locked" }[next];
    return {
      ops: setOps("wall", w, { doorState: next }),
      summary: `${verb} a ${w.kind === "secret" ? "secret door" : "door"}`,
      sceneId: w.sceneId,
      result: { doorState: next },
    };
  },
};

export const WALL_COMMANDS = [
  wallCreate,
  wallUpdate,
  wallSplit,
  wallJoin,
  wallDelete,
  doorToggle,
] as CommandDef<never, unknown>[];
