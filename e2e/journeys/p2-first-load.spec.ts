import type { Page } from "@playwright/test";
import {
  adminAtTable,
  assetFixtures,
  boardSettled,
  brightness,
  createScene,
  hook,
  intro,
  introDone,
  req,
  stats,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, openTableAs, test } from "../fixtures/test.ts";

/** Loaded into the page before the table mounts: layout shifts, the HUD's boxes and styles at each intro phase,
 * and the background colour of what's on screen every animation frame (a white flash would show here). */
function installRecorder() {
  type Rec = {
    shifts: number[];
    boxesStart: { i: string; x: number; y: number; w: number; h: number }[] | null;
    hud: { i: string; name: string; delay: string }[] | null;
    lightFrames: string[];
    frames: number;
    running: boolean;
  };
  const rec: Rec = { shifts: [], boxesStart: null, hud: null, lightFrames: [], frames: 0, running: true };
  (window as unknown as { __rec: Rec }).__rec = rec;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
      if (!e.hadRecentInput) rec.shifts.push(e.value);
  }).observe({ type: "layout-shift", buffered: false });
  const boxes = () =>
    [...document.querySelectorAll<HTMLElement>("[data-hud-order]")].map((el) => ({
      i: el.dataset.hudOrder ?? "",
      x: el.offsetLeft,
      y: el.offsetTop,
      w: el.offsetWidth,
      h: el.offsetHeight,
    }));
  new MutationObserver(() => {
    const phase = document.querySelector("[data-intro]")?.getAttribute("data-intro");
    if (phase && !rec.boxesStart && document.querySelector("[data-hud-order]")) rec.boxesStart = boxes();
    if (phase === "hud" && !rec.hud)
      rec.hud = [...document.querySelectorAll<HTMLElement>("[data-hud-order]")].map((el) => {
        const cs = getComputedStyle(el);
        return { i: el.dataset.hudOrder ?? "", name: cs.animationName, delay: cs.animationDelay };
      });
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-intro"] });
  const lum = (c: string) => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) < 0.5) return null; // (mostly) transparent: shows what's behind
    return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
  };
  const tick = () => {
    if (!rec.running) return;
    rec.frames++;
    const probes: Element[] = [document.documentElement, document.body];
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.1, 0.1],
      [0.9, 0.9],
      [0.25, 0.75],
    ] as const) {
      const el = document.elementFromPoint(innerWidth * fx, innerHeight * fy);
      if (el && el.tagName !== "CANVAS") probes.push(el);
    }
    for (const el of probes) {
      const l = lum(getComputedStyle(el).backgroundColor);
      if (l !== null && l > 0.6) rec.lightFrames.push(`${el.tagName}.${el.className}`.slice(0, 80));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

type Rec = {
  shifts: number[];
  boxesStart: { i: string; x: number; y: number; w: number; h: number }[] | null;
  hud: { i: string; name: string; delay: string }[] | null;
  lightFrames: string[];
  frames: number;
};
const readRec = (page: Page) => page.evaluate(() => (window as unknown as { __rec: Rec }).__rec);
const hudBoxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-hud-order]")].map((el) => ({
      i: el.dataset.hudOrder ?? "",
      x: el.offsetLeft,
      y: el.offsetTop,
      w: el.offsetWidth,
      h: el.offsetHeight,
    })),
  );

/**
 * Every composited frame (Chrome's screencast, small JPEGs) from now until `stop()`: none may be bright (a white
 * flash). Screenshots are too slow under software GL to catch a flash; the screencast sees each painted frame.
 */
async function recordFrames(page: Page): Promise<{ stop(): Promise<{ mean: number; white: number }[]> }> {
  const cdp = await page.context().newCDPSession(page);
  const raw: Buffer[] = [];
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
    raw.push(Buffer.from(f.data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 480, maxHeight: 300 });
  return {
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
      return Promise.all(raw.map((b) => brightness(b)));
    },
  };
}

test.describe("P2 — first load, fonts and the table at 1 unit = 1 ft (DS-04, BRD-05, BRD-01, DS-06)", () => {
  test("AC-DS-04 / AC-BRD-05: candle → board fade-up → staggered HUD, once per load, no flash, no layout jump; reduced motion", async ({
    admin,
  }) => {
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
    expect(stagger).toBeGreaterThanOrEqual(3 * 60 + 240);
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
    expect((rm.hud as number) - (rm.board as number)).toBeLessThan(200 + 300);
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
    const { image } = await assetFixtures();
    const asset = await uploadVia(admin, await image("png", 1400, 700), "hall.png", "map");
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
