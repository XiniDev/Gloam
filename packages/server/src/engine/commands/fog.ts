import { FogPaint, FogResetExplored, GloamError } from "@gloam/shared/protocol";
import { rleEncode } from "@gloam/shared/vision";
import type { z } from "zod";
import { fogCover } from "../../vision/fogPaint.ts";
import { sceneWalls } from "../../vision/sources.ts";
import { formatRuns } from "../../vision/visionService.ts";
import type { CommandCtx, CommandDef, FogApplier } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { mustGet, requireDm } from "../plan.ts";

/**
 * Fog commands (SPEC §8.8 DM fog tools, §15.8). Each is a set of `fog` ops — a rectangle of one layer's cells before
 * and after — so it is undone like any command (AC-UNDO-01) and reaches only the players that layer concerns.
 */

function fogOf(ctx: CommandCtx): FogApplier {
  if (!ctx.fog) throw new GloamError("INVALID", "Fog isn't available here.");
  return ctx.fog;
}

export const fogPaint: CommandDef<z.infer<typeof FogPaint>, { cells: number }> = {
  type: "fog.paint",
  schema: FogPaint,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    mustGet(ctx, "scene", p.sceneId);
    const fog = fogOf(ctx);
    const shape = fog.shape(p.sceneId);
    if (!shape) throw new GloamError("NOT_FOUND");
    const cover = fogCover(p.shape, shape, () => sceneWalls(ctx.model, p.sceneId));
    const verb = p.mode === "reveal" ? "Revealed" : "Hid";
    if (!cover)
      return {
        ops: [],
        summary: `${verb} nothing`,
        sceneId: p.sceneId,
        undoable: false,
        result: { cells: 0 },
      };
    // Hiding for all players clears every layer (a player's own reveal too); the rest touch one layer.
    const layers =
      p.target === "all"
        ? p.mode === "hide"
          ? ["reveal:all", ...fog.layerNames(p.sceneId, "reveal:").filter((l) => l !== "reveal:all")]
          : ["reveal:all"]
        : [`reveal:${p.target}`];
    const set = p.mode === "reveal" ? 1 : 0;
    const { rect, mask } = cover;
    const ops: Op[] = [];
    let cells = 0;
    for (const layer of layers) {
      const cur = fog.layer(p.sceneId, layer);
      const before = cur.read(rect);
      const after = before.slice();
      let changed = 0;
      for (let j = 0; j < rect.h; j++)
        for (let i = 0; i < rect.w; i++) {
          const k = j * rect.w + i;
          if (mask[(rect.y + j) * shape.w + rect.x + i] && after[k] !== set) {
            after[k] = set;
            changed++;
          }
        }
      if (!changed) continue;
      cells += changed;
      ops.push({
        k: "fog",
        sceneId: p.sceneId,
        layer,
        rect,
        before: formatRuns(rleEncode(before)),
        after: formatRuns(rleEncode(after)),
      });
    }
    const whom = p.target === "all" ? "" : " for one player";
    const what = p.shape.kind === "all" ? "everything" : p.shape.kind === "room" ? "a room" : `an area`;
    return {
      ops,
      summary: `${verb} ${what}${whom}`,
      sceneId: p.sceneId,
      undoable: ops.length > 0,
      result: { cells },
    };
  },
};

export const fogResetExplored: CommandDef<z.infer<typeof FogResetExplored>, { players: number }> = {
  type: "fog.resetExplored",
  schema: FogResetExplored,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    mustGet(ctx, "scene", p.sceneId);
    const fog = fogOf(ctx);
    const shape = fog.shape(p.sceneId);
    if (!shape) throw new GloamError("NOT_FOUND");
    const users = p.userId
      ? [p.userId]
      : fog.layerNames(p.sceneId, "explored:").map((l) => l.slice("explored:".length));
    const rect = { x: 0, y: 0, w: shape.w, h: shape.h };
    const empty = formatRuns([shape.w * shape.h]);
    const ops: Op[] = [];
    for (const u of users) {
      const cur = fog.layer(p.sceneId, `explored:${u}`);
      if (!cur.any()) continue;
      ops.push({
        k: "fog",
        sceneId: p.sceneId,
        layer: `explored:${u}`,
        rect,
        before: formatRuns(rleEncode(cur.data)),
        after: empty,
      });
    }
    return {
      ops,
      summary: p.userId ? "Reset a player's explored map" : "Reset everyone's explored map",
      sceneId: p.sceneId,
      undoable: ops.length > 0,
      result: { players: ops.length },
    };
  },
};

export const FOG_COMMANDS = [fogPaint, fogResetExplored] as CommandDef<never, unknown>[];
