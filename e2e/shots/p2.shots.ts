import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  assetFixtures,
  boardSettled,
  camera,
  checkerPng,
  createScene,
  hook,
  introDone,
  req,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, knockAsNew, newPlayerContext, openTableAs, test } from "../fixtures/test.ts";

async function dmPanel(page: Page, tab: "Scenes" | "Library" | "Approvals"): Promise<void> {
  const tabs = page.getByRole("tablist", { name: "DM panel sections" });
  if (!(await tabs.isVisible())) await page.getByRole("button", { name: /^DM panel/ }).click();
  await page.getByRole("tab", { name: tab }).click();
}

/**
 * The key screens of phases 1–2, one run per viewport (SPEC §4 Screenshots). Steps that can't run at a viewport
 * (a control that lives elsewhere on a phone) are noted in _notes.txt instead of stopping the run.
 */
test("P2 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p2", info.project.name);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(dir, `${name}.png`) });
  };
  const step = async (name: string, page: Page, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await shot(page, name);
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
    }
  };

  // P1: the Admin console, the doorway, joining and the waiting room.
  await step("01-admin-first-campaign", admin, async () => {
    await expect(admin.getByText("Start your first campaign")).toBeVisible();
  });
  let code = "";
  await step("02-admin-table-open", admin, async () => {
    code = await openTableAs(admin, "Local only");
  });
  await step("03-admin-settings", admin, async () => {
    await admin.getByRole("link", { name: "Settings" }).click();
    await expect(admin.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  });
  await admin
    .getByRole("link", { name: "Table" })
    .click()
    .catch(() => {});
  const { page: dave } = await newPlayerContext(browser, gloam.url, guardLog, { viewport });
  await step("04-join-code", dave, async () => {
    await dave.goto(`${gloam.url}/join`);
    await expect(dave.getByLabel("Invite code character 1 of 10")).toBeVisible();
  });
  await step("05-waiting-room", dave, async () => {
    await knockAsNew(dave, gloam.url, code, "Dave");
    await dave.waitForTimeout(800);
  });
  await step("06-admin-knock-card", admin, async () => {
    await expect(admin.getByRole("alert").filter({ hasText: "Dave is knocking" })).toBeVisible();
  });
  await admin
    .getByRole("alert")
    .filter({ hasText: "Dave is knocking" })
    .getByRole("button", { name: "Admit" })
    .click();
  await step("07-table-empty-player", dave, async () => {
    await expect(dave).toHaveURL(/\/table$/);
    await introDone(dave);
  });

  // P2: the DM at the table.
  await admin.getByRole("button", { name: "Go to the table" }).click();
  await introDone(admin);
  const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
  const { image, glb } = await assetFixtures();
  const art = await uploadVia(admin, await image("png", 256, 256), "Knight portrait.png", "token");
  const statue = await uploadVia(admin, await glb(), "Stone guardian.glb", "mini");
  const crypt = await createScene(admin, {
    name: "The Lantern Crypt",
    mapKind: "procedural",
    floorStyle: "stone",
    widthFt: 60,
    heightFt: 40,
  });
  const tokens: [string, Record<string, unknown>][] = [
    [
      "Sir Aldric",
      {
        pos: { x: 14, y: 22 },
        disposition: "party",
        ownerIds: [daveId],
        appearance: { mode: "auto", assetId: art.id },
        stats: { hp: 24, hpMax: 31, ac: 18 },
      },
    ],
    [
      "Goblin Scout",
      { pos: { x: 30, y: 14 }, size: "small", hpDisplay: "bar", stats: { hp: 4, hpMax: 9, ac: 13 } },
    ],
    ["Goblin Boss", { pos: { x: 38, y: 18 }, hpDisplay: "descriptor", stats: { hp: 12, hpMax: 21, ac: 17 } }],
    [
      "Stone Guardian",
      {
        pos: { x: 46, y: 26 },
        size: "large",
        appearance: { mode: "model", assetId: statue.id },
        stats: { hp: 60, hpMax: 60, ac: 17 },
      },
    ],
    ["Innkeeper", { pos: { x: 22, y: 30 }, disposition: "friendly", stats: { hp: 8, hpMax: 8, ac: 10 } }],
    ["Lurking Shade", { pos: { x: 50, y: 10 }, hidden: true, stats: { hp: 16, hpMax: 16, ac: 12 } }],
  ];
  for (const [name, t] of tokens) await req(admin, "token.create", { sceneId: crypt, name, ...t });
  await boardSettled(admin, crypt);
  await step("08-table-dm", admin, () => admin.waitForTimeout(1200));
  await step("09-table-player", dave, async () => {
    await boardSettled(dave, crypt);
    await dave.waitForTimeout(1200);
  });
  await step("10-table-dm-top-down", admin, async () => {
    await admin.keyboard.press("Shift+Digit1");
    await admin.waitForTimeout(900);
  });
  await admin.keyboard.press("Shift+Digit2");

  // The dock.
  await step("11-dm-scenes", admin, async () => {
    await dmPanel(admin, "Scenes");
  });
  await step("12-dm-library", admin, async () => {
    await dmPanel(admin, "Library");
    await expect(admin.getByText("Knight portrait")).toBeVisible();
  });
  await uploadVia(dave, await image("png", 200, 200), "Dave's familiar.png", "token").catch((e) =>
    notes.push(`upload: ${e}`),
  );
  await step("13-dm-approvals", admin, async () => {
    await dmPanel(admin, "Approvals");
    await expect(admin.getByText("Dave's familiar")).toBeVisible();
  });
  await step("14-party", admin, async () => {
    await admin.getByRole("button", { name: "Party" }).click();
  });
  await admin
    .getByRole("button", { name: "Party" })
    .click()
    .catch(() => {});

  // Dialogs and popovers.
  await step("15-wizard-source", admin, async () => {
    await dmPanel(admin, "Scenes");
    await admin.getByRole("button", { name: "New scene" }).first().click();
    await expect(admin.getByRole("dialog", { name: "New scene" })).toBeVisible();
  });
  await step("16-wizard-calibrate", admin, async () => {
    await admin.getByRole("button", { name: /Upload a map image/ }).click();
    await admin
      .getByRole("dialog", { name: "Upload a map image" })
      .locator('input[type="file"]')
      .setInputFiles({
        name: "Ruined chapel.png",
        mimeType: "image/png",
        buffer: await checkerPng(1400, 20),
      });
    await expect(admin.getByRole("dialog", { name: "Calibrate the map" })).toBeVisible({ timeout: 60_000 });
  });
  await admin.keyboard.press("Escape");
  await step("17-quick-unit", admin, async () => {
    await admin.getByRole("button", { name: "Quick unit" }).click();
    await expect(admin.getByRole("dialog", { name: "Quick unit" })).toBeVisible();
  });
  await admin.keyboard.press("Escape");
  await step("18-settings", admin, async () => {
    await admin.getByRole("button", { name: "Settings" }).click();
    await expect(admin.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });
  await admin.keyboard.press("Escape");
  await step("19-radial", admin, async () => {
    const ids = await hook<string[]>(admin, "visibleTokenIds");
    for (const id of ids) {
      const t = (await hook<{ name: string; pos: { x: number; y: number } }>(admin, "token", id)) as {
        name: string;
        pos: { x: number; y: number };
      };
      if (t.name !== "Goblin Boss") continue;
      const s = await hook<{ sx: number; sy: number }>(admin, "project", t.pos.x, t.pos.y, 0.15);
      await admin.mouse.click(s.sx, s.sy, { button: "right" });
    }
    await expect(admin.getByRole("menuitem", { name: "Elevation" })).toBeVisible();
  });
  await admin.keyboard.press("Escape");

  // Prep view and the 3D map tools.
  const vault = await createScene(
    admin,
    {
      name: "The Sunken Vault",
      mapKind: "model",
      mapAssetId: (await uploadVia(admin, await glb({ boxes: 6 }), "Vault.glb", "map")).id,
    },
    false,
  );
  await step("20-prep-view", admin, async () => {
    await dmPanel(admin, "Scenes");
    await admin
      .locator('[data-scene="The Sunken Vault"]')
      .getByRole("button", { name: /Open \(only DMs\)/ })
      .click();
    await expect(admin.getByTestId("prep-banner")).toBeVisible();
    await boardSettled(admin, vault);
  });
  await step("21-map-tools", admin, async () => {
    await admin
      .locator('[data-scene="The Sunken Vault"]')
      .getByRole("button", { name: /More for|More/ })
      .first()
      .click();
    await admin.getByRole("menuitem", { name: "Align 3D map" }).click();
    await expect(admin.getByTestId("map-tools")).toBeVisible();
    await camera(admin, { pitchDeg: 55, distance: 60, ms: 0 });
  });

  // Closing the table.
  await step("22-closed-player", dave, async () => {
    await admin.goto(`${gloam.url}/admin`);
    await admin.getByRole("button", { name: "Close table" }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "Close table" }).click();
    await expect(dave).toHaveURL(/\/closed$/, { timeout: 15_000 });
  });

  writeFileSync(join(dir, "_notes.txt"), notes.length ? `${notes.join("\n")}\n` : "all steps captured\n");
});

test("P2 first-run setup", async ({ gloam, browser, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p2", info.project.name);
  mkdirSync(dir, { recursive: true });
  const viewport = info.project.use.viewport as { width: number; height: number };
  const { page } = await newPlayerContext(browser, gloam.url, guardLog, { viewport });
  await page.goto(gloam.bootstrapLink);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, "00-setup.png") });
});
