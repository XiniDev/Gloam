import { ZONE_COLORS } from "@gloam/shared";
import { ZoneCreate, ZoneDelete, ZoneUpdate } from "@gloam/shared/protocol";
import type { ZoneEntity } from "@gloam/shared/schemas";
import type { z } from "zod";
import { newId } from "../../ids.ts";
import type { CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, deleteOp, mustGet, requireDm, setOps } from "../plan.ts";

/** Zone commands (SPEC §8.7 Zones; DM). Their geometry feeds movement at once (the scene's geometry version). */
export const zoneCreate: CommandDef<z.infer<typeof ZoneCreate>, { zoneId: string }> = {
  type: "zone.create",
  schema: ZoneCreate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    mustGet(ctx, "scene", p.sceneId);
    const zone: ZoneEntity = {
      id: newId("zon"),
      sceneId: p.sceneId,
      kind: p.kind,
      shape: p.shape,
      label: p.label,
      color: p.color ?? ZONE_COLORS[p.kind],
      visible: p.visible,
      triggers: p.triggers,
      note: p.note,
    };
    return {
      ops: [createOp("zone", zone)],
      summary: `Added ${p.label ? `the zone "${p.label}"` : "a zone"}`,
      sceneId: p.sceneId,
      result: { zoneId: zone.id },
    };
  },
};

export const zoneUpdate: CommandDef<z.infer<typeof ZoneUpdate>> = {
  type: "zone.update",
  schema: ZoneUpdate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const zone = mustGet(ctx, "zone", p.zoneId);
    const { zoneId: _id, ...patch } = p;
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as Partial<ZoneEntity>;
    return {
      ops: setOps("zone", zone, clean),
      summary: `Edited ${zone.label || "a zone"}`,
      sceneId: zone.sceneId,
    };
  },
};

export const zoneDelete: CommandDef<z.infer<typeof ZoneDelete>> = {
  type: "zone.delete",
  schema: ZoneDelete,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const ops: Op[] = [];
    let sceneId: string | null = null;
    for (const id of p.zoneIds) {
      const zone = ctx.model.get("zone", id);
      if (!zone) continue;
      sceneId = zone.sceneId;
      ops.push(deleteOp("zone", zone));
    }
    const n = ops.length;
    return { ops, summary: `Removed ${n} zone${n === 1 ? "" : "s"}`, sceneId };
  },
};

export const ZONE_COMMANDS = [zoneCreate, zoneUpdate, zoneDelete] as CommandDef<never, unknown>[];
