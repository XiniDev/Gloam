import { pointSegDist } from "@gloam/shared/geometry";
import { DoorToggle, GloamError, WallCreate, WallDelete, WallUpdate } from "@gloam/shared/protocol";
import { controlsToken, isDm } from "@gloam/shared/rules";
import type { WallEntity } from "@gloam/shared/schemas";
import type { z } from "zod";
import { newId } from "../../ids.ts";
import type { CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps } from "../plan.ts";

/**
 * Wall commands (SPEC §8.7, §13.5; DM). Phase 2 needs them for 3D maps' Generate walls (AC-SCN-04); the drawing and
 * editing tools arrive with the walls tool (Phase 3). Doors default to closed.
 */

const isDoor = (k: WallEntity["kind"]) => k === "door" || k === "secret";

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

export const wallUpdate: CommandDef<z.infer<typeof WallUpdate>> = {
  type: "wall.update",
  schema: WallUpdate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const w = mustGet(ctx, "wall", p.wallId);
    const patch: Partial<WallEntity> = {};
    if (p.a) patch.a = p.a;
    if (p.b) patch.b = p.b;
    if (p.hidden !== undefined) patch.hidden = p.hidden;
    if (p.kind !== undefined) {
      patch.kind = p.kind;
      if (!isDoor(p.kind)) patch.doorState = null;
      else if (!w.doorState) patch.doorState = "closed";
    }
    if (p.doorState !== undefined && isDoor(patch.kind ?? w.kind)) patch.doorState = p.doorState;
    return { ops: setOps("wall", w, patch), summary: "Edited a wall", sceneId: w.sceneId };
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

export const WALL_COMMANDS = [wallCreate, wallUpdate, wallDelete, doorToggle] as CommandDef<never, unknown>[];
