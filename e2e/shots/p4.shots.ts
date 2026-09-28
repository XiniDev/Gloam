import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
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

/**
 * The key screens of phase 4 (SPEC §4 Screenshots, §8.8, §15.7): a dark crypt in dynamic fog — darkvision in grey,
 * a torch's bright and dim light blocked by walls, explored memory, the war fog; the DM's hatched view.
 */
test("P4 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p4", info.project.name);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const phone = viewport.width < 640;
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(dir, `${name}.png`) });
  };
  const step = async (name: string, page: Page, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await shot(page, name);
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: join(dir, `_failed-${name}.png`) }).catch(() => {});
    }
  };
  const view = async (pages: Page[], x: number, y: number, far: number, near: number, pitch = 58) => {
    for (const p of pages)
      await camera(p, { pitchDeg: pitch, distance: phone ? near : far, target: [x, y], ms: 0 });
    await pages[0]?.waitForTimeout(300);
  };

  const code = await adminAtTable(admin);
  await introDone(admin);
  await req(admin, "campaign.update", { name: "The Lantern Crypt" });
  const crypt = await createScene(admin, {
    name: "Lower crypt",
    mapKind: "procedural",
    floorStyle: "stone",
    widthFt: 60,
    heightFt: 40,
  });
  await req(admin, "scene.update", { sceneId: crypt, fogMode: "dynamic", ambientLevel: "dark" });
  // A hall (8..30 × 6..34) with a door east into a corridor and a side chamber; pillars.
  const { wallIds } = await req<{ wallIds: string[] }>(admin, "wall.create", {
    sceneId: crypt,
    walls: [
      { a: { x: 8, y: 6 }, b: { x: 30, y: 6 }, kind: "wall" },
      { a: { x: 30, y: 6 }, b: { x: 30, y: 17 }, kind: "wall" },
      { a: { x: 30, y: 17 }, b: { x: 30, y: 23 }, kind: "door" },
      { a: { x: 30, y: 23 }, b: { x: 30, y: 34 }, kind: "wall" },
      { a: { x: 30, y: 34 }, b: { x: 8, y: 34 }, kind: "wall" },
      { a: { x: 8, y: 34 }, b: { x: 8, y: 6 }, kind: "wall" },
      { a: { x: 30, y: 6 }, b: { x: 52, y: 6 }, kind: "wall" },
      { a: { x: 52, y: 6 }, b: { x: 52, y: 34 }, kind: "wall" },
      { a: { x: 52, y: 34 }, b: { x: 30, y: 34 }, kind: "wall" },
      { a: { x: 30, y: 26 }, b: { x: 44, y: 26 }, kind: "wall" },
      // Pillars.
      { a: { x: 15, y: 13 }, b: { x: 17, y: 13 }, kind: "wall" },
      { a: { x: 17, y: 13 }, b: { x: 17, y: 15 }, kind: "wall" },
      { a: { x: 17, y: 15 }, b: { x: 15, y: 15 }, kind: "wall" },
      { a: { x: 15, y: 15 }, b: { x: 15, y: 13 }, kind: "wall" },
      { a: { x: 21, y: 24 }, b: { x: 23, y: 24 }, kind: "wall" },
      { a: { x: 23, y: 24 }, b: { x: 23, y: 26 }, kind: "wall" },
      { a: { x: 23, y: 26 }, b: { x: 21, y: 26 }, kind: "wall" },
      { a: { x: 21, y: 26 }, b: { x: 21, y: 24 }, kind: "wall" },
    ],
  });
  const door = wallIds[2] as string;
  await req(admin, "scene.activate", { sceneId: crypt });
  await boardSettled(admin, crypt);
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport });
  const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
  await boardSettled(dave, crypt);
  const mk = async (name: string, body: Record<string, unknown>) =>
    (await req<{ tokenId: string }>(admin, "token.create", { sceneId: crypt, name, ...body })).tokenId;
  const elf = await mk("Nyx", {
    pos: { x: 12, y: 20 },
    disposition: "party",
    ownerIds: [daveId],
    stats: { hp: 18, hpMax: 22, ac: 14, senses: { darkvision: 60 } },
  });
  await mk("Goblin Scout", { pos: { x: 24, y: 12 }, size: "small", stats: { hp: 7, hpMax: 7, ac: 13 } });
  await mk("Goblin Archer", { pos: { x: 40, y: 20 }, size: "small", stats: { hp: 7, hpMax: 7, ac: 13 } });
  await expect.poll(() => hook(dave, "token", elf)).not.toBeNull();

  // Darkvision in the dark: grey within 60 ft, war fog beyond the walls.
  await view([dave], 22, 20, 60, 40);
  await step("01-darkvision-in-the-dark", dave, async () => {
    await expect.poll(async () => (await hook<{ mode: string }>(dave, "fog"))?.mode).toBe("dynamic");
    await dave.waitForTimeout(800);
  });

  // A torch: Nyx lights one — 20 ft bright, 20 ft dim, stopped by the walls.
  await step("02-torch-light", dave, async () => {
    await req(dave, "light.carry", { tokenId: elf, preset: "torch" });
    await dave.waitForTimeout(900);
  });

  // Through the door: the corridor, then back — the hall behind stays as explored memory.
  await step("03-explored-memory", dave, async () => {
    await req(admin, "door.toggle", { wallId: door, action: "open" });
    await req(dave, "move.commit", {
      tokenId: elf,
      points: [
        { x: 12, y: 20 },
        { x: 27, y: 20 },
        { x: 36, y: 20 },
      ],
    });
    await dave.waitForTimeout(2600);
    await view([dave], 32, 20, 60, 40);
  });

  // The DM: everything, with the players' fog hatched.
  await view([admin], 30, 20, 64, 44);
  await step("04-dm-hatched-fog", admin, async () => {
    await admin.waitForTimeout(600);
  });

  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
