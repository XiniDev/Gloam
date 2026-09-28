import type { Locator, Page } from "@playwright/test";
import { adminAtTable, boardSettled, camera, createScene, hook, introDone, req } from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The table's HUD on a phone (SPEC §29.4, §28 touch targets): no side rail — the tools fold into one button in the
 * top-left corner; a tool's options open as a bottom sheet with a Close, and the corner button steps aside for it;
 * every control in a sheet is at least 44 × 44 px; nothing in the HUD overlaps; the token menu stays in the part of
 * the screen the HUD leaves clear.
 */
const PHONE = { width: 390, height: 844 };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 &&
  a.x + a.width > b.x + 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  a.y + a.height > b.y + 0.5;
const boxOf = async (l: Locator): Promise<Box> => {
  const b = await l.boundingBox();
  expect(b, "on screen").not.toBeNull();
  return b as Box;
};

/** Every control in a sheet: its box (a native control's own box — what a finger has to hit). */
async function controls(sheet: Locator): Promise<{ name: string; box: Box }[]> {
  const els = sheet.locator("button, select, input, [role=radio], [role=switch]");
  const out: { name: string; box: Box }[] = [];
  for (let i = 0; i < (await els.count()); i++) {
    const el = els.nth(i);
    if (!(await el.isVisible())) continue;
    const name =
      (await el.getAttribute("aria-label")) ??
      (await el.textContent())?.trim() ??
      (await el.evaluate((e) => e.tagName));
    out.push({ name, box: await boxOf(el) });
  }
  return out;
}

