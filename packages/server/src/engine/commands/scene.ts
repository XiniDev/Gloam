import {
  GloamError,
  SceneCalibrate,
  SceneCreate,
  SceneRef,
  SceneReorder,
  SceneUpdate,
} from "@gloam/shared/protocol";
import type { AreaShape, SceneEntity, ZoneEntity } from "@gloam/shared/schemas";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { assetFiles, assets } from "../../db/schema.ts";
import { newId } from "../../ids.ts";
import type { CommandCtx, CommandDef } from "../commandBus.ts";
import type { Op } from "../ops.ts";
import { clone } from "../ops.ts";
import { createOp, mustGet, requireDm, setOps, setPathOp } from "../plan.ts";

/** Image dimensions of a campaign asset reference (for bounds and calibration). */
export function imageSize(ctx: CommandCtx, assetId: string): { w: number; h: number } | null {
  const a = ctx.app.db.select().from(assets).where(eq(assets.id, assetId)).get();
  if (!a || a.campaignId !== ctx.model.campaign.id || a.deletedAt) return null;
  const f = ctx.app.db.select().from(assetFiles).where(eq(assetFiles.id, a.fileId)).get();
  if (!f?.width || !f.height) return null;
  return { w: f.width, h: f.height };
}

/** `scene.create` — New scene wizard (SPEC §8.3): image, 3D model, procedural or blank floor. */
export const sceneCreate: CommandDef<z.infer<typeof SceneCreate>, { sceneId: string }> = {
  type: "scene.create",
  schema: SceneCreate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const now = ctx.now;
    let bounds = { minX: 0, minY: 0, maxX: p.widthFt ?? 100, maxY: p.heightFt ?? 80 };
    const calibration: SceneEntity["calibration"] = {};
    if (p.mapKind === "image") {
      if (!p.mapAssetId) throw new GloamError("INVALID", "Choose a map image first.");
      const size = imageSize(ctx, p.mapAssetId);
      if (!size) throw new GloamError("NOT_FOUND", "That map image isn't available.");
      const ftPerPx = 5 / (p.pxPer5ft ?? 70);
      calibration.ftPerPx = ftPerPx;
      calibration.imageW = size.w;
      calibration.imageH = size.h;
      bounds = { minX: 0, minY: 0, maxX: size.w * ftPerPx, maxY: size.h * ftPerPx };
    } else if (p.mapKind === "model") {
      if (!p.mapAssetId) throw new GloamError("INVALID", "Choose a 3D map first.");
      calibration.position = { x: 0, y: 0, z: 0 };
      calibration.rotationYDeg = 0;
      calibration.scale = 1;
      calibration.sliceFt = 5;
      bounds = { minX: -60, minY: -60, maxX: 60, maxY: 60 };
    }
    const sort = Math.max(0, ...ctx.model.all("scene").map((s) => s.sort)) + 1;
    const scene: SceneEntity = {
      id: newId("scn"),
      campaignId: ctx.model.campaign.id,
      name: p.name,
      sort,
      mapKind: p.mapKind,
      mapAssetId: p.mapAssetId ?? null,
      calibration,
      floor: { style: p.floorStyle ?? (p.mapKind === "blank" ? "parchment" : "stone") },
      ambient: { level: p.ambient ?? "bright", tint: "#FFFFFF" },
      fogMode: p.fogMode ?? "off",
      fogCellFt: 1,
      bounds,
      spawn: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
      music: null,
      walls3d: p.mapKind === "procedural",
      thumbnailAssetId: null,
      dmNotes: "",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    };
    return {
      ops: [createOp("scene", scene)],
      summary: `Created scene ${p.name}`,
      sceneId: scene.id,
      result: { sceneId: scene.id },
    };
  },
};

/** `scene.update` — name, ambient light, fog mode, floor, 3D walls, spawn, bounds, music, DM notes. */
export const sceneUpdate: CommandDef<z.infer<typeof SceneUpdate>> = {
  type: "scene.update",
  schema: SceneUpdate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const s = mustGet(ctx, "scene", p.sceneId);
    const patch: Partial<SceneEntity> = {};
    if (p.name !== undefined) patch.name = p.name;
    if (p.fogMode !== undefined) patch.fogMode = p.fogMode;
    if (p.walls3d !== undefined) patch.walls3d = p.walls3d;
    if (p.spawn !== undefined) patch.spawn = p.spawn;
    if (p.bounds !== undefined) {
      if (p.bounds.maxX <= p.bounds.minX || p.bounds.maxY <= p.bounds.minY)
        throw new GloamError("INVALID", "Bounds are empty.");
      patch.bounds = p.bounds;
    }
    if (p.dmNotes !== undefined) patch.dmNotes = p.dmNotes;
    if (p.music !== undefined) patch.music = p.music;
    if (p.ambientLevel !== undefined || p.ambientTint !== undefined) {
      patch.ambient = { level: p.ambientLevel ?? s.ambient.level, tint: p.ambientTint ?? s.ambient.tint };
    }
    if (p.floorStyle !== undefined) patch.floor = { ...s.floor, style: p.floorStyle };
    const ops = setOps("scene", s, patch);
    if (ops.length)
      ops.push({ k: "set", e: "scene", id: s.id, path: ["updatedAt"], value: ctx.now, prev: s.updatedAt });
    return { ops, summary: `Updated scene ${s.name}`, sceneId: s.id };
  },
};

