import { deflateSync, inflateSync } from "node:zlib";
import { Raster } from "@gloam/shared/vision";
import { and, eq, like } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { fogMasks } from "../db/schema.ts";

/**
 * Fog layers in `fog_masks` (SPEC §15.5, §15.8): `reveal:all`, `reveal:<userId>` (painted reveals) and
 * `explored:<userId>` (explored memory), one byte per cell, deflated.
 */
export class FogStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** A stored layer fitted to `shape` (resampled by cell centre when the scene's bounds or cell size changed). */
  load(sceneId: string, layer: string, shape: Raster): Raster {
    const out = new Raster(shape.x0, shape.y0, shape.cell, shape.w, shape.h);
    const row = this.db
      .select()
      .from(fogMasks)
      .where(and(eq(fogMasks.sceneId, sceneId), eq(fogMasks.layer, layer)))
      .get();
    if (!row) return out;
    let cells: Uint8Array;
    try {
      cells = new Uint8Array(inflateSync(row.data));
    } catch {
      return out;
    }
    const stored = new Raster(row.originX, row.originY, row.cellFt, row.w, row.h, cells);
    if (cells.length !== row.w * row.h) return out;
    if (stored.sameShape(out)) {
      out.data.set(cells);
      return out;
    }
    for (let j = 0; j < out.h; j++)
      for (let i = 0; i < out.w; i++)
        out.data[j * out.w + i] = stored.at(out.x0 + (i + 0.5) * out.cell, out.y0 + (j + 0.5) * out.cell)
          ? 1
          : 0;
    return out;
  }

  save(sceneId: string, layer: string, r: Raster, now: number): void {
    const data = deflateSync(r.data);
    const row = {
      sceneId,
      layer,
      cellFt: r.cell,
      originX: r.x0,
      originY: r.y0,
      w: r.w,
      h: r.h,
      data,
      updatedAt: now,
    };
    this.db
      .insert(fogMasks)
      .values(row)
      .onConflictDoUpdate({
        target: [fogMasks.sceneId, fogMasks.layer],
        set: { cellFt: r.cell, originX: r.x0, originY: r.y0, w: r.w, h: r.h, data, updatedAt: now },
      })
      .run();
  }

  /** Layer names stored for a scene with a prefix (e.g. "reveal:", "explored:"). */
  layers(sceneId: string, prefix: string): string[] {
    return this.db
      .select({ layer: fogMasks.layer })
      .from(fogMasks)
      .where(and(eq(fogMasks.sceneId, sceneId), like(fogMasks.layer, `${prefix}%`)))
      .all()
      .map((r) => r.layer);
  }
}
