import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The key screens of phase 5 (SPEC §4 Screenshots, §8.9, §18.4): the dice tray with a formula and its inline error;
 * dice tumbling over the board and at rest on the server's numbers; the roll feed with a masked card and a roll by
 * hand; the dice-skin picker; another player's dice in their skin; the tray and dice on a phone.
 */
test("P5 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p5", info.project.name);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const shot = async (page: Page, name: string) => {
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
  type Throw = { id: string; settled: boolean };
  const settled = (p: Page, id: string) =>
    expect
      .poll(async () => (await hook<Throw[]>(p, "diceThrows")).find((t) => t.id === id)?.settled, {
        timeout: 20_000,
        intervals: [100],
      })
      .toBe(true);
  const latest = async (p: Page) => ((await hook<{ id: string }[]>(p, "rollFeed"))[0] as { id: string }).id;

  const code = await adminAtTable(admin);
  await introDone(admin);
  await req(admin, "campaign.update", { name: "The Lantern Crypt" });
  const sceneId = await createScene(admin, {
    name: "Guard room",
    mapKind: "procedural",
    floorStyle: "stone",
    widthFt: 40,
    heightFt: 30,
  });
  await boardSettled(admin, sceneId);
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport });
  await boardSettled(dave, sceneId);

  // The tray, a formula typed, and one with its error shown where it is.
  await step("01-tray", dave, async () => {
    await dave.getByTestId("dice-button").click();
    await expect(dave.getByTestId("dice-tray")).toBeVisible();
    await dave.getByTestId("dice-formula").fill("1d20 + @dex [piercing] adv");
    await dave.getByLabel("Label").fill("Shortbow");
  });
  await step("02-tray-error", dave, async () => {
    await dave.getByTestId("dice-formula").fill("2d20 ++ 3");
    await expect(dave.getByTestId("dice-formula-error")).toBeVisible();
  });

  // Dice over the board: tumbling, then at rest on the server's numbers, the card's total in.
  // (Held at rest while they're photographed: a screenshot under software GL outlasts the 2.5-s rest.)
  for (const p of [dave, admin]) await hook(p, "diceHold", 60_000);
  await dave.getByTestId("dice-formula").fill("1d20 + 1d12 + 1d10 + 1d8 + 2d6 + 1d4");
  await dave.getByTestId("dice-formula").press("Enter");
  await dave.keyboard.press("Escape");
  await step("03-dice-tumbling", dave, async () => {
    await dave.waitForTimeout(250);
  });
  await step("04-dice-at-rest", dave, async () => {
    await settled(dave, await latest(dave));
  });

  // Dave's own dice: Settings → Your dice.
  await step("05-dice-skin", dave, async () => {
    await dave.getByRole("button", { name: "Settings" }).click();
    const picker = dave.getByTestId("dice-skin");
    await picker.getByRole("radio", { name: "Oxblood" }).click();
    await picker.getByRole("radio", { name: "Metal" }).click();
    await picker.getByRole("radio", { name: "Gold" }).click();
  });
  await dave.keyboard.press("Escape");

  // The DM watches Dave's roll in his dice, thrown from the far edge.
  await req(dave, "dice.roll", { formula: "3d6", label: "Stealth" });
  await step("06-others-dice-in-their-skin", admin, async () => {
    await settled(admin, await latest(admin));
  });

  // The feed: a private roll the DM sees and a player's masked card, and a roll entered by hand.
  await req(dave, "dice.roll", { formula: "1d20+5", label: "Insight", visibility: "dm" });
  await req(admin, "dice.manual", { formula: "2d8", values: [5, 7], label: "Table roll" });
  await req(admin, "dice.roll", { formula: "1d20", label: "Ambush", visibility: "dm" });
  await step("07-feed-dm", admin, async () => {
    await admin.waitForTimeout(3600);
    await admin.getByTestId("roll-feed").getByRole("button", { name: /Rolls/ }).click();
  });
  await step("08-feed-player", dave, async () => {
    await dave.waitForTimeout(600);
    await dave.getByTestId("roll-feed").getByRole("button", { name: /Rolls/ }).click();
  });

  for (const p of [dave, admin]) await hook(p, "diceHold", null);
  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
