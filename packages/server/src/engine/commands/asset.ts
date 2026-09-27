import { GloamError } from "@gloam/shared/protocol";
import { isDm } from "@gloam/shared/rules";
import { z } from "zod";
import type { AssetEntity } from "../codecs.ts";
import type { CommandCtx, CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { createOp, mustGet, setOps } from "../plan.ts";

/** Library commands (SPEC §8.16): rename/tag/overrides, soft delete and restore (undoable), review (not undoable). */

const AssetId = z.string().regex(/^ast_[A-Za-z0-9]{8,32}$/);
const Tag = z.string().trim().min(1).max(32);

export const AssetUpdate = z.strictObject({
  assetId: AssetId,
  name: z.string().trim().min(1).max(80).optional(),
  tags: z.array(Tag).max(24).optional(),
  overrides: z
    .strictObject({
      scale: z.number().positive().max(100).optional(),
      rotationYDeg: z.number().min(-360).max(360).optional(),
      offsetY: z.number().min(-50).max(50).optional(),
    })
    .optional(),
});
export const AssetIds = z.strictObject({ assetIds: z.array(AssetId).min(1).max(200) });
export const AssetReview = z.strictObject({
  assetIds: z.array(AssetId).min(1).max(200),
  decision: z.enum(["approve", "reject"]),
});

/** Uploaders may manage their own references; DMs and the Admin manage the whole library. */
function canManage(ctx: CommandCtx, a: AssetEntity): boolean {
  return isDm(ctx.actor.role) || a.uploaderId === ctx.actor.userId;
}

export const assetUpdate: CommandDef<z.infer<typeof AssetUpdate>> = {
  type: "asset.update",
  schema: AssetUpdate,
  undoable: true,
  authorize(ctx, p) {
    const a = mustGet(ctx, "asset", p.assetId);
    if (!canManage(ctx, a)) throw new GloamError("FORBIDDEN");
    if (p.overrides && !isDm(ctx.actor.role))
      throw new GloamError("FORBIDDEN", "Only the DM can adjust minis.");
  },
  plan(ctx, p) {
    const a = mustGet(ctx, "asset", p.assetId);
    const patch: Partial<AssetEntity> = {};
    if (p.name !== undefined) patch.name = p.name;
    if (p.tags !== undefined) patch.tags = [...new Set(p.tags.map((t) => t.toLowerCase()))];
    if (p.overrides !== undefined) patch.overrides = { ...a.overrides, ...p.overrides };
    return { ops: setOps("asset", a, patch), summary: `Edited ${a.name}` };
  },
};

function softDelete(type: "asset.delete" | "asset.restore"): CommandDef<z.infer<typeof AssetIds>> {
  return {
    type,
    schema: AssetIds,
    undoable: true,
    authorize(ctx, p) {
      for (const id of p.assetIds)
        if (!canManage(ctx, mustGet(ctx, "asset", id))) throw new GloamError("FORBIDDEN");
    },
    plan(ctx, p) {
      const ops: Op[] = [];
      for (const id of p.assetIds) {
        const a = mustGet(ctx, "asset", id);
        ops.push(...setOps("asset", a, { deletedAt: type === "asset.delete" ? ctx.now : null }));
      }
      const n = p.assetIds.length;
      const what =
        n === 1 ? (ctx.model.get("asset", p.assetIds[0] as string)?.name ?? "an item") : `${n} items`;
      return { ops, summary: `${type === "asset.delete" ? "Deleted" : "Restored"} ${what} from the library` };
    },
  };
}
export const assetDelete = softDelete("asset.delete");
export const assetRestore = softDelete("asset.restore");

/** Approvals inbox (SPEC §8.16). Not undoable (AC-UNDO-05); rejected files are purged after 24 h. */
export const assetReview: CommandDef<z.infer<typeof AssetReview>> = {
  type: "asset.review",
  schema: AssetReview,
  undoable: false,
  authorize(ctx) {
    if (!isDm(ctx.actor.role)) throw new GloamError("FORBIDDEN", "Only the DM can review uploads.");
  },
  plan(ctx, p) {
    const ops: Op[] = [];
    const status = p.decision === "approve" ? "approved" : "rejected";
    for (const id of p.assetIds) {
      const a = mustGet(ctx, "asset", id);
      ops.push(...setOps("asset", a, { status, reviewedBy: ctx.actor.userId, reviewedAt: ctx.now }));
    }
    const n = p.assetIds.length;
    return {
      ops,
      summary: `${p.decision === "approve" ? "Approved" : "Rejected"} ${n} upload${n === 1 ? "" : "s"}`,
    };
  },
};

/** Internal (never a room message): the upload route registers a processed file's reference through the bus. */
export const AssetRegister = z.strictObject({
  asset: z.custom<AssetEntity>((v) => typeof v === "object" && v !== null),
});
export const assetRegister: CommandDef<z.infer<typeof AssetRegister>> = {
  type: "asset.register",
  schema: AssetRegister,
  undoable: false,
  internal: true,
  authorize() {},
  plan(ctx, p) {
    if (ctx.model.get("asset", p.asset.id)) return { ops: [], summary: "" };
    return { ops: [createOp("asset", p.asset)], summary: `Uploaded ${p.asset.name}` };
  },
};

export const ASSET_COMMANDS = [
  assetUpdate,
  assetDelete,
  assetRestore,
  assetReview,
  assetRegister,
] as CommandDef<never, unknown>[];
