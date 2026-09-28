import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  camera,
  createScene,
  hook,
  hudBoxes,
  installRecorder,
  introDone,
  readRec,
  recordFrames,
  req,
  stats,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

interface Arrival {
  shown: number;
  settled: number;
  /** The scene's name was on screen (the transition's title) during the travel. */
  titleSeen: boolean;
  /** Diagnostics: animation-frame gaps over 120 ms and frames with loads pending [at, gap, pending, phase]. */
  diag: [number, number, number, string][];
}

/**
 * In the page: when (Date.now()) the board first showed `sceneId`, when its travel transition finished, and whether
 * the scene's name was shown on the way.
 */
async function watchArrival(page: Page, sceneId: string, name: string): Promise<() => Promise<Arrival>> {
  await page.evaluate(
    ({ id, name }) => {
      const w = window as unknown as {
        __arrive: Arrival;
        __gloam: { boardScene(): { shown: string | null; travelling: boolean; loading: number } };
      };
      w.__arrive = { shown: 0, settled: 0, titleSeen: false, diag: [] };
      // The title: every change of the transition's phase (a DOM mutation — whatever the frame rate).
      const seeTitle = () => {
        const el = document.querySelector("[data-testid=scene-transition]");
        if (el?.getAttribute("data-phase") === "title" && el.querySelector("h2")?.textContent === name)
          w.__arrive.titleSeen = true;
      };
      const mo = new MutationObserver(seeTitle);
      mo.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-phase"],
      });
      // Arrival on a 5-ms clock rather than animation frames (which a busy software renderer spaces out).
      let last = performance.now();
      const tick = () => {
        const b = w.__gloam.boardScene();
        const now = performance.now();
        const phase =
          document.querySelector("[data-testid=scene-transition]")?.getAttribute("data-phase") ?? "";
        seeTitle();
        if (now - last > 120 || b.loading)
          w.__arrive.diag.push([Math.round(now), Math.round(now - last), b.loading, phase]);
        last = now;
        if (b.shown === id && !w.__arrive.shown) w.__arrive.shown = Date.now();
        if (b.shown === id && !b.travelling && !w.__arrive.settled) w.__arrive.settled = Date.now();
        if (!w.__arrive.settled) setTimeout(tick, 5);
        else mo.disconnect();
      };
      tick();
    },
    { id: sceneId, name },
  );
  return async () => {
    await page.waitForFunction(
      () => (window as unknown as { __arrive: Arrival }).__arrive.settled > 0,
      null,
      {
        timeout: 15_000,
      },
    );
    return page.evaluate(() => (window as unknown as { __arrive: Arrival }).__arrive);
  };
}

type TravelLog = { phase: string; log: { sceneId: string; phase: string; at: number }[] };

/**
 * Travel timing is about the transition, not fill rate: under software GL a full-screen PBR table + procedural floor
 * takes seconds per frame at 1280 × 720, so these boards are 800 × 500 (on a GPU it's milliseconds at any size).
 */
const VIEWPORT = { width: 800, height: 500 };

