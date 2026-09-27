import { WallCreate, WallDelete, WallUpdate } from "@gloam/shared/protocol";
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

export const WALL_COMMANDS = [wallCreate, wallUpdate, wallDelete] as CommandDef<never, unknown>[];
