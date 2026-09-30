import type { CDPSession, Page } from "@playwright/test";
import { adminAtTable, boardSettled, camera, createScene, hook, introDone, req } from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const PHONE = { width: 390, height: 844 };
type Tok = { id: string; name: string; pos: { x: number; y: number } };

/** Screen point over a token's base. */
async function screenOf(p: Page, id: string): Promise<{ x: number; y: number }> {
  const t = (await hook<Tok | null>(p, "token", id)) as Tok;
  const s = await hook<{ sx: number; sy: number }>(p, "project", t.pos.x, t.pos.y, 0.15);
  return { x: s.sx, y: s.sy };
}

const touch = (
  cdp: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: { x: number; y: number }[],
) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, i) => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
      id: i,
      radiusX: 4,
      radiusY: 4,
    })),
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The gestures of a phone (SPEC §8.21 Touch; AC-RSP-02), through Chromium's touch input (pointerType "touch"): a finger
 * drags a token to move it, two fingers pinch the view in and out, and a long press on a token opens its radial menu.
 */
test.describe("P14 — touch gestures (RSP)", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("AC-RSP-02: drag-to-move, pinch zoom and the long-press menu on a phone", async ({ admin }) => {
    test.setTimeout(240_000);
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Courtyard",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 60,
    });
    await boardSettled(admin, sceneId);
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Scout",
      pos: { x: 17.5, y: 27.5 },
    });
    await expect.poll(() => hook(admin, "token", tokenId)).not.toBeNull();
    await camera(admin, { pitchDeg: 80, frame: { minX: 0, minY: 10, maxX: 40, maxY: 45 } });
    await admin.waitForTimeout(500);
    const cdp = await admin.context().newCDPSession(admin);

    // ── A long press opens the token's radial menu (and a short tap doesn't) ──
    const at = await screenOf(admin, tokenId);
    await touch(cdp, "touchStart", [at]);
    await wait(120);
    await touch(cdp, "touchEnd", []);
    await admin.waitForTimeout(300);
    await expect(admin.getByRole("menu", { name: "Actions for Scout" })).toHaveCount(0);
    await touch(cdp, "touchStart", [at]);
    await wait(750);
    await touch(cdp, "touchEnd", []);
    const menu = admin.getByRole("menu", { name: "Actions for Scout" });
    await expect(menu.getByRole("menuitem").first()).toBeVisible();
    await admin.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // ── A finger drags the token two squares east: it moves there ──
    const from = await screenOf(admin, tokenId);
    const to = await hook<{ sx: number; sy: number }>(admin, "project", 27.5, 27.5, 0.15);
    await touch(cdp, "touchStart", [from]);
    for (let i = 1; i <= 12; i++) {
      await touch(cdp, "touchMove", [
        { x: from.x + ((to.sx - from.x) * i) / 12, y: from.y + ((to.sy - from.y) * i) / 12 },
      ]);
      await wait(30);
    }
    await touch(cdp, "touchEnd", []);
    await expect
      .poll(async () => ((await hook<Tok>(admin, "token", tokenId)) as Tok).pos, { timeout: 10_000 })
      .toEqual({ x: 27.5, y: 27.5 });

    // ── Two fingers pinch: apart zooms in (the camera comes closer), together zooms out ──
    const before = (await camera(admin)).distance;
    const cx = PHONE.width / 2;
    const cy = PHONE.height * 0.45;
    const pinch = async (fromGap: number, toGap: number) => {
      await touch(cdp, "touchStart", [
        { x: cx - fromGap / 2, y: cy },
        { x: cx + fromGap / 2, y: cy },
      ]);
      for (let i = 1; i <= 10; i++) {
        const g = fromGap + ((toGap - fromGap) * i) / 10;
        await touch(cdp, "touchMove", [
          { x: cx - g / 2, y: cy },
          { x: cx + g / 2, y: cy },
        ]);
        await wait(30);
      }
      await touch(cdp, "touchEnd", []);
      await admin.waitForTimeout(600);
    };
    await pinch(80, 260);
    const closer = (await camera(admin)).distance;
    expect(closer, "pinched apart: closer").toBeLessThan(before * 0.9);
    await pinch(260, 80);
    expect((await camera(admin)).distance, "pinched together: further").toBeGreaterThan(closer * 1.1);
    // (A pinch never moved the token.)
    expect(((await hook<Tok>(admin, "token", tokenId)) as Tok).pos).toEqual({ x: 27.5, y: 27.5 });
  });
});
