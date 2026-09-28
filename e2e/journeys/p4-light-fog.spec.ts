import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardColour,
  boardSettled,
  camera,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };

async function screen(p: Page, x: number, y: number, elevation = 0) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, elevation)) as {
    sx: number;
    sy: number;
  };
  return { x: s.sx, y: s.sy };
}
async function colourAt(p: Page, x: number, y: number) {
  const s = await screen(p, x, y);
  return boardColour(p, s.x, s.y, 4);
}
async function dragOn(p: Page, a: { x: number; y: number }, b: { x: number; y: number }, steps = 8) {
  const s = await screen(p, a.x, a.y);
  await p.mouse.move(s.x, s.y);
  await p.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const q = await screen(p, a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await p.mouse.move(q.x, q.y);
  }
  await p.mouse.up();
}
async function clickAt(p: Page, x: number, y: number) {
  const s = await screen(p, x, y);
  await p.mouse.click(s.x, s.y);
}
/** The war fog: dark and blue (the unknown), as against a lit or remembered map. */
const isFog = (c: { r: number; g: number; b: number; lum: number }) => c.b > c.g && c.lum < 0.12;
const token = (p: Page, id: string) => hook<{ id: string } | null>(p, "token", id);
interface LightHook {
  id: string;
  on: boolean;
  bright: number;
  dim: number;
  anim: string;
  link?: { tokenId: string };
}