function scalePt(p: { x: number; y: number }, k: number): { x: number; y: number } {
  return { x: p.x * k, y: p.y * k };
}

/** An area's anchor on the map after a recalibration by factor `k` (emanations follow their token instead). */
function scaleShapeAnchor(sh: AreaShape, k: number): AreaShape {
  switch (sh.kind) {
    case "emanation":
      return sh;
    case "wall":
      return { ...sh, points: sh.points.map((p) => scalePt(p, k)) };
    default:
      return { ...sh, origin: { ...sh.origin, x: sh.origin.x * k, y: sh.origin.y * k } };
  }
}

/**
 * `scene.calibrate` — image maps: feet per pixel; changing it rescales walls, zones, lights and token positions
 * proportionally so they stay aligned with the map art (AC-SCN-08). Model maps: the GLB transform.
 */
export const sceneCalibrate: CommandDef<z.infer<typeof SceneCalibrate>> = {
  type: "scene.calibrate",
  schema: SceneCalibrate,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const s = mustGet(ctx, "scene", p.sceneId);
    const ops: Op[] = [];
    if ("transform" in p) {
      if (s.mapKind !== "model") throw new GloamError("INVALID", "Only 3D maps have a transform.");
      const op = setPathOp("scene", s, ["calibration"], {
        ...s.calibration,
        ...p.transform,
        ...(p.sliceFt !== undefined ? { sliceFt: p.sliceFt } : {}),
      });
      if (op) ops.push(op);
      return { ops, summary: `Aligned the 3D map of ${s.name}`, sceneId: s.id };
    }
    if (s.mapKind !== "image")
      throw new GloamError("INVALID", "Only image maps are calibrated in feet per pixel.");
    const old = s.calibration.ftPerPx ?? 5 / 70;
    const k = p.ftPerPx / old;
    if (Math.abs(k - 1) < 1e-9) return { ops, summary: "Calibration unchanged", sceneId: s.id };
    ops.push(
      ...setOps("scene", s, {
        calibration: { ...s.calibration, ftPerPx: p.ftPerPx },
        bounds: {
          minX: s.bounds.minX * k,
          minY: s.bounds.minY * k,
          maxX: s.bounds.maxX * k,
          maxY: s.bounds.maxY * k,
        },
        spawn: scalePt(s.spawn, k),
      }),
    );
    for (const w of ctx.model.inScene("wall", s.id))
      ops.push(...setOps("wall", w, { a: scalePt(w.a, k), b: scalePt(w.b, k) }));
    // Carried lights too: their stored position follows the (rescaled) carrier.
    for (const l of ctx.model.inScene("light", s.id))
      ops.push(...setOps("light", l, { pos: scalePt(l.pos, k) }));
    // Areas stay on the map features they were placed on; their sizes are rules distances and don't change.
    for (const e of ctx.model.inScene("effect", s.id)) {
      const shape = scaleShapeAnchor(e.shape, k);
      if (shape !== e.shape) ops.push(...setOps("effect", e, { shape }));
    }
    for (const t of ctx.model.inScene("token", s.id))
      ops.push(...setOps("token", t, { pos: scalePt(t.pos, k) }));
    for (const z of ctx.model.inScene("zone", s.id)) {
      const sh = z.shape;
      const shape: ZoneEntity["shape"] =
        sh.kind === "polygon"
          ? { kind: "polygon", points: sh.points.map((q) => scalePt(q, k)) }
          : sh.kind === "rect"
            ? { kind: "rect", x: sh.x * k, y: sh.y * k, w: sh.w * k, h: sh.h * k }
            : { kind: "circle", x: sh.x * k, y: sh.y * k, r: sh.r * k };
      ops.push(...setOps("zone", z, { shape }));
    }
    return {
      ops,
      summary: `Recalibrated ${s.name} (${(5 / p.ftPerPx).toFixed(1)} px per 5 ft)`,
      sceneId: s.id,
    };
  },
};

