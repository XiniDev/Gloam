import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  camera,
  hook,
  intro,
  introDone,
  req,
} from "../fixtures/board.ts";
import type { GloamProcess } from "../fixtures/server.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The client budgets of SPEC §37 on the benchmark scene, in headed Chromium on this machine's GPU (headless WebGL is
 * software-rendered): AC-PERF-01 (High, 1080p: ≥ 60 fps median, p95 frame ≤ 20 ms), AC-RSP-05 (Low, DPR 1, 4× CPU
 * throttle: ≥ 30 fps), AC-PERF-04 (a player joining the loaded scene sees the board within 4 s at 20 Mbps; its assets
 * cached afterwards) and AC-PERF-05 (no frame over 100 ms from shader compilation in play: the warm-up's, a tier change,
 * spells, dice). Results, with the machine's CPU and GPU, go to artifacts/bench/client.json.
 */

type Bench = Record<string, unknown>;
const results: Bench = {};
const OUT = join(process.cwd(), "artifacts", "bench");

function stats(deltas: number[]) {
  const s = [...deltas].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    frames: s.length,
    medianMs: r(q(0.5)),
    p95Ms: r(q(0.95)),
    maxMs: r(s[s.length - 1] ?? 0),
    medianFps: r(1000 / (q(0.5) || 1)),
  };
}

const warm = () => {
  // (Also run on about:blank, where there's no storage.)
  try {
    localStorage.setItem("gloam:warmup", "on");
  } catch {}
};

/** The benchmark scene (§37), seeded into the test campaign and made the live scene. */
async function seedBench(admin: Page, gloam: GloamProcess) {
  const list = (await (await admin.request.get(`${gloam.url}/api/admin/campaigns`)).json()) as {
    data: { id: string; name: string }[];
  };
  const campaignId = list.data.find((c) => c.name === "Test Campaign")?.id as string;
  const made = await admin.evaluate(async (id) => {
    const csrf = decodeURIComponent(document.cookie.match(/gloam_csrf=([^;]+)/)?.[1] ?? "");
    const r = await fetch(`/api/admin/campaigns/${id}/benchmark-scene`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gloam-csrf": csrf },
      body: JSON.stringify({ archived: false }),
    });
    return (
      (await r.json()) as { data: { sceneId: string; viewerTokenIds: string[]; creatureIds: string[] } }
    ).data;
  }, campaignId);
  await req(admin, "scene.activate", { sceneId: made.sceneId });
  await boardSettled(admin, made.sceneId);
  return made;
}

/** The Admin at the table (warmed up), with the benchmark scene live. */
async function benchTable(admin: Page, gloam: GloamProcess) {
  await admin.evaluate(warm);
  const code = await adminAtTable(admin);
  await introDone(admin);
  return { code, warm, ...(await seedBench(admin, gloam)) };
}

async function framesFor(p: Page, tour: () => Promise<void>): Promise<number[]> {
  await hook(p, "frameTimes", true);
  await tour();
  return hook<number[]>(p, "frameTimes", false);
}

/** Round the scene: its middle from above, then low across the rooms, then the far corner, near and far. */
async function tourOf(p: Page, w: number, h: number) {
  const stops: [number, number, number, number][] = [
    [w / 2, h / 2, 60, 170],
    [w * 0.25, h * 0.3, 40, 90],
    [w * 0.7, h * 0.4, 35, 70],
    [w * 0.8, h * 0.8, 55, 110],
    [w * 0.4, h * 0.7, 45, 80],
    [w / 2, h / 2, 60, 170],
  ];
  for (const [x, y, pitch, dist] of stops) {
    await camera(p, { target: [x, y], pitchDeg: pitch, distance: dist, ms: 1500 });
    await p.waitForTimeout(1700);
  }
}

test.describe.configure({ mode: "serial" });

