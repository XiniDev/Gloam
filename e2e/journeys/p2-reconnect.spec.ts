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
    await camera(dave, { pitchDeg: 70, distance: 45, target: [25, 18], ms: 0 });
    await expect
      .poll(async () => {
        const c = await camera(dave);
        return Math.abs(c.pitchDeg - 70) + Math.abs(c.target[0] - 25) + Math.abs(c.target[2] - 18);
      })
      .toBeLessThan(0.05);
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
    const t0 = Date.now();
    gloam.dropClient(daveId);
    await expect.poll(() => hook<string>(dave, "connection"), { timeout: 10_000 }).toBe("dropped");
    await expect(dave.getByText(/reconnecting/i)).toBeVisible();
    await expect.poll(() => hook<string>(dave, "connection"), { timeout: 60_000 }).toBe("open");
    test.info().annotations.push({ type: "reconnect", description: `back after ${Date.now() - t0} ms` });
    expect(Date.now() - t0).toBeLessThan(60_000);
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