test.describe("P2 — scenes: travel and procedural floors (SCN-02, BRD-05, SCN-05)", () => {
  test.use({ viewport: VIEWPORT });
  test("AC-SCN-02 / AC-BRD-05: activating a scene moves every player within 2 s through a fade with its name; only its entities arrive; no flash, no layout jump", {
    tag: "@timing",
  }, async ({ admin, browser, gloam, guardLog }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const crypt = await createScene(admin, {
      name: "The Crypt",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, crypt);
    const { tokenId: ghoul } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId: crypt,
      name: "Ghoul",
      pos: { x: 20, y: 20 },
    });
    const forest = await createScene(
      admin,
      { name: "Whispering Forest", mapKind: "procedural", floorStyle: "grass", widthFt: 80, heightFt: 50 },
      false,
    );
    const { tokenId: dryad } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId: forest,
      name: "Dryad",
      pos: { x: 30, y: 25 },
    });
    const players = [
      await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT }),
      await admitPlayer(admin, browser, gloam, guardLog, code, "Erin", { viewport: VIEWPORT }),
    ];
    for (const p of players) {
      await boardSettled(p, crypt);
      expect(await hook(p, "visibleTokenIds")).toEqual([ghoul]);
      await p.evaluate(installRecorder);
    }
    const programsBefore = await Promise.all(
      players.map((p) => hook<{ programs: number }>(p, "stats").then((x) => x.programs)),
    );
    const boxesBefore = await hudBoxes(players[0] as Page);
    const frames = await recordFrames(players[0] as Page);
    const arrivals = await Promise.all(players.map((p) => watchArrival(p, forest, "Whispering Forest")));

    // The DM activates the forest from the Scenes panel.
    await admin.getByRole("button", { name: "DM panel" }).click();
    await admin.getByRole("tab", { name: "Scenes" }).click();
    const row = admin.locator('[data-scene="Whispering Forest"]');
    await row.getByRole("button", { name: "Activate for players" }).click();
    const clickedAt = Date.now();

    for (const [i, arrived] of arrivals.entries()) {
      const a = await arrived();
      const who = i ? "Erin" : "Dave";
      expect(a.titleSeen, `${who} saw the scene's name`).toBe(true);
      test.info().annotations.push({
        type: "travel",
        description: `${who}: board shows the forest after ${a.shown - clickedAt} ms, transition done after ${a.settled - clickedAt} ms`,
      });
      expect(a.settled - clickedAt, `${who} moved within 2 s`).toBeLessThanOrEqual(2000);
    }
    const programsAfter = await Promise.all(
      players.map((p) => hook<{ programs: number }>(p, "stats").then((x) => x.programs)),
    );
    test
      .info()
      .annotations.push({ type: "programs", description: `before ${programsBefore} after ${programsAfter}` });
    // Same kinds of materials on both scenes: travel reuses the live shader programs instead of recompiling them.
    for (const [i, n] of programsAfter.entries()) expect(n).toBeLessThanOrEqual(programsBefore[i] as number);
    for (const p of players) {
      // Through black with the scene's name: out → title (name shown) → in → idle.
      const t = await hook<TravelLog>(p, "travel");
      const mine = t.log.filter((e) => e.sceneId === forest);
      const phases = mine.map((e) => e.phase);
      test.info().annotations.push({
        type: "phases",
        description: mine.map((e) => `${e.phase}@${Math.round(e.at - (mine[0]?.at ?? 0))}`).join(" "),
      });
      expect(phases).toEqual(["out", "title", "in", "idle"]);
      // Only the new scene's entities.
      expect(await hook(p, "visibleTokenIds")).toEqual([dryad]);
      expect((await stats(p)).map).toMatchObject({ kind: "procedural", style: "grass" });
    }
    // No white flash, no layout jump on the way.
    const seen = await frames.stop();
    test.info().annotations.push({ type: "frames", description: `${seen.length} composited frames checked` });
    // Every frame the compositor painted during the travel (a handful under software GL; each is checked), plus the
    // per-animation-frame background probe below.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const f of seen) expect(f.white).toBeLessThan(0.02);
    for (const p of players) {
      const rec = await readRec(p);
      expect(rec.lightFrames).toEqual([]);
      expect(rec.shifts.reduce((a, b) => a + b, 0)).toBeLessThan(0.001);
    }
    expect(await hudBoxes(players[0] as Page)).toEqual(boxesBefore);
  });

  test("AC-SCN-05: all six procedural floors render with no image asset (nothing to tile, so no seams)", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const assetRequests: string[] = [];
    admin.on("request", (r) => {
      if (/\/assets\//.test(new URL(r.url()).pathname)) assetRequests.push(r.url());
    });
    await expect.poll(async () => (await stats(admin)).firstFrameAt).not.toBeNull();
    const baseline = (await stats(admin)).memory.textures;
    for (const style of ["stone", "wood", "grass", "sand", "parchment", "cavern"] as const) {
      const id = await createScene(admin, {
        name: `Floor: ${style}`,
        mapKind: "procedural",
        floorStyle: style,
        widthFt: 120,
        heightFt: 80,
      });
      await boardSettled(admin, id);
      await expect.poll(async () => (await stats(admin)).map).toMatchObject({ kind: "procedural", style });
      // No textures: the floor is a function of world position, so there is no tile to repeat.
      expect((await stats(admin)).memory.textures).toBe(baseline);
      await camera(admin, { pitchDeg: 90, distance: 150, target: [60, 40], ms: 0 });
      await admin.waitForTimeout(400);
      await admin.screenshot({ path: `artifacts/screens/p2-floor-${style}.png` });
    }
    expect(assetRequests).toEqual([]);
  });
});