/** `scene.activate` — move everyone to this scene (SPEC §8.3 Scene activation). */
export const sceneActivate: CommandDef<z.infer<typeof SceneRef>> = {
  type: "scene.activate",
  schema: SceneRef,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const s = mustGet(ctx, "scene", p.sceneId);
    if (s.deletedAt || s.archivedAt)
      throw new GloamError("INVALID", "Restore the scene before activating it.");
    const c = ctx.model.campaign;
    const ops = setOps("campaign", c, { activeSceneId: s.id });
    return {
      ops,
      summary: `Activated scene ${s.name}`,
      sceneId: s.id,
      // Snapshot on scene activation (SPEC §20.3, AC-PER-03).
      after: ops.length ? [() => void ctx.app.snapshots.write(c.id, "scene", s.name)] : [],
    };
  },
};

function softDelete(
  type: "scene.delete" | "scene.restore" | "scene.archive" | "scene.unarchive",
): CommandDef<z.infer<typeof SceneRef>> {
  return {
    type,
    schema: SceneRef,
    undoable: true,
    authorize: requireDm,
    plan(ctx, p) {
      const s = mustGet(ctx, "scene", p.sceneId);
      if (
        (type === "scene.delete" || type === "scene.archive") &&
        ctx.model.campaign.activeSceneId === s.id
      ) {
        throw new GloamError("CONFLICT", "Activate another scene first.");
      }
      const patch: Partial<SceneEntity> =
        type === "scene.delete"
          ? { deletedAt: ctx.now }
          : type === "scene.restore"
            ? { deletedAt: null }
            : type === "scene.archive"
              ? { archivedAt: ctx.now }
              : { archivedAt: null };
      const verb = {
        "scene.delete": "Deleted",
        "scene.restore": "Restored",
        "scene.archive": "Archived",
        "scene.unarchive": "Unarchived",
      }[type];
      return { ops: setOps("scene", s, patch), summary: `${verb} scene ${s.name}`, sceneId: s.id };
    },
  };
}

export const sceneDelete = softDelete("scene.delete");
export const sceneRestore = softDelete("scene.restore");
export const sceneArchive = softDelete("scene.archive");
export const sceneUnarchive = softDelete("scene.unarchive");

/** `scene.duplicate` — copies the scene with its walls, lights, zones and (non-character) tokens. */
export const sceneDuplicate: CommandDef<z.infer<typeof SceneRef>, { sceneId: string }> = {
  type: "scene.duplicate",
  schema: SceneRef,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const s = mustGet(ctx, "scene", p.sceneId);
    const id = newId("scn");
    const copy: SceneEntity = {
      ...clone(s),
      id,
      name: `${s.name} (copy)`,
      sort: s.sort + 0.5,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      thumbnailAssetId: null,
    };
    const ops: Op[] = [createOp("scene", copy)];
    for (const w of ctx.model.inScene("wall", s.id))
      ops.push(createOp("wall", { ...clone(w), id: newId("wal"), sceneId: id }));
    for (const z of ctx.model.inScene("zone", s.id))
      ops.push(createOp("zone", { ...clone(z), id: newId("zon"), sceneId: id }));
    const tokenIdMap = new Map<string, string>();
    for (const t of ctx.model.inScene("token", s.id)) {
      if (t.link === "linked") continue;
      const nid = newId("tok");
      tokenIdMap.set(t.id, nid);
      ops.push(createOp("token", { ...clone(t), id: nid, sceneId: id, lightId: null }));
    }
    for (const l of ctx.model.inScene("light", s.id)) {
      if (l.tokenId && !tokenIdMap.has(l.tokenId)) continue;
      const lid = newId("lgt");
      const tokenId = l.tokenId ? (tokenIdMap.get(l.tokenId) ?? null) : null;
      ops.push(createOp("light", { ...clone(l), id: lid, sceneId: id, tokenId }));
      if (tokenId) {
        const tokOp = ops.find((o) => o.k === "create" && o.e === "token" && o.id === tokenId);
        if (tokOp && tokOp.k === "create") (tokOp.value as { lightId: string | null }).lightId = lid;
      }
    }
    return { ops, summary: `Duplicated scene ${s.name}`, sceneId: id, result: { sceneId: id } };
  },
};

/** `scene.reorder` — drag-to-reorder in the scene list. */
export const sceneReorder: CommandDef<z.infer<typeof SceneReorder>> = {
  type: "scene.reorder",
  schema: SceneReorder,
  undoable: true,
  authorize: requireDm,
  plan(ctx, p) {
    const ops: Op[] = [];
    p.order.forEach((id, i) => {
      const s = ctx.model.get("scene", id);
      if (s) ops.push(...setOps("scene", s, { sort: i + 1 }));
    });
    return { ops, summary: "Reordered scenes" };
  },
};

export const SCENE_COMMANDS = [
  sceneCreate,
  sceneUpdate,
  sceneCalibrate,
  sceneActivate,
  sceneDelete,
  sceneRestore,
  sceneArchive,
  sceneUnarchive,
  sceneDuplicate,
  sceneReorder,
] as CommandDef<never, unknown>[];
