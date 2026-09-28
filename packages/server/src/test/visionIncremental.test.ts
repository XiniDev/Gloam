import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LightRaster,
  markSeen,
  prepareViewer,
  Raster,
  VisionGeometry,
  VisionWorld,
} from "@gloam/shared/vision";
import { afterAll, describe, expect, it } from "vitest";
import { buildVisionScene, rng, SCENE_ID } from "../bench/visionScene.ts";
import { openDatabase } from "../db/client.ts";
import type { Op } from "../engine/ops.ts";
import { sceneEffects, sceneLights, sceneWalls, tokenViewer } from "../vision/sources.ts";
import { VisionService } from "../vision/visionService.ts";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterAll(() => {
  for (const c of closers) c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function database() {
  const dir = mkdtempSync(join(tmpdir(), "gloam-vis-"));
  dirs.push(dir);
  const log = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const { sqlite, db } = await openDatabase(join(dir, "vis.db"), dir, log);
  sqlite.pragma("foreign_keys = OFF"); // the model lives in memory
  closers.push(() => sqlite.close());
  return db;
}

const lightData = (s: VisionService) => (s as unknown as { light: LightRaster }).light.raster.data;

describe("P4 — the vision service's incremental recompute (AC-VIS-12)", () => {
  it("equals a from-scratch recompute after every event — moves, torches, doors, walls drawn and erased, lights put out and lit, a lantern turned: same perception, same glows round corners, same light raster, same explored memory", {
    timeout: 120_000,
  }, async () => {
    const scene = buildVisionScene({
      w: 80,
      h: 60,
      walls: 90,
      doors: 6,
      fixedLights: 8,
      players: 3,
      creatures: 10,
      carried: 5,
      seed: 11,
    });
    const { model, players } = scene;
    // One carried light is a bullseye lantern (a 60° cone), turned now and then.
    const lantern = model.get("light", scene.lights[0] as string);
    if (!lantern) throw new Error("no lantern");
    model.put("light", { ...lantern, coneDeg: 60, directionDeg: 0 });
    const host = { players: () => players, toUser() {}, toOverseers() {} };
    const service = new VisionService(model, await database(), host);
    const scratchDb = await database();
    const scn = model.get("scene", SCENE_ID);
    if (!scn) throw new Error("no scene");
    const explored = new Map(players.map((u) => [u, Raster.over(scn.bounds, scn.fogCellFt)]));
    const r = rng(5);
    let extra = 0;
    const kinds = new Map<string, number>();
    let glows = 0;
    let marked = 0;

    for (let e = 0; e < 160; e++) {
      const ops: Op[] = [];
      let kind: string;
      if (e % 6 === 5) {
        kind = "door";
        const id = scene.doors[Math.floor(r() * scene.doors.length)] as string;
        const d = model.get("wall", id);
        if (!d) throw new Error("no door");
        const doorState = d.doorState === "open" ? "closed" : "open";
        model.put("wall", { ...d, doorState });
        ops.push({ k: "set", e: "wall", id, path: ["doorState"], value: doorState, prev: d.doorState });
      } else if (e % 9 === 8) {
        kind = "light toggled";
        const id = scene.lights[Math.floor(r() * scene.lights.length)] as string;
        const l = model.get("light", id);
        if (!l) throw new Error("no light");
        model.put("light", { ...l, enabled: !l.enabled });
        ops.push({ k: "set", e: "light", id, path: ["enabled"], value: !l.enabled, prev: l.enabled });
      } else if (e % 11 === 10) {
        kind = "lantern turned";
        const l = model.get("light", lantern.id);
        if (!l) throw new Error("no lantern");
        const directionDeg = Math.floor(r() * 360);
        model.put("light", { ...l, directionDeg });
        ops.push({
          k: "set",
          e: "light",
          id: l.id,
          path: ["directionDeg"],
          value: directionDeg,
          prev: l.directionDeg,
        });
      } else if (e % 13 === 12) {
        kind = "wall drawn or erased";
        const id = `wal_extra${String(extra).padStart(8, "0")}`;
        const had = model.get("wall", id);
        if (had) {
          model.remove("wall", id);
          ops.push({ k: "delete", e: "wall", id, prev: had });
          extra++;
        } else {
          const x = 5 + r() * 70;
          const y = 5 + r() * 50;
          const w = {
            id,
            sceneId: SCENE_ID,
            a: { x, y },
            b: { x: x + (r() - 0.5) * 20, y: y + (r() - 0.5) * 20 },
            kind: "wall",
            doorState: null,
            hidden: false,
          } as never;
          model.put("wall", w);
          ops.push({ k: "create", e: "wall", id, value: w });
        }
      } else {
        const s = scene.step(0);
        ops.push(...s.ops);
        kind = s.kind;
      }
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      service.onCommitted(ops);

      // From scratch: a new service (new geometry, the whole raster, nothing remembered)…
      const fresh = new VisionService(model, scratchDb, host);
      expect(lightData(service)).toEqual(lightData(fresh));
      for (const u of players) {
        for (const t of model.inScene("token", SCENE_ID))
          expect([e, kind, u, t.id, service.perceives(u, t)]).toEqual([
            e,
            kind,
            u,
            t.id,
            fresh.perceives(u, t),
          ]);
        for (const l of model.inScene("light", SCENE_ID)) {
          if (!l.tokenId) continue;
          const got = service.seesLight(u, l.id);
          expect([e, kind, u, l.id, got]).toEqual([e, kind, u, l.id, fresh.seesLight(u, l.id)]);
          if (got && !service.perceives(u, model.get("token", l.tokenId) as never)) glows++;
        }
      }
      fresh.dispose();
      // …and explored memory as every view so far marked in full, with the light as it was then.
      const fx = sceneEffects(model, SCENE_ID);
      const world = new VisionWorld(
        new VisionGeometry(sceneWalls(model, SCENE_ID), fx.opaque, fx.solid),
        [...sceneLights(model, SCENE_ID), ...fx.lights],
        scn.ambient.level,
        scn.bounds,
        fx.obscurers,
      );
      const light = new LightRaster(scn.bounds, scn.fogCellFt);
      light.build(world);
      for (const u of players) {
        const own = model.inScene("token", SCENE_ID).filter((t) => !t.hidden && t.ownerIds.includes(u));
        const want = explored.get(u) as Raster;
        if (
          markSeen(
            world,
            light,
            own.map((t) => prepareViewer(world, tokenViewer(model, t))),
            want,
          )
        )
          marked++;
        const got = service.layer(SCENE_ID, `explored:${u}`);
        let diff = 0;
        for (let k = 0; k < want.data.length; k++) if (got.data[k] !== want.data[k]) diff++;
        expect([e, kind, u, diff]).toEqual([e, kind, u, 0]);
      }
    }
    service.dispose();
    // The run covered what it claims to (every kind of event, glows seen round corners, memory growing).
    expect([...kinds.keys()].sort()).toEqual(
      [
        "creature",
        "door",
        "lantern turned",
        "light toggled",
        "torch",
        "viewer",
        "wall drawn or erased",
      ].sort(),
    );
    expect(glows).toBeGreaterThan(0);
    expect(marked).toBeGreaterThan(20);
  });
});
