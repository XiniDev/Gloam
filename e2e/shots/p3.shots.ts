import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  assetFixtures,
  boardSettled,
  camera,
  createScene,
  hook,
  introDone,
  req,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

interface P {
  x: number;
  y: number;
}

async function screen(p: Page, x: number, y: number, elevation = 0.15) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, elevation)) as {
    sx: number;
    sy: number;
  };
  return { x: s.sx, y: s.sy };
}
async function moveTo(p: Page, x: number, y: number, elevation = 0) {
  const s = await screen(p, x, y, elevation);
  await p.mouse.move(s.x, s.y);
}
async function clickAt(p: Page, x: number, y: number) {
  await moveTo(p, x, y);
  await p.mouse.down();
  await p.mouse.up();
}

/**
 * The key screens of phase 3 (SPEC §4 Screenshots): walls in 3D (tabletop with the cutaway, top-down orthographic),
 * moving tokens (drag preview, what the DM watches, waypoints, the "unseen" bump), doors, measuring, elevation, pings,
 * the Walls and Zones tools and the hazard prompt. One run per viewport; a step that can't run at a viewport is noted
 * in _notes.txt.
 */
test("P3 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p3", info.project.name);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const phone = viewport.width < 640;
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(dir, `${name}.png`) });
  };
  /** On a phone the overview can't hold the room: look where the step happens. */
  const look = async (pages: Page[], x: number, y: number) => {
    if (!phone) return;
    for (const p of pages) await camera(p, { pitchDeg: 60, distance: 44, target: [x, y], ms: 0 });
    await pages[0]?.waitForTimeout(500);
  };
  const step = async (name: string, page: Page, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await shot(page, name);
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
      // What the screen showed when the step failed, for the notes.
      await page.screenshot({ path: join(dir, `_failed-${name}.png`) }).catch(() => {});
    }
  };

  const code = await adminAtTable(admin);
  await introDone(admin);
  await req(admin, "campaign.update", { name: "The Lantern Crypt" });
  const crypt = await createScene(admin, {
    name: "The Lantern Crypt",
    mapKind: "procedural",
    floorStyle: "stone",
    widthFt: 60,
    heightFt: 40,
  });
  await boardSettled(admin, crypt);
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport });
  const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
  await boardSettled(dave, crypt);
  const { portraitPng, statueGlb } = await assetFixtures();
  const art = await uploadVia(admin, await portraitPng("knight"), "Knight portrait.png", "token");
  const statue = await uploadVia(admin, await statueGlb(), "Stone guardian.glb", "mini");

  // A hall and a side chamber: stone walls, a door, a window, a curtain, a secret door and a hidden wall.
  const { wallIds } = await req<{ wallIds: string[] }>(admin, "wall.create", {
    sceneId: crypt,
    walls: [
      { a: { x: 8, y: 6 }, b: { x: 30, y: 6 }, kind: "wall" },
      { a: { x: 30, y: 6 }, b: { x: 34, y: 6 }, kind: "door" },
      { a: { x: 34, y: 6 }, b: { x: 52, y: 6 }, kind: "wall" },
      { a: { x: 52, y: 6 }, b: { x: 52, y: 20 }, kind: "window" },
      { a: { x: 52, y: 20 }, b: { x: 52, y: 34 }, kind: "wall" },
      { a: { x: 52, y: 34 }, b: { x: 8, y: 34 }, kind: "wall" },
      { a: { x: 8, y: 34 }, b: { x: 8, y: 22 }, kind: "wall" },
      { a: { x: 8, y: 22 }, b: { x: 8, y: 18 }, kind: "secret" },
      { a: { x: 8, y: 18 }, b: { x: 8, y: 6 }, kind: "wall" },
      { a: { x: 30, y: 6 }, b: { x: 30, y: 20 }, kind: "curtain" },
      { a: { x: 38, y: 20 }, b: { x: 38, y: 34 }, kind: "wall", hidden: true },
      { a: { x: 11, y: 20 }, b: { x: 21, y: 20 }, kind: "wall" },
      // An invisible wall in the open east side (its dotted pattern is reviewed in the DM's overlay).
      { a: { x: 44, y: 9 }, b: { x: 44, y: 16 }, kind: "invisible" },
    ],
  });
  const door = wallIds[1] as string;
  const tokens: [string, Record<string, unknown>][] = [
    [
      "Sir Aldric",
      {
        pos: { x: 16, y: 26 },
        disposition: "party",
        ownerIds: [daveId],
        appearance: { mode: "auto", assetId: art.id },
        stats: { hp: 24, hpMax: 31, ac: 18, speeds: { walk: 30, fly: 0 } },
      },
    ],
    ["Goblin Scout", { pos: { x: 24, y: 14 }, size: "small", stats: { hp: 4, hpMax: 9, ac: 13 } }],
    [
      "Stone Guardian",
      { pos: { x: 45, y: 27 }, size: "large", appearance: { mode: "model", assetId: statue.id } },
    ],
    [
      "Dave's Owl",
      {
        pos: { x: 25, y: 22 },
        size: "small",
        ownerIds: [daveId],
        disposition: "party",
        stats: { hp: 5, hpMax: 5, ac: 12, speeds: { walk: 5, fly: 60 } },
      },
    ],
  ];
  const ids: Record<string, string> = {};
  for (const [name, t] of tokens)
    ids[name] = (
      await req<{ tokenId: string }>(admin, "token.create", { sceneId: crypt, name, ...t })
    ).tokenId;
  // Zones: mud, a pool, a burning floor with a trigger, a named altar.
  await req(admin, "zone.create", {
    sceneId: crypt,
    kind: "difficult",
    label: "Mud",
    shape: { kind: "rect", x: 12, y: 8, w: 10, h: 8 },
  });
  await req(admin, "zone.create", {
    sceneId: crypt,
    kind: "water",
    shape: { kind: "circle", x: 44, y: 13, r: 4 },
  });
  const { zoneId: fire } = await req<{ zoneId: string }>(admin, "zone.create", {
    sceneId: crypt,
    kind: "hazard",
    label: "Burning floor",
    shape: {
      kind: "polygon",
      points: [
        { x: 30, y: 24 },
        { x: 37, y: 24 },
        { x: 34, y: 32 },
      ],
    },
    triggers: [
      {
        when: "enter",
        label: "Burning floor",
        save: { ability: "dex", dc: 12, onSuccess: "half" },
        damage: { formula: "1d4", type: "fire" },
      },
    ],
  });
  await req(admin, "zone.create", {
    sceneId: crypt,
    kind: "label",
    label: "Altar",
    shape: { kind: "rect", x: 40, y: 22, w: 10, h: 10 },
  });
  await expect.poll(() => hook(dave, "token", ids["Sir Aldric"] as string)).not.toBeNull();

  // Walls in 3D.
  await step("01-walls3d-tabletop", dave, async () => {
    await camera(dave, { pitchDeg: 48, distance: phone ? 70 : 58, target: [30, 20], ms: 0 });
    await dave.waitForTimeout(900);
  });
  await step("02-walls3d-top-orthographic", dave, async () => {
    await dave.keyboard.press("o");
    await expect.poll(async () => (await camera(dave)).ortho, { timeout: 5000 }).toBe(true);
    await dave.waitForTimeout(600);
  });
  await dave.keyboard.press("Shift+Digit2");
  await expect.poll(async () => (await camera(dave)).ortho).toBe(false);
  await step("01b-walls3d-door-open", dave, async () => {
    await req(admin, "door.toggle", { wallId: door, action: "open" });
    await camera(dave, { pitchDeg: 40, distance: phone ? 34 : 26, target: [32, 8], ms: 0 });
    await dave.waitForTimeout(900);
  });
  await req(admin, "door.toggle", { wallId: door, action: "close" });
  // The rest flat, from above-ish, walls as the DM's overlay.
  await req(admin, "scene.update", { sceneId: crypt, walls3d: false });
  for (const p of [dave, admin])
    await camera(p, { pitchDeg: 60, distance: phone ? 72 : 56, target: [30, 20], ms: 0 });
  await dave.waitForTimeout(600);

  // Moving: Dave drags Sir Aldric round the curtain wall; the DM watches the ghost.
  const aldric = ids["Sir Aldric"] as string;
  // A phone sees about 15 ft across at this distance: the moves there stay close to Sir Aldric.
  // (Clear of the free wall's end at (21, 20): a Medium creature keeps 2 ft from walls.)
  const dragTo = phone ? { x: 22, y: 23 } : { x: 40, y: 16 };
  await look([dave, admin], 18.5, 24);
  await step("03-move-drag-preview", dave, async () => {
    const a = await screen(dave, 16, 26);
    await dave.mouse.move(a.x, a.y);
    await dave.mouse.down();
    for (let i = 1; i <= 10; i++)
      await moveTo(dave, 16 + ((dragTo.x - 16) * i) / 10, 26 + ((dragTo.y - 26) * i) / 10);
    await expect(dave.getByTestId("move-label")).toBeVisible();
  });
  await step("04-move-seen-by-dm", admin, async () => {
    // A fresh preview (the DM's ghost fades 1.5 s after Dave's last one).
    await moveTo(dave, dragTo.x - 1, dragTo.y);
    await moveTo(dave, dragTo.x, dragTo.y);
    await expect.poll(async () => (await hook<unknown[]>(admin, "remoteMoves")).length).toBeGreaterThan(0);
  });
  await dave.keyboard.press("Escape");
  await dave.mouse.up();
  await step("05-click-to-move-waypoints", dave, async () => {
    await clickAt(dave, 16, 26);
    for (const w of phone
      ? [
          { x: 18, y: 29 },
          { x: 21, y: 29 },
        ]
      : [
          { x: 22, y: 30 },
          { x: 28, y: 30 },
        ]) {
      await moveTo(dave, w.x, w.y);
      await dave.keyboard.down("Control");
      await dave.mouse.down();
      await dave.mouse.up();
      await dave.keyboard.up("Control");
    }
    await moveTo(dave, phone ? 21 : 26, phone ? 22 : 22);
    await expect(dave.getByTestId("move-label")).toContainText("waypoints");
  });
  await dave.keyboard.press("Escape");
  await dave.keyboard.press("Escape");
  await dave.keyboard.press("Escape");

  await step("05b-move-around-wall-through-mud", dave, async () => {
    await look([dave], 16, 18);
    const a = await screen(dave, 16, 26);
    await dave.mouse.move(a.x, a.y);
    await dave.mouse.down();
    for (let i = 1; i <= 10; i++) await moveTo(dave, 16 + (1 * i) / 10, 26 - (15 * i) / 10);
    await expect(dave.getByTestId("move-label")).toContainText("difficult");
    // Round the free wall's end: straight through it would cost ~20 ft.
    await expect
      .poll(async () => (await hook<{ preview: { cost: number } | null }>(dave, "move")).preview?.cost ?? 0)
      .toBeGreaterThan(22);
  });
  await dave.keyboard.press("Escape");
  await dave.mouse.up();
  await step("05c-move-no-path", dave, async () => {
    await look([dave], 20, 32);
    const a = await screen(dave, 16, 26);
    await dave.mouse.move(a.x, a.y);
    await dave.mouse.down();
    for (let i = 1; i <= 8; i++) await moveTo(dave, 16 + (4 * i) / 8, 26 + (12 * i) / 8);
    await expect(dave.getByTestId("move-label")).toHaveText("No path");
  });
  await dave.keyboard.press("Escape");
  await dave.mouse.up();
  await step("05d-move-freehand", dave, async () => {
    await look([dave], 16, 22);
    const a = await screen(dave, 16, 26);
    await dave.mouse.move(a.x, a.y);
    await dave.mouse.down();
    await dave.keyboard.down("Alt");
    for (let i = 1; i <= 10; i++)
      await moveTo(dave, 16 + 2 * Math.sin((i / 10) * Math.PI), 26 - (9 * i) / 10);
    await expect(dave.getByTestId("move-label")).toBeVisible();
  });
  await dave.keyboard.press("Escape");
  await dave.mouse.up();
  await dave.keyboard.up("Alt");
  await camera(dave, { pitchDeg: 60, distance: phone ? 72 : 56, target: [30, 20], ms: 0 });

  // Doors: shut, open and locked, with their handles.
  await req(admin, "door.toggle", { wallId: door, action: "lock" });
  await step("06-door-handles", dave, async () => {
    await camera(dave, { pitchDeg: 62, distance: 30, target: [32, 10], ms: 0 });
    await dave.waitForTimeout(700);
  });
  await camera(dave, { pitchDeg: 60, distance: phone ? 72 : 56, target: [30, 20], ms: 0 });

  // Measuring.
  await look([dave, admin], 20, 25);
  await step("07-measure-ruler", dave, async () => {
    await dave.keyboard.press("m");
    await clickAt(dave, phone ? 16 : 14, 30);
    await clickAt(dave, phone ? 23 : 26, 30);
    await moveTo(dave, phone ? 23 : 26, phone ? 23 : 20);
    await expect(dave.getByTestId("measure-label")).toBeVisible();
  });
  await dave.keyboard.press("Escape");
  // The cone, shared: the DM's view first (it shows for 3 s), then Dave's (his stays until Esc).
  await step("09-measure-shared-dm", admin, async () => {
    await dave.getByRole("radio", { name: "Cone" }).click();
    const len = phone ? 8 : 15;
    await moveTo(dave, phone ? 17 : 20, 22);
    await dave.mouse.down();
    for (let i = 1; i <= 6; i++) await moveTo(dave, (phone ? 17 : 20) + (len * i) / 6, 22);
    await dave.mouse.up();
    await expect(admin.getByTestId("measure-shared-label")).toBeVisible();
  });
  await step("08-measure-cone", dave, async () => {
    await expect(dave.getByTestId("measure-label")).toBeVisible();
  });
  for (const [label, file, a, b] of [
    ["Radius", "08b-measure-radius", { x: 26, y: 24 }, { x: 26, y: 30 }],
    ["Line", "08c-measure-line", { x: 16, y: 28 }, { x: 28, y: 24 }],
    ["Cube", "08d-measure-cube", { x: 24, y: 24 }, { x: 30, y: 30 }],
  ] as const) {
    await step(file, dave, async () => {
      await dave.getByRole("radio", { name: label }).click();
      await moveTo(dave, a.x, a.y);
      await dave.mouse.down();
      for (let i = 1; i <= 6; i++)
        await moveTo(dave, a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6);
      await dave.mouse.up();
      await expect(dave.getByTestId("measure-label")).toBeVisible();
    });
    await dave.keyboard.press("Escape");
  }
  await dave.keyboard.press("Escape");
  await dave.keyboard.press("Escape");

  // Elevation: the owl takes off.
  const owl = ids["Dave's Owl"] as string;
  await look([dave], 25, 22);
  await step("10-elevation", dave, async () => {
    await clickAt(dave, 25, 22);
    await expect(dave.getByTestId("elevation-stepper")).toBeVisible();
    for (let i = 0; i < 3; i++) await dave.getByRole("button", { name: /Raise 5 ft/ }).click();
    await expect
      .poll(
        async () =>
          ((await hook<{ elevation: number }>(dave, "token", owl)) as { elevation: number }).elevation,
      )
      .toBe(15);
  });
  await dave.keyboard.press("Escape");

  // A ping (Alt+click) on the DM's screen.
  await look([dave, admin], 42, 15);
  await step("11-ping", admin, async () => {
    const at = await screen(dave, 44, 13, 0);
    await dave.keyboard.down("Alt");
    await dave.mouse.click(at.x, at.y);
    await dave.keyboard.up("Alt");
    await expect.poll(async () => (await hook<unknown[]>(admin, "pings")).length).toBeGreaterThan(0);
  });

  // The Walls tool: drawing a chain (snap ring, length pill), then a selection with its handles.
  await look([admin], 22, 12);
  await step("12-walls-tool-draw", admin, async () => {
    await admin.keyboard.press("w");
    await clickAt(admin, 14, 12);
    await clickAt(admin, 24, 12);
    await moveTo(admin, 29.5, 6.4); // near the door's end: the snap ring shows
    await expect(admin.getByTestId("wall-length")).toBeVisible();
  });
  await admin.keyboard.press("Escape");
  await look([admin], phone ? 27 : 32, phone ? 36 : 30);
  await step("13-walls-tool-select", admin, async () => {
    await admin.getByRole("radio", { name: "Select walls" }).click();
    await clickAt(admin, phone ? 27 : 20, 34);
    // (On a phone the second wall would sit under the dock's rail: one wall there.)
    if (!phone) {
      await admin.keyboard.down("Shift");
      await clickAt(admin, 38, 27);
      await admin.keyboard.up("Shift");
    }
    await expect(admin.getByTestId("walls-selected")).toHaveText(phone ? "1 wall" : "2 walls");
  });
  await admin.keyboard.press("Escape");
  await admin.keyboard.press("Escape");

  await step("13b-walls-room-tool", admin, async () => {
    await look([admin], 26, 28);
    await admin.keyboard.press("w");
    await admin.getByRole("radio", { name: "Room" }).click();
    await moveTo(admin, 23, 25);
    await admin.mouse.down();
    for (let i = 1; i <= 6; i++) await moveTo(admin, 23 + (7 * i) / 6, 25 + (5 * i) / 6);
    await expect(admin.getByTestId("room-size")).toBeVisible();
  });
  await admin.keyboard.press("Escape");
  await admin.mouse.up();
  await admin.keyboard.press("Escape");
  await admin.keyboard.press("Escape");

  // The Zones tool: the hazard's panel with its trigger.
  await step("14-zones-tool-editor", admin, async () => {
    await look([admin], 31, 27);
    await admin.keyboard.press("z");
    await clickAt(admin, 33.5, 27);
    await expect
      .poll(async () => (await hook<{ selected: string | null }>(admin, "zoneTool")).selected)
      .toBe(fire);
    await expect(admin.getByTestId("zone-trigger")).toHaveCount(1);
  });
  await admin.keyboard.press("Escape");
  await admin.keyboard.press("Escape");

  // The hazard in play and the "unseen" bump.
  await step("15-hazard-prompt-dm", admin, async () => {
    const t = (await hook<{ pos: P }>(dave, "token", aldric)) as { pos: P };
    await req(dave, "move.commit", { tokenId: aldric, points: [t.pos, { x: 33.5, y: 27 }] });
    await expect(admin.getByText(/Sir Aldric entered Burning floor/)).toBeVisible();
  });
  await step("16-unseen-bump", dave, async () => {
    const t = (await hook<{ pos: P }>(dave, "token", aldric)) as { pos: P };
    await req(dave, "move.commit", { tokenId: aldric, points: [t.pos, { x: 44, y: 28 }] });
    await expect(dave.getByText(/unseen/i)).toBeVisible();
  });

  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
