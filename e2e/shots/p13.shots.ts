import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { freshShotsDir } from "../fixtures/shotsDir.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The key screens of phase 13 (SPEC §4 Screenshots): Admin → API & MCP with no token yet, making one, the token shown
 * once with Connect Claude filled in, and a revoke; Settings with the port, new-campaign defaults, auto-approved
 * images and Allow remote API.
 */
test("P13 key screens", async ({ admin }, info) => {
  test.setTimeout(600_000);
  const dir = join("artifacts", "screens", "p13", info.project.name);
  freshShotsDir(dir);
  const notes: string[] = [];
  const shot = async (page: Page, name: string) => {
    await page.bringToFront();
    await page.evaluate(() =>
      Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY))
            .map((a) => a.finished.catch(() => undefined)),
        ),
        new Promise((r) => setTimeout(r, 2000)),
      ]),
    );
    await page.screenshot({ path: join(dir, `${name}.png`) });
  };
  const step = async (name: string, fn: () => Promise<unknown>, capture = true) => {
    try {
      await fn();
      if (capture) await shot(admin, name);
    } catch (e) {
      const lines = (e as Error).message.split("\n");
      notes.push(`${name}: ${lines.slice(0, 3).join(" | ")}`);
      await admin.screenshot({ path: join(dir, `_failed-${name}.png`) }).catch(() => {});
    }
  };
  const nav = async (name: string) => {
    const link = admin
      .getByRole("navigation", { name: "Admin sections" })
      .getByRole("link", { name, exact: true });
    await link.scrollIntoViewIfNeeded();
    await link.click();
  };

  await admin.getByRole("button", { name: "Start with the demo" }).click();
  await expect(admin.getByText("The Lantern Crypt is ready")).toBeVisible({ timeout: 30_000 });
  await step("01-api-empty", async () => {
    await nav("API & MCP");
    await expect(admin.getByTestId("connect-claude")).toBeVisible();
  });
  await step("02-api-make-token", async () => {
    await admin.getByRole("button", { name: "Make a token" }).click();
    await expect(admin.getByRole("dialog", { name: "Make a token" })).toBeVisible();
  });
  await step("03-api-token-once", async () => {
    await admin.getByRole("dialog").getByRole("button", { name: "Make it" }).click();
    await expect(admin.getByTestId("fresh-token")).toBeVisible();
  });
  await step("04-api-connect-claude", async () => {
    await admin.getByTestId("connect-claude").scrollIntoViewIfNeeded();
  });
  await step("05-api-revoke", async () => {
    await admin.getByTestId("api-token-row").getByRole("button", { name: "Revoke" }).click();
    await expect(admin.getByRole("dialog")).toBeVisible();
  });
  await admin.keyboard.press("Escape");
  await step("06-settings", async () => {
    await nav("Settings");
    await expect(admin.getByLabel("Port")).toBeVisible();
  });
  await step("07-settings-lower", async () => {
    await admin.getByRole("switch", { name: "Allow remote API" }).scrollIntoViewIfNeeded();
  });
  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
