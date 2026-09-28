import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  camera,
  canvasImage,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };

async function screen(p: Page, x: number, y: number) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, 0)) as { sx: number; sy: number };
  return { x: s.sx, y: s.sy };
}

/** Pixels in a square around a table point that read as the brass hatch (warm: red over green over blue). */
async function hatchPixels(p: Page, x: number, y: number, half = 40): Promise<number> {
  const img = await canvasImage(p);
  const s = await screen(p, x, y);
  const cx = Math.round((s.x - img.left) * img.scale);
  const cy = Math.round((s.y - img.top) * img.scale);
  let n = 0;
  for (let j = cy - half; j <= cy + half; j++)
    for (let i = cx - half; i <= cx + half; i++) {
      const k = (j * img.width + i) * 3;
      const r = img.data[k] as number;
      const g = img.data[k + 1] as number;
      const b = img.data[k + 2] as number;
      if (r > g + 8 && g > b + 8) n++;
    }
  return n;
}

test.describe("P4 — the DM's view and View as (VIS-10)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-VIS-10: the DM sees everything with the players' fog hatched; View as draws the board exactly as that player's own screen does, and changes nothing for anyone else", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    // Still motion (the war fog doesn't drift, nothing flickers): two screens can be compared pixel for pixel.
    await admin.emulateMedia({ reducedMotion: "reduce" });
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Glade",
      mapKind: "procedural",
      floorStyle: "grass",
      widthFt: 60,
      heightFt: 40,
    });
    await req(admin, "scene.update", { sceneId, fogMode: "dynamic", ambientLevel: "dark", walls3d: false });
    await req(admin, "wall.create", {
      sceneId,
      walls: [
        { a: { x: 30, y: 0 }, b: { x: 30, y: 26 }, kind: "wall" },
        { a: { x: 12, y: 30 }, b: { x: 24, y: 30 }, kind: "wall" },
      ],
    });
    await boardSettled(admin, sceneId);
    const bob = await admitPlayer(admin, browser, gloam, guardLog, code, "Bob", {
      viewport: VIEWPORT,
      reducedMotion: "reduce",
    });
    const bobId = ((await hook<{ userId: string }>(bob, "me")) as { userId: string }).userId;
    const human = (
      await req<{ tokenId: string }>(admin, "token.create", {
        sceneId,
        name: "Bram",
        pos: { x: 14, y: 18 },
        disposition: "party",
        ownerIds: [bobId],
        stats: { hp: 20, hpMax: 20, ac: 15 },
      })
    ).tokenId;
    const ghoul = (
      await req<{ tokenId: string }>(admin, "token.create", {
        sceneId,
        name: "Ghoul",
        pos: { x: 45, y: 12 },
        stats: { hp: 22, hpMax: 22, ac: 12 },
      })
    ).tokenId;
    await req(bob, "light.carry", { tokenId: human, preset: "torch" });
    for (const p of [admin, bob]) {
      await boardSettled(p, sceneId);
      await camera(p, { pitchDeg: 90, distance: 56, target: [30, 20], ms: 0 });
    }
    await expect
      .poll(async () => (await hook<{ lightDraws: number }>(bob, "vision")).lightDraws)
      .toBeGreaterThan(0);
    await admin.waitForTimeout(800);

    // The DM sees the ghoul (behind the wall, in the dark), with the players' fog hatched over that side; the lit
    // clearing round Bob isn't hatched (sampled on open grass, clear of his token and its plate).
    expect(await hook(admin, "token", ghoul)).not.toBeNull();
    expect(await hatchPixels(admin, 45, 20)).toBeGreaterThan(40);
    expect(await hatchPixels(admin, 22, 10)).toBe(0);

    // View as Bob: the DM's board becomes Bob's.
    const bobTokens = async () => ((await hook<string[]>(bob, "visibleTokenIds")) ?? []).slice().sort();
    const before = await bobTokens();
    await admin.keyboard.press("b");
    await admin.getByTestId("view-as").selectOption(bobId);
    await expect(admin.getByTestId("view-as-banner")).toContainText("Bob");
    await expect
      .poll(async () => ((await hook<string[]>(admin, "visibleTokenIds")) ?? []).slice().sort())
      .toEqual(before);
    expect(before).not.toContain(ghoul);
    // Close the Fog tool (its brush ring is the DM's own mark), then compare the two boards pixel by pixel.
    await admin.keyboard.press("v");
    await admin.waitForTimeout(1200);
    const a = await canvasImage(admin);
    const b = await canvasImage(bob);
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    let diff = 0;
    let off = 0;
    for (let k = 0; k < a.data.length; k++) {
      const d = Math.abs((a.data[k] as number) - (b.data[k] as number));
      diff += d;
      if (d > 24) off++;
    }
    const mean = diff / a.data.length;
    test.info().annotations.push({
      type: "view as",
      description: `mean |Δ| ${mean.toFixed(3)} / 255, ${((off / a.data.length) * 100).toFixed(3)} % of channels off by > 24`,
    });
    expect(mean).toBeLessThan(1.5);
    expect(off / a.data.length).toBeLessThan(0.005);
    // Nothing changed for Bob.
    expect(await bobTokens()).toEqual(before);
    // Stop: the DM's own view again.
    await admin.getByRole("button", { name: "Stop viewing as" }).click();
    await expect(admin.getByTestId("view-as-banner")).toHaveCount(0);
    await expect
      .poll(async () => ((await hook<string[]>(admin, "visibleTokenIds")) ?? []).includes(ghoul))
      .toBe(true);
  });
});
