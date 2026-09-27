import {
  adminAtTable,
  assetFixtures,
  boardSettled,
  createScene,
  hook,
  hudBoxes,
  installRecorder,
  intro,
  introDone,
  readRec,
  recordFrames,
  req,
  stats,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, openTableAs, test } from "../fixtures/test.ts";

test.describe("P2 — first load, fonts and the table at 1 unit = 1 ft (DS-04, BRD-05, BRD-01, DS-06)", () => {
  test("AC-DS-04 / AC-BRD-05: candle → board fade-up → staggered HUD, once per load, no flash, no layout jump; reduced motion", {
    tag: "@timing",
  }, async ({ admin }) => {
    await openTableAs(admin, "Local only");
    await admin.evaluate(installRecorder);
    const rec0 = await recordFrames(admin);
    await admin.getByRole("button", { name: "Go to the table" }).click();
    await expect(admin).toHaveURL(/\/table$/);
    await expect(admin.getByTestId("intro")).toBeVisible();
    await introDone(admin);
    const frames = await rec0.stop();

    // The sequence and its timings (SPEC §27.7): ignite ≥ 400 ms, board fade 900 ms, HUD 60 ms apart.
    const s = await intro(admin);
    expect(s?.reduced).toBe(false);
    const m = s?.marks ?? {};
    const board = (m.board as number) - (m.ignite as number);
    const fade = (m.hud as number) - (m.board as number);
    const stagger = (m.done as number) - (m.hud as number);
    test.info().annotations.push({
      type: "timeline",
      description: `ignite→board ${Math.round(board)} ms, board fade ${Math.round(fade)} ms, HUD ${Math.round(stagger)} ms`,
    });
    expect(board).toBeGreaterThanOrEqual(400);
    expect(fade).toBeGreaterThanOrEqual(900);
    expect(fade).toBeLessThan(900 + 400);
    expect(stagger).toBeGreaterThanOrEqual(3 * 60 + 220);
    const rec = await readRec(admin);
    expect(rec.hud?.map((h) => [h.i, h.name, h.delay]).sort()).toEqual([
      ["0", "rise-in", "0s"],
      ["1", "rise-in", "0.06s"],
      ["2", "rise-in", "0.12s"],
      ["3", "rise-in", "0.18s"],
    ]);

    // No white flash: every screenshot is dark, and no on-screen background was ever light.
    test
      .info()
      .annotations.push({ type: "frames", description: `${frames.length} composited frames checked` });
    expect(frames.length).toBeGreaterThan(10);
    for (const f of frames) {
      expect(f.mean).toBeLessThan(140);
      expect(f.white).toBeLessThan(0.02);
    }
    expect(rec.lightFrames).toEqual([]);
    expect(rec.frames).toBeGreaterThan(10);
    // No layout jump: nothing shifted, and every HUD group sits exactly where it was while hidden.
    expect(rec.shifts.reduce((a, b) => a + b, 0)).toBeLessThan(0.001);
    expect(await hudBoxes(admin)).toEqual(rec.boxesStart);

    // Once per load: back to the Admin console and to the table again — no intro.
    await admin.getByRole("button", { name: "Admin console" }).click();
    await admin.getByRole("button", { name: "Go to the table" }).click();
    await expect(admin.getByRole("heading", { name: "Test Campaign" })).toBeVisible();
    for (let i = 0; i < 5; i++) {
      await expect(admin.getByTestId("intro")).toHaveCount(0);
      await admin.waitForTimeout(150);
    }
    expect((await intro(admin))?.marks).toEqual(m);

    // A new load with reduced motion: short fades, no ignition, no stagger.
    await admin.emulateMedia({ reducedMotion: "reduce" });
    await admin.addInitScript(installRecorder);
    await admin.reload();
    await introDone(admin);
    const r = await intro(admin);
    expect(r?.reduced).toBe(true);
    const rm = r?.marks ?? {};
    expect((rm.hud as number) - (rm.board as number)).toBeLessThan(220 + 300);
    expect((rm.done as number) - (rm.hud as number)).toBeLessThan(120 + 300);
    const rrec = await readRec(admin);
    expect(new Set(rrec.hud?.map((h) => h.delay))).toEqual(new Set(["0s"]));
    expect(rrec.lightFrames).toEqual([]);
  });

  test("AC-BRD-01 / AC-DS-06: the table and map at 1 unit = 1 ft, self-hosted fonts, nothing leaves the origin", async ({
    admin,
    gloam,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    // An empty table first: the oak table under the lamp, rendered.
    await expect.poll(async () => (await stats(admin)).firstFrameAt).not.toBeNull();

    // A 1400 × 700 px map at 70 px per 5 ft is 100 × 50 ft on the table.
    const { dungeonPng } = await assetFixtures();
    const asset = await uploadVia(
      admin,
      await dungeonPng({ cols: 20, rows: 10, pxPer5ft: 70 }),
      "hall.png",
      "map",
    );
    const sceneId = await createScene(admin, {
      name: "The Hall",
      mapKind: "image",
      mapAssetId: asset.id,
      pxPer5ft: 70,
    });
    await boardSettled(admin, sceneId);
    await expect
      .poll(async () => (await stats(admin)).map)
      .toMatchObject({ kind: "image", worldW: 100, worldH: 50 });
    // Creature spaces in feet: a Medium base is 5 units across, a Large one 10.
    const { tokenId: m } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Guard",
      pos: { x: 20, y: 20 },
    });
    const { tokenId: l } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Ogre",
      pos: { x: 40, y: 20 },
      size: "large",
    });
    const base = (id: string) =>
      hook<{ parts: Record<string, { diameter?: number }> } | null>(admin, "tokenState", id).then(
        // A coin is its own base; standees and minis stand on one. Either way: the creature's space.
        (st) => st?.parts.base?.diameter ?? st?.parts.coin?.diameter,
      );
    await expect.poll(() => base(m)).toBe(5);
    await expect.poll(() => base(l)).toBe(10);
    // Fonts: all four families are loaded, from this origin only.
    const fonts = await admin.evaluate(async () => {
      await document.fonts.ready;
      const families = ["Fraunces Variable", "Alegreya Sans", "Cinzel", "JetBrains Mono Variable"];
      const loaded = families.filter((f) =>
        [...document.fonts].some((ff) => ff.family.replace(/"/g, "") === f && ff.status === "loaded"),
      );
      const files = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => /\.(woff2?|ttf|otf)(\?|$)/.test(n));
      return { loaded, files };
    });
    expect(fonts.loaded.sort()).toEqual(
      ["Alegreya Sans", "Cinzel", "Fraunces Variable", "JetBrains Mono Variable"].sort(),
    );
    expect(fonts.files.length).toBeGreaterThan(0);
    for (const f of fonts.files) expect(new URL(f).origin).toBe(new URL(gloam.url).origin);
    // (The guard fixture fails the test on any CSP violation or request that left the origin.)
  });
});