test.describe("§37 client budgets on the benchmark scene (headed, host GPU)", () => {
  test.afterAll(() => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "client.json"), `${JSON.stringify(results, null, 2)}\n`);
  });

  test("AC-PERF-01 / AC-PERF-05: High at 1080p holds 60 fps (p95 ≤ 20 ms); no frame over 100 ms in play", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const t = await benchTable(admin, gloam);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, t.code, "Dave", {
      viewport: { width: 1920, height: 1080 },
      onPage: (p) => p.addInitScript(t.warm),
    });
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    for (const id of t.viewerTokenIds) await req(admin, "token.update", { tokenId: id, ownerIds: [daveId] });
    await req(admin, "combat.quickStart", {});
    await boardSettled(dave, t.sceneId);
    await hook(dave, "settings", { tier: "high" });
    await expect
      .poll(async () => (await hook<{ tier: string }>(dave, "stats")).tier, { timeout: 30_000 })
      .toBe("high");
    const device = (await hook<{ device: { renderer: string } }>(dave, "stats")).device;
    const warm = await hook<{ ms: number; programsAfter: number; steps: unknown }>(dave, "warmup");
    const marks = (await intro(dave))?.marks;
    await dave.waitForTimeout(2000);

    const high = stats(await framesFor(dave, () => tourOf(dave, 200, 150)));
    results.machine = { cpu: cpus()[0]?.model ?? "unknown", threads: cpus().length, gpu: device?.renderer };
    results.high1080 = { ...high, tier: "high", viewport: "1920×1080", dpr: 1, warmup: warm };
    console.log("[bench] high 1080p", JSON.stringify(results.high1080));
    expect(high.medianFps, "median fps").toBeGreaterThanOrEqual(60);
    expect(high.p95Ms, "p95 frame").toBeLessThanOrEqual(20);

    // ── Play, with a stopwatch on every frame: spells, dice, moves, a tier change down and back ──
    const play = await framesFor(dave, async () => {
      const mage = t.creatureIds[10] as string;
      for (const [spellId, level, extra] of [
        ["fireball", 3, { placement: { origin: { x: 60, y: 40, z: 0 } } }],
        ["lightning-bolt", 3, { placement: { origin: { x: 50, y: 50, z: 0 }, dirDeg: 90 } }],
        ["magic-missile", 1, { targets: [t.creatureIds[12], t.creatureIds[13], t.creatureIds[14]] }],
        ["cure-wounds", 1, { targets: [t.creatureIds[15]] }],
      ] as const) {
        await req(admin, "spell.cast", { casterTokenId: mage, spellId, mode: "free", level, ...extra }).catch(
          () => {},
        );
        await dave.waitForTimeout(700);
      }
      await req(dave, "dice.roll", { formula: "1d20 + 2d6 + 1d8" });
      await dave.waitForTimeout(2500);
      await hook(dave, "settings", { tier: "medium" });
      await expect
        .poll(async () => (await hook<{ tier: string }>(dave, "stats")).tier, { timeout: 30_000 })
        .toBe("medium");
      await dave.waitForTimeout(1500);
      await hook(dave, "settings", { tier: "low" });
      await expect
        .poll(async () => (await hook<{ tier: string }>(dave, "stats")).tier, { timeout: 30_000 })
        .toBe("low");
      await dave.waitForTimeout(1500);
      await hook(dave, "settings", { tier: "high" });
      await expect
        .poll(async () => (await hook<{ tier: string }>(dave, "stats")).tier, { timeout: 30_000 })
        .toBe("high");
      await dave.waitForTimeout(1500);
    });
    const drawn = (await hook<{ at: number; origin: string }[]>(dave, "programs")).filter(
      (c) => c.origin === "draw" && c.at > (marks?.board ?? 0),
    );
    results.play = { ...stats(play), drawCompilesAfterBoard: drawn.length };
    console.log("[bench] play", JSON.stringify(results.play));
    expect(drawn, "programs a frame compiled in play").toEqual([]);
    expect(stats(play).maxMs, "longest frame in play").toBeLessThanOrEqual(100);
  });

  test("AC-RSP-05: Low at DPR 1 under a 4× CPU throttle holds 30 fps", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const t = await benchTable(admin, gloam);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, t.code, "Dave", {
      viewport: { width: 412, height: 915 },
      onPage: (p) => p.addInitScript(t.warm),
    });
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    for (const id of t.viewerTokenIds) await req(admin, "token.update", { tokenId: id, ownerIds: [daveId] });
    await req(admin, "combat.quickStart", {});
    await boardSettled(dave, t.sceneId);
    await hook(dave, "settings", { tier: "low" });
    await expect
      .poll(async () => (await hook<{ tier: string }>(dave, "stats")).tier, { timeout: 30_000 })
      .toBe("low");
    const cdp: CDPSession = await dave.context().newCDPSession(dave);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await dave.waitForTimeout(2000);
    const low = stats(await framesFor(dave, () => tourOf(dave, 200, 150)));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    results.lowThrottled = { ...low, tier: "low", viewport: "412×915", dpr: 1, cpuThrottle: 4 };
    console.log("[bench] low ×4", JSON.stringify(results.lowThrottled));
    expect(low.medianFps, "median fps").toBeGreaterThanOrEqual(30);
  });

  test("AC-PERF-04: a player joining the loaded scene sees the board within 4 s at 20 Mbps; its assets cached afterwards", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    await admin.evaluate(warm);
    const code = await adminAtTable(admin);
    await introDone(admin);
    // Erin has played here before (the app is in her browser's cache), and leaves; the DM then sets up tonight's
    // scene, whose map and minis she has never loaded.
    const erin = await admitPlayer(admin, browser, gloam, guardLog, code, "Erin", {
      viewport: { width: 1920, height: 1080 },
      onPage: (p) => p.addInitScript(warm),
    });
    await erin.goto("about:blank");
    await seedBench(admin, gloam);
    const cdp = await erin.context().newCDPSession(erin);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 20,
      downloadThroughput: (20e6 / 8) | 0,
      uploadThroughput: (5e6 / 8) | 0,
    });
    const fromCache: boolean[] = [];
    const seen: string[] = [];
    cdp.on(
      "Network.responseReceived",
      (e: { response: { url: string; fromDiskCache?: boolean; fromMemoryCache?: boolean } }) => {
        if (new URL(e.response.url).pathname.startsWith("/assets/")) {
          fromCache.push(Boolean(e.response.fromDiskCache || e.response.fromMemoryCache));
          seen.push(
            `${e.response.url.replace(gloam.url, "")} ${Boolean(e.response.fromDiskCache || e.response.fromMemoryCache)}`,
          );
        }
      },
    );
    const join = async () => {
      fromCache.length = 0;
      await erin.goto(`${gloam.url}/table`);
      await introDone(erin);
      return (await intro(erin))?.marks.board ?? Number.POSITIVE_INFINITY;
    };
    const first = await join();
    const firstAssets = [...fromCache];
    await erin.goto("about:blank");
    const again = await join();
    results.join = {
      network: "20 Mbps down, 5 up, 20 ms",
      firstMs: Math.round(first),
      againMs: Math.round(again),
      assetsFirst: firstAssets.length,
      assetsCachedAfter: fromCache.filter(Boolean).length,
      assetsAfter: fromCache.length,
    };
    console.log("[bench] join", JSON.stringify(results.join), seen.join(" · "));
    expect(first, "time to board, first join (ms)").toBeLessThanOrEqual(4000);
    expect(firstAssets.length).toBeGreaterThan(0);
    expect(fromCache.length === 0 || fromCache.every(Boolean), "assets from the cache on the next join").toBe(
      true,
    );
  });
});
