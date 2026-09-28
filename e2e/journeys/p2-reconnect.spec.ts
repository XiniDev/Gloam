import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  camera,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1024, height: 700 };

test.describe("P2 — reconnection (AUTH-07)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-AUTH-07: a dropped connection comes back by itself within 60 s, without re-approval, keeping the camera and the selection; a reload restores them too", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Tavern",
      mapKind: "procedural",
      floorStyle: "wood",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Dave's Rogue",
      pos: { x: 25, y: 18 },
      disposition: "party",
      ownerIds: [daveId],
    });
    await boardSettled(dave, sceneId);
    await expect.poll(() => hook(dave, "token", tokenId)).not.toBeNull();
    // Dave frames his own view and selects his token.
    const setAt = await dave.evaluate(() => performance.now());
    await camera(dave, { pitchDeg: 70, distance: 45, target: [25, 18], ms: 0 });
    try {
      await expect
        .poll(async () => {
          const c = await camera(dave);
          return Math.abs(c.pitchDeg - 70) + Math.abs(c.target[0] - 25) + Math.abs(c.target[2] - 18);
        })
        .toBeLessThan(0.05);
    } catch (e) {
      // Diagnostics for an intermittent failure under load: the camera's recent frames, tweens and the rig's state.
      const log = await hook<{
        log: { t: number; tx: number; tz: number; pitch: number }[];
        tweenStarts: unknown[];
        rig: unknown;
      }>(dave, "cameraLog");
      test.info().annotations.push({
        type: "camera diagnostics",
        description: JSON.stringify({
          setAt,
          tweens: log.tweenStarts,
          rig: log.rig,
          frames: log.log
            .filter((x) => x.t > setAt - 500)
            .slice(0, 40)
            .map((x) => [Math.round(x.t), x.tx, x.tz, x.pitch]),
          scene: await hook(dave, "boardScene"),
        }),
      });
      throw e;
    }
    const t = (await hook<{ pos: { x: number; y: number } }>(dave, "token", tokenId)) as {
      pos: { x: number; y: number };
    };
    const s = (await hook<{ sx: number; sy: number }>(dave, "project", t.pos.x, t.pos.y, 0.15)) as {
      sx: number;
      sy: number;
    };
    await dave.mouse.click(s.sx, s.sy);
    const selection = () =>
      dave.evaluate(() => JSON.parse(sessionStorage.getItem("gloam.ui.v1") ?? "{}").selection as string[]);
    await expect.poll(selection).toEqual([tokenId]);
    await dave.waitForTimeout(700); // the camera settles and is remembered
    const cam0 = await camera(dave);

    // The network drops: the server loses Dave's socket without a goodbye.
    const knocksBefore = await admin.getByRole("alert").filter({ hasText: "knocking" }).count();
    type Change = { state: string; at: number };
    const changes = async () =>
      ((await hook<Change[]>(dave, "connectionLog")) ?? []).filter((c) => c.at >= t0);
    // The "reconnecting" banner, seen by an observer in the page (it can come and go between two polls).
    await dave.evaluate(() => {
      const w = window as unknown as { __bannerAt?: number };
      const look = () => {
        for (const el of document.querySelectorAll("[role=status]"))
          if (/reconnecting/i.test(el.textContent ?? "")) w.__bannerAt ??= Date.now();
      };
      new MutationObserver(look).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    const t0 = await dave.evaluate(() => Date.now());
    gloam.dropClient(daveId);
    // The client sees the drop (it says so while it reconnects) and comes back — recorded in the page as it happens,
    // as a local reconnect can be quicker than any poll.
    await expect
      .poll(async () => (await changes()).some((c) => c.state === "dropped"), { timeout: 10_000 })
      .toBe(true);
    await expect.poll(() => hook<string>(dave, "connection"), { timeout: 60_000 }).toBe("open");
    const log = await changes();
    const dropped = log.find((c) => c.state === "dropped") as Change;
    const back = log.find((c) => c.state === "open" && c.at >= dropped.at) as Change;
    test.info().annotations.push({
      type: "reconnect",
      description: `dropped after ${dropped.at - t0} ms, back after ${back.at - t0} ms (${log.map((c) => c.state).join(" → ")})`,
    });
    expect(back.at - t0).toBeLessThan(60_000);
    const bannerAt = await dave.evaluate(
      () => (window as unknown as { __bannerAt?: number }).__bannerAt ?? null,
    );
    expect(bannerAt).not.toBeNull();
    expect(bannerAt as number).toBeGreaterThanOrEqual(dropped.at);
    // No re-approval: still at the table, no knock card for the DM.
    await expect(dave).toHaveURL(/\/table$/);
    expect(await admin.getByRole("alert").filter({ hasText: "knocking" }).count()).toBe(knocksBefore);
    // The camera and the selection are as they were, and the table works (a command round-trips).
    const cam1 = await camera(dave);
    expect(Math.hypot(cam1.target[0] - cam0.target[0], cam1.target[2] - cam0.target[2])).toBeLessThan(0.05);
    expect(cam1.pitchDeg).toBeCloseTo(cam0.pitchDeg, 1);
    expect(cam1.distance).toBeCloseTo(cam0.distance, 1);
    expect(await selection()).toEqual([tokenId]);
    await req(dave, "token.update", { tokenId, name: "Dave's Rogue (back)" });
    await expect
      .poll(async () => ((await hook<{ name: string }>(admin, "token", tokenId)) as { name: string }).name)
      .toBe("Dave's Rogue (back)");

    // A reload (or a new tab after a crash) restores the view and the selection as well.
    await dave.reload();
    await introDone(dave);
    await boardSettled(dave, sceneId);
    const cam2 = await camera(dave);
    expect(Math.hypot(cam2.target[0] - cam0.target[0], cam2.target[2] - cam0.target[2])).toBeLessThan(0.05);
    expect(cam2.pitchDeg).toBeCloseTo(cam0.pitchDeg, 1);
    expect(await selection()).toEqual([tokenId]);
  });
});