async function pickTool(page: Page, label: string) {
  await page.getByRole("button", { name: /^Tools: / }).click();
  await page
    .getByRole("navigation", { name: "Board tools" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

test.describe("P4 — the HUD on a phone", () => {
  test.use({ viewport: PHONE });

  test("the tools fold into a corner button; sheets have a Close and 44-px controls; the HUD never overlaps itself or the token menu", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Phone",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 60,
    });
    await boardSettled(admin, sceneId);

    // The corner button: the tool in hand, below the top bar, clear of the dock's rail; no rail down the side.
    const header = admin.locator("header").first();
    const tools = admin.getByRole("button", { name: "Tools: Select" });
    await expect(tools).toBeVisible();
    const rail = admin.getByRole("navigation", { name: "Panels" });
    const toolsNav = admin.getByRole("navigation", { name: "Board tools" });
    const cornerBox = await boxOf(toolsNav);
    expect(cornerBox.x).toBeLessThan(24);
    expect(cornerBox.height).toBeLessThan(80);
    expect(overlaps(cornerBox, await boxOf(header))).toBe(false);
    expect(overlaps(cornerBox, await boxOf(rail))).toBe(false);
    const tb = await boxOf(tools);
    expect(Math.min(tb.width, tb.height)).toBeGreaterThanOrEqual(44);

    // Opened, it lists every tool; picking one folds it away; pressing elsewhere folds it too.
    await tools.click();
    for (const t of ["Select", "Measure", "Walls", "Zones", "Lights", "Fog", "Quick unit"])
      await expect(toolsNav.getByRole("button", { name: t, exact: true })).toBeVisible();
    await admin.mouse.click(PHONE.width / 2, PHONE.height / 2);
    await expect(toolsNav.getByRole("button", { name: "Fog", exact: true })).toBeHidden();

    // Each tool's sheet: along the bottom edge, full width, headed by a Close; the corner is left clear; every
    // control at least 44 × 44.
    for (const [label, testId] of [
      ["Measure", "measure-panel"],
      ["Walls", "walls-panel"],
      ["Zones", "zones-panel"],
      ["Lights", "lights-panel"],
      ["Fog", "fog-panel"],
    ] as const) {
      await pickTool(admin, label);
      const sheet = admin.getByTestId(testId);
      await expect(sheet).toBeVisible();
      await expect(toolsNav).toBeHidden();
      // A bottom sheet (§28): it opens at 30 % — the board stays in view above it — and its handle steps it to 60 and
      // 95 % and back.
      await expect(sheet).toHaveAttribute("data-snap", "0.3");
      await expect.poll(async () => (await boxOf(sheet)).y).toBeGreaterThan(PHONE.height * 0.65);
      const handle = sheet.getByRole("button", { name: /^Resize / });
      const hb = await boxOf(handle);
      expect(hb.height).toBeGreaterThanOrEqual(43.5);
      await handle.focus();
      await admin.keyboard.press("ArrowUp");
      await expect(sheet).toHaveAttribute("data-snap", "0.6");
      await admin.keyboard.press("ArrowUp");
      await expect(sheet).toHaveAttribute("data-snap", "0.95");
      await admin.keyboard.press("ArrowDown");
      await admin.keyboard.press("ArrowDown");
      await expect(sheet).toHaveAttribute("data-snap", "0.3");
      // Dragged up 200 px it settles at the next height, not wherever it was let go.
      await expect
        .poll(async () => Math.round((await boxOf(sheet)).height))
        .toBe(Math.round(0.3 * PHONE.height));
      await admin.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await admin.mouse.down();
      await admin.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 200, { steps: 5 });
      await admin.mouse.up();
      await expect(sheet).toHaveAttribute("data-snap", /^0\.(6|95)$/);
      await expect
        .poll(async () => Math.round((await boxOf(sheet)).height))
        .toBe(Math.round(Number(await sheet.getAttribute("data-snap")) * PHONE.height));
      await handle.focus();
      await admin.keyboard.press("ArrowDown");
      await admin.keyboard.press("ArrowDown");
      await expect(sheet).toHaveAttribute("data-snap", "0.3");
      // (Its height eases to the new snap.)
      await expect
        .poll(async () => Math.round((await boxOf(sheet)).height))
        .toBe(Math.round(0.3 * PHONE.height));
      const sb = await boxOf(sheet);
      expect(sb.x).toBeGreaterThanOrEqual(0);
      expect(sb.x + sb.width).toBeLessThanOrEqual(PHONE.width);
      expect(sb.y + sb.height).toBeLessThanOrEqual(PHONE.height);
      expect(overlaps(sb, await boxOf(rail)), `${label} sheet clear of the dock's rail`).toBe(false);
      expect(overlaps(sb, await boxOf(header)), `${label} sheet clear of the top bar`).toBe(false);
      const small = (await controls(sheet)).filter((c) => c.box.height < 43.5 || c.box.width < 43.5);
      expect(small, `${label}: controls under 44 px`).toEqual([]);
      await sheet.getByRole("button", { name: `Close ${label.toLowerCase()}` }).click();
      await expect(sheet).toBeHidden();
      await expect(admin.getByRole("button", { name: "Tools: Select" })).toBeVisible();
    }

    // The token menu near the screen's edge: shifted inward, inside the part of the screen the HUD leaves clear.
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Edge",
      pos: { x: 2.5, y: 8 },
    });
    await expect.poll(() => hook(admin, "token", tokenId)).not.toBeNull();
    await camera(admin, { pitchDeg: 60, frame: { minX: 0, minY: 0, maxX: 40, maxY: 60 } });
    await admin.waitForTimeout(300);
    const s = (await hook<{ sx: number; sy: number }>(admin, "project", 2.5, 8, 0.15)) as {
      sx: number;
      sy: number;
    };
    await admin.mouse.click(s.sx, s.sy, { button: "right" });
    const menu = admin.getByRole("menu", { name: "Actions for Edge" });
    // (The menu itself is a 0 × 0 anchor its items hang from.)
    await expect(menu.getByRole("menuitem").first()).toBeVisible();
    await admin.waitForTimeout(400); // the ring's spring settles
    const hud = [await boxOf(header), await boxOf(rail), await boxOf(toolsNav)];
    const bar = admin.getByTestId("action-bar");
    if (await bar.isVisible()) hud.push(await boxOf(bar));
    const items = menu.getByRole("menuitem");
    expect(await items.count()).toBeGreaterThan(2);
    for (let i = 0; i < (await items.count()); i++) {
      const b = await boxOf(items.nth(i));
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
      for (const h of hud) expect(overlaps(b, h), `menu item ${i} clear of the HUD`).toBe(false);
    }
  });
});
