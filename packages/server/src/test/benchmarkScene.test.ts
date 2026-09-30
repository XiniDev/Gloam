import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBenchmarkScene, BENCH_SCENE } from "../demo/benchmark.ts";
import { MINI_COUNT, miniGlb } from "../demo/minis.ts";
import { CampaignModel } from "../engine/model.ts";
import { createCampaign, setupAdmin, startTestServer, type TestServer } from "./harness.ts";

/**
 * The benchmark scene (SPEC §37) as the demo seeds it and `pnpm bench` measures on it: every count §37 names, its
 * minis within their triangle budget and through the upload pipeline, and a campaign that loads with it.
 */
describe("P15 — the benchmark scene (PERF)", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
  }, 60_000);
  afterAll(async () => {
    await t?.stop();
  });

  it("three code-made minis, each at most 20 k triangles", async () => {
    expect(MINI_COUNT).toBe(3);
    for (let i = 0; i < MINI_COUNT; i++) {
      const m = await miniGlb(i);
      expect(m.triangles, m.name).toBeLessThanOrEqual(20_000);
      expect(m.triangles, m.name).toBeGreaterThan(2_000);
    }
  });

  it("§37's scene: an image map, 40 creatures (10 minis of 3 models), 300 walls with 12 doors, 20 lights (8 animated), 3 lasting effects, dynamic fog", async () => {
    const admin = await setupAdmin(t);
    const campaignId = await createCampaign(admin, "Bench");
    const adminUser = t.server.ctx.profiles.admin();
    const by = { userId: adminUser?.id as string, name: "Admin", role: "admin" as const, lobby: false };
    const made = await addBenchmarkScene(t.server.ctx, campaignId, by, { archived: true });
    const m = CampaignModel.load(t.server.ctx.db, campaignId) as CampaignModel;
    const scene = m.get("scene", made.sceneId);
    expect(scene).toMatchObject({ mapKind: "image", fogMode: "dynamic", bounds: { maxX: 200, maxY: 150 } });
    expect(scene?.archivedAt, "out of the DM's way").not.toBeNull();
    const walls = m.inScene("wall", made.sceneId);
    expect(walls).toHaveLength(BENCH_SCENE.walls);
    expect(walls.filter((w) => w.kind === "door")).toHaveLength(12);
    const lights = m.inScene("light", made.sceneId);
    expect(lights).toHaveLength(20);
    expect(lights.filter((l) => l.animation !== "none")).toHaveLength(8);
    const tokens = m.inScene("token", made.sceneId);
    expect(tokens).toHaveLength(40);
    const minis = tokens.filter((x) => x.appearance.mode === "model");
    expect(minis).toHaveLength(10);
    expect(new Set(minis.map((x) => x.appearance.assetId)).size).toBe(3);
    expect(made.viewerTokenIds).toHaveLength(4);
    expect(
      m
        .inScene("effect", made.sceneId)
        .map((e) => e.name)
        .sort(),
    ).toEqual(["Darkness", "Fog Cloud", "Spirit Guardians"]);
    // Its minis and map went through the pipeline, approved as the Admin's.
    const assets = m
      .all("asset")
      .filter((a) => minis.some((x) => x.appearance.assetId === a.id) || a.id === scene?.mapAssetId);
    expect(assets).toHaveLength(4);
    for (const a of assets) expect(a.status, a.name).toBe("approved");
  });
});
