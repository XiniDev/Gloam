import { spawnServer } from "../fixtures/server.ts";
import { closeContexts, expect, knockAsNew, newPlayerContext, openTableAs, test } from "../fixtures/test.ts";

test.describe("P1 — the doorway and the Admin Table page (HOST)", () => {
  test("AC-HOST-03 / AC-HOST-05: quick tunnel shows Open with the trycloudflare address; Copy Discord message copies URL + code", async ({
    admin,
  }) => {
    const code = await openTableAs(admin, "Quick tunnel");
    await expect(
      admin.getByRole("link", { name: "https://calm-river-1234.trycloudflare.com" }),
    ).toBeVisible();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    await admin.getByRole("button", { name: "Copy Discord message" }).click();
    const clip = await admin.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(
      `🎲 The table is open! Join: https://calm-river-1234.trycloudflare.com — code ${code} (works until the table closes)`,
    );
    await expect(admin.getByText(/^\s*0\s+spectators$/)).toBeVisible();
    await expect(admin.getByText(/^\s*0\s+admitted$/)).toBeVisible();
  });

  test("AC-HOST-02: LAN needs explicit confirmation and shows a warning badge while active", async ({
    admin,
  }) => {
    await admin.getByLabel("Campaign name").fill("LAN night");
    await admin.getByRole("button", { name: "Create campaign" }).click();
    await admin.getByRole("radio", { name: "LAN" }).click();
    await admin.getByRole("button", { name: "Open table" }).click();
    await expect(admin.getByRole("dialog", { name: "Open the table on your network?" })).toBeVisible();
    await admin.getByRole("button", { name: "Cancel" }).click();
    await expect(admin.getByRole("heading", { name: "Closed", exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "Open table" }).click();
    await admin.getByRole("button", { name: "Open on the network" }).click();
    await expect(admin.getByText("LAN: anyone on your network can reach the join page")).toBeVisible();
    await admin.getByRole("button", { name: "Close table" }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "Close table" }).click();
    await expect(admin.getByText("LAN: anyone on your network can reach the join page")).toBeHidden();
  });

  test("AC-HOST-04: closing the table shows every player the closed screen", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await openTableAs(admin, "Quick tunnel");
    const pid = gloam.fakeCloudflaredLog()[0]?.pid ?? 0;
    const { page: player } = await newPlayerContext(browser, gloam.url, guardLog);
    await knockAsNew(player, gloam.url, code, "Dave");
    await admin.getByRole("button", { name: "Close table" }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "Close table" }).click();
    await expect(
      player.getByRole("heading", { name: "The table is closed — thanks for playing" }),
    ).toBeVisible();
    await expect(admin.getByRole("heading", { name: "Closed", exact: true })).toBeVisible();
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });

  test("AC-HOST-06: with cloudflared missing the Table page shows install steps + Re-check, and Local still works", async ({
    browser,
    guardLog,
  }) => {
    const gloam = await spawnServer({ cloudflared: "missing" });
    try {
      const { page } = await newPlayerContext(browser, gloam.url, guardLog);
      await page.goto(gloam.bootstrapLink);
      await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
      await page.getByLabel("Confirm password").fill("correct horse battery staple");
      await page.getByRole("button", { name: "Set password and continue" }).click();
      await page.getByLabel("Campaign name").fill("No doorway");
      await page.getByRole("button", { name: "Create campaign" }).click();
      await expect(
        page.getByRole("heading", { name: "Install cloudflared to open a doorway" }),
      ).toBeVisible();
      const expected =
        process.platform === "win32"
          ? "winget install --id Cloudflare.cloudflared"
          : process.platform === "darwin"
            ? "brew install cloudflared"
            : "sudo apt-get update && sudo apt-get install cloudflared";
      await expect(page.getByText(expected)).toBeVisible();
      await expect(page.getByRole("button", { name: "Re-check" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open table" })).toBeDisabled();
      await page.getByRole("button", { name: "Re-check" }).click();
      await expect(
        page.getByRole("heading", { name: "Install cloudflared to open a doorway" }),
      ).toBeVisible();
      await page.getByRole("radio", { name: "Local only" }).click();
      await expect(page.getByRole("heading", { name: "Install cloudflared to open a doorway" })).toBeHidden();
      await page.getByRole("button", { name: "Open table" }).click();
      await expect(page.getByRole("heading", { name: "Open", exact: true })).toBeVisible();
    } finally {
      await closeContexts(guardLog);
      guardLog.violations.push(...gloam.cspReports);
      await gloam.stop();
    }
  });

  test("AC-HOST-09: a crashed doorway shows 'Doorway reconnecting…' and highlights the changed address", async ({
    browser,
    guardLog,
  }) => {
    const gloam = await spawnServer({ env: { FAKE_CF_HOSTNAME_RANDOM: "1" } });
    try {
      const { page: admin } = await newPlayerContext(browser, gloam.url, guardLog);
      await admin.goto(gloam.bootstrapLink);
      await admin.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
      await admin.getByLabel("Confirm password").fill("correct horse battery staple");
      await admin.getByRole("button", { name: "Set password and continue" }).click();
      await openTableAs(admin, "Quick tunnel");
      const first = gloam.fakeCloudflaredLog()[0];
      process.kill(first?.pid ?? 0, "SIGKILL");
      await expect(admin.getByRole("heading", { name: "Doorway reconnecting…" })).toBeVisible({
        timeout: 8000,
      });
      await expect(admin.getByText("The address changed after a reconnect — share it again.")).toBeVisible({
        timeout: 15_000,
      });
      await admin.getByRole("button", { name: "Got it" }).click();
      await expect(admin.getByText("The address changed after a reconnect — share it again.")).toBeHidden();
    } finally {
      await closeContexts(guardLog);
      guardLog.violations.push(...gloam.cspReports);
      await gloam.stop();
    }
  });
});