test.describe("P4 — lights and painted fog (VIS-03, VIS-01, SCN-07)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-VIS-03 / AC-SCN-07 / AC-VIS-01: a torch lit from the token's menu lights 20 ft bright and 20 ft dim, stopped by a wall, flickering; its owner puts it out; the DM changes light and fog mode live for everyone; painted fog — rectangle, brush, polygon, reveal room, one player or all", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(240_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Barrow",
      mapKind: "procedural",
      floorStyle: "grass",
      widthFt: 60,
      heightFt: 40,
    });
    await req(admin, "scene.update", { sceneId, fogMode: "dynamic", ambientLevel: "dark" });
    await req(admin, "wall.create", {
      sceneId,
      walls: [
        // A long wall at x = 35 (the torch doesn't light past it), and a room (40..56, 4..16) for Reveal room.
        { a: { x: 35, y: 0 }, b: { x: 35, y: 40 }, kind: "wall" },
        { a: { x: 40, y: 4 }, b: { x: 56, y: 4 }, kind: "wall" },
        { a: { x: 56, y: 4 }, b: { x: 56, y: 16 }, kind: "wall" },
        { a: { x: 56, y: 16 }, b: { x: 40, y: 16 }, kind: "wall" },
        { a: { x: 40, y: 16 }, b: { x: 40, y: 4 }, kind: "wall" },
      ],
    });
    await boardSettled(admin, sceneId);
    const anna = await admitPlayer(admin, browser, gloam, guardLog, code, "Anna", { viewport: VIEWPORT });
    const bob = await admitPlayer(admin, browser, gloam, guardLog, code, "Bob", { viewport: VIEWPORT });
    const annaId = ((await hook<{ userId: string }>(anna, "me")) as { userId: string }).userId;
    const bobId = ((await hook<{ userId: string }>(bob, "me")) as { userId: string }).userId;
    const mk = async (name: string, body: Record<string, unknown>) =>
      (await req<{ tokenId: string }>(admin, "token.create", { sceneId, name, ...body })).tokenId;
    const human = await mk("Bram", {
      pos: { x: 5, y: 5 },
      disposition: "party",
      ownerIds: [bobId],
      stats: { hp: 20, hpMax: 20, ac: 15 },
    });
    await mk("Nyx", {
      pos: { x: 30, y: 36 },
      disposition: "party",
      ownerIds: [annaId],
      stats: { hp: 18, hpMax: 18, ac: 14 },
    });
    const ghoul = await mk("Ghoul", { pos: { x: 30, y: 30 }, stats: { hp: 22, hpMax: 22, ac: 12 } });
    for (const p of [admin, anna, bob]) {
      await boardSettled(p, sceneId);
      await camera(p, { pitchDeg: 90, distance: 56, target: [30, 20], ms: 0 });
    }
    await bob.waitForTimeout(600);

    // AC-VIS-03: Bob lights a torch from his token's menu (Light → Torch).
    const t = (await hook<{ pos: { x: number; y: number } }>(bob, "token", human)) as {
      pos: { x: number; y: number };
    };
    const at = await screen(bob, t.pos.x, t.pos.y, 0.15);
    await bob.mouse.click(at.x, at.y, { button: "right" });
    await bob.getByRole("menuitem", { name: "Light" }).click();
    await bob.getByRole("menuitem", { name: "Torch" }).click();
    await expect
      .poll(async () => (await hook<LightHook[]>(bob, "lights")).find((l) => l.link?.tokenId === human))
      .toMatchObject({ bright: 20, dim: 20, anim: "torch", on: true });
    await bob.waitForTimeout(800);
    const bright = await colourAt(bob, 15, 5); // 10 ft: bright
    const dim = await colourAt(bob, 5, 33); // 28 ft: dim
    const dark = await colourAt(bob, 33, 37); // 43 ft: beyond the torch
    const walled = await colourAt(bob, 38, 5); // 33 ft, behind the wall
    expect(bright.sat).toBeGreaterThan(0.25);
    expect(dim.sat).toBeGreaterThan(0.25);
    expect(bright.lum).toBeGreaterThan(dim.lum * 1.2);
    expect(isFog(dark)).toBe(true);
    expect(isFog(walled)).toBe(true);
    // Flicker: the dim light's brightness moves over a couple of seconds (paced frames, gentle).
    const lums: number[] = [];
    for (let i = 0; i < 8; i++) {
      lums.push((await colourAt(bob, 5, 25)).lum);
      await bob.waitForTimeout(250);
    }
    expect(Math.max(...lums) - Math.min(...lums)).toBeGreaterThan(0.004);
    // Its owner puts it out (Light → Put out): dark again.
    await bob.mouse.click(at.x, at.y, { button: "right" });
    await bob.getByRole("menuitem", { name: "Light" }).click();
    await bob.getByRole("menuitem", { name: "Put out" }).click();
    await expect
      .poll(async () => (await hook<LightHook[]>(bob, "lights")).find((l) => l.link?.tokenId === human)?.on)
      .toBe(false);
    // Out: no longer seen — what he saw by it stays as memory (dark, grey-blue), not lit grass.
    await expect
      .poll(async () => {
        const c = await colourAt(bob, 15, 5);
        // (Memory is 35 % in linear light; after tone mapping it reads about 3/4 as bright, and grey.)
        return c.lum < bright.lum * 0.85 && c.sat < 0.2;
      })
      .toBe(true);

    // AC-SCN-07: the DM brightens the scene from the Fog panel; both players' boards follow within 500 ms.
    await admin.keyboard.press("b");
    await expect(admin.getByTestId("fog-panel")).toBeVisible();
    const clickAt0 = Date.now();
    await admin.getByRole("radio", { name: "Bright" }).click();
    for (const p of [anna, bob])
      await expect
        .poll(async () => (await hook<{ ambient: number }>(p, "vision")).ambient, { intervals: [10] })
        .toBe(2);
    expect(Date.now() - clickAt0).toBeLessThan(500 + 150); // (the polls' own round trips included)
    await expect.poll(async () => isFog(await colourAt(bob, 15, 5))).toBe(false);
    await admin.getByRole("radio", { name: "Dark" }).click();
    const modeAt = Date.now();
    await admin.getByRole("radio", { name: "Painted" }).click();
    for (const p of [anna, bob])
      await expect
        .poll(async () => (await hook<{ mode: number }>(p, "vision")).mode, { intervals: [10] })
        .toBe(1);
    expect(Date.now() - modeAt).toBeLessThan(500 + 150);

    // AC-VIS-01: painted — nothing revealed yet: fog over the map, the ghoul unseen.
    await expect.poll(() => token(bob, ghoul)).toBeNull();
    await expect.poll(async () => isFog(await colourAt(bob, 26.5, 26.5))).toBe(true);
    // A revealed rectangle: the grass shows there, and the ghoul standing in it.
    await admin.getByRole("radio", { name: "Rectangle" }).click();
    await dragOn(admin, { x: 25, y: 25 }, { x: 34, y: 34 });
    await expect.poll(() => token(bob, ghoul)).not.toBeNull();
    // (Sampled on the grass beside the ghoul, not on its coin.)
    await expect.poll(async () => (await colourAt(bob, 26.5, 26.5)).sat).toBeGreaterThan(0.25);
    expect(isFog(await colourAt(bob, 10, 30))).toBe(true);
    // The brush hides it again.
    await admin.getByRole("radio", { name: "Hide" }).click();
    await admin.getByRole("radio", { name: "Brush" }).click();
    await dragOn(admin, { x: 26, y: 30 }, { x: 34, y: 30 }, 10);
    await expect.poll(() => token(bob, ghoul)).toBeNull();
    // Reveal room: the walled room only, not the field around it.
    await admin.getByRole("radio", { name: "Reveal", exact: true }).click();
    await admin.getByRole("radio", { name: "Reveal room" }).click();
    await clickAt(admin, 48, 10);
    await expect.poll(async () => (await colourAt(bob, 48, 10)).sat).toBeGreaterThan(0.25);
    expect(isFog(await colourAt(bob, 48, 20))).toBe(true);
    // A polygon for Anna alone: she sees it, Bob doesn't.
    await admin.getByTestId("fog-target").selectOption(annaId);
    await admin.getByRole("radio", { name: "Polygon" }).click();
    for (const p of [
      { x: 5, y: 22 },
      { x: 15, y: 22 },
      { x: 10, y: 30 },
      { x: 5, y: 22 },
    ])
      await clickAt(admin, p.x, p.y);
    await expect.poll(async () => (await colourAt(anna, 10, 25)).sat).toBeGreaterThan(0.25);
    expect(isFog(await colourAt(bob, 10, 25))).toBe(true);
    // Reveal all (for everyone), then Hide all.
    await admin.getByTestId("fog-target").selectOption("all");
    await admin.getByRole("button", { name: "Reveal all" }).click();
    await expect.poll(() => token(bob, ghoul)).not.toBeNull();
    await expect.poll(async () => (await colourAt(bob, 10, 30)).sat).toBeGreaterThan(0.25);
    await admin.getByRole("button", { name: "Hide all" }).click();
    await expect.poll(() => token(bob, ghoul)).toBeNull();
    await expect.poll(async () => isFog(await colourAt(bob, 10, 30))).toBe(true);
  });
});
