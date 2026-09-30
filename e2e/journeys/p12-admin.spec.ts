import type { Page } from "@playwright/test";
import { expect, knockAsNew, newPlayerContext, test } from "../fixtures/test.ts";

const SHOTS = "artifacts/screens/p12";
const SRD =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';

const nav = (p: Page, name: string) =>
  p.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name, exact: true }).click();

/**
 * The Admin console (SPEC §8.20): the first-run checklist ticking off and going (AC-ADM-06); every section there and
 * working (AC-ADM-01): People — rename, PIN, a DM made, ban and unban, delete (AC-ADM-02); Campaigns — make, rename,
 * archive, bring back, delete by name; Assets; Content — a campaign's packs; the Security log (AC-ADM-04's page);
 * About & Credits with the SRD attribution word for word and the licences (AC-ADM-05).
 */
test.describe("P12 — the Admin console (ADM)", () => {
  test("AC-ADM-01 / AC-ADM-02 / AC-ADM-05 / AC-ADM-06: the checklist, People, Campaigns, Assets, Content, Security log, About", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(300_000);
    // ── The first-run checklist: two of five on a fresh install (the password, cloudflared found) ──
    const checklist = admin.getByTestId("first-run-checklist");
    await expect(checklist).toBeVisible();
    await expect(checklist.locator('[data-step="password"]')).toHaveAttribute("data-done", "1");
    await expect(checklist.locator('[data-step="campaign"]')).toHaveAttribute("data-done", "0");
    await admin.screenshot({ path: `${SHOTS}/admin-checklist.png` });
    // The demo: a campaign and a map at once.
    await admin.getByRole("button", { name: "Start with the demo" }).click();
    await expect(admin.getByText("The Lantern Crypt is ready")).toBeVisible({ timeout: 30_000 });
    await expect(checklist.locator('[data-step="campaign"]')).toHaveAttribute("data-done", "1");
    await expect(checklist.locator('[data-step="map"]')).toHaveAttribute("data-done", "1");
    // Opening the table is the last step: the checklist goes.
    await admin.getByRole("radio", { name: "Local only" }).click();
    await admin.getByRole("button", { name: "Open table" }).click();
    await expect(admin.getByRole("heading", { name: "Open", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(checklist).toBeHidden();
    const code = (await admin.locator(".mono.select-all").first().innerText()).trim();

    // A player at the door, let in from the console.
    const { page: dave } = await newPlayerContext(browser, gloam.url, guardLog);
    await knockAsNew(dave, gloam.url, code, "Dave");
    await admin.getByRole("button", { name: "Admit" }).first().click();
    await expect(dave).toHaveURL(/\/wait|\/table/);

    // ── People: rename, a PIN, made a DM, banned and unbanned, deleted ──
    await nav(admin, "People");
    const row = admin.getByTestId("person-row").filter({ hasText: "Dave" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Rename" }).click();
    await admin.getByLabel("Name at the table").fill("Davey");
    await admin.getByRole("button", { name: "Rename", exact: true }).last().click();
    const davey = admin.getByTestId("person-row").filter({ hasText: "Davey" });
    await expect(davey).toBeVisible();
    await davey.getByRole("button", { name: "PIN" }).click();
    await admin.getByRole("textbox", { name: "PIN", exact: true }).fill("4821");
    await admin.getByRole("button", { name: "Set PIN" }).click();
    await expect(davey).toContainText("PIN set");
    await davey.getByRole("button", { name: "Role" }).click();
    await admin.getByRole("combobox", { name: "Role", exact: true }).selectOption("dm");
    await admin.getByRole("button", { name: "Save" }).click();
    await expect(davey).toContainText("DM");
    await admin.screenshot({ path: `${SHOTS}/admin-people.png` });
    await davey.getByRole("button", { name: "Ban" }).click();
    await admin.getByRole("button", { name: "Ban", exact: true }).last().click();
    await expect(davey).toContainText("Banned");
    await davey.getByRole("button", { name: "Unban" }).click();
    await expect(davey).not.toContainText("Banned");
    await davey.getByRole("button", { name: "Delete" }).click();
    await admin.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(admin.getByTestId("person-row").filter({ hasText: "Davey" })).toHaveCount(0);

    // ── Campaigns: make, rename, archive, bring back, delete by name ──
    await nav(admin, "Campaigns");
    await admin.getByLabel("A new campaign").fill("The Sunless Road");
    await admin.getByRole("button", { name: "Make it" }).click();
    const road = admin.getByTestId("campaign-row").filter({ hasText: "The Sunless Road" });
    await expect(road).toBeVisible();
    await road.getByRole("button", { name: "Rename" }).click();
    await admin.getByLabel("Name", { exact: true }).fill("The Drowned Road");
    await admin.getByRole("button", { name: "Rename", exact: true }).last().click();
    const drowned = admin.getByTestId("campaign-row").filter({ hasText: "The Drowned Road" });
    await drowned.getByRole("button", { name: "Archive" }).click();
    await expect(admin.getByRole("region", { name: "Archived" }).getByText("The Drowned Road")).toBeVisible();
    await admin.getByRole("region", { name: "Archived" }).getByRole("button", { name: "Bring back" }).click();
    await expect(admin.getByRole("region", { name: "Archived" })).toHaveCount(0);
    await admin.screenshot({ path: `${SHOTS}/admin-campaigns.png` });
    await drowned.getByRole("button", { name: "Delete" }).click();
    const del = admin.getByRole("button", { name: "Delete for good" });
    await expect(del).toBeDisabled();
    await admin.getByLabel('Type "The Drowned Road" to delete it').fill("The Drowned Road");
    await del.click();
    await expect(admin.getByTestId("campaign-row").filter({ hasText: "The Drowned Road" })).toHaveCount(0);

    // ── Assets: the demo's two pictures; a clean-up ──
    await nav(admin, "Assets");
    await expect(admin.getByTestId("asset-campaign").filter({ hasText: "The Lantern Crypt" })).toContainText(
      "2 uploads",
    );
    await admin.getByRole("button", { name: "Clean up unused files" }).click();
    await expect(admin.getByText(/Nothing to clean up|Cleaned up/)).toBeVisible();

    // ── Content: the SRD pack per campaign ──
    await nav(admin, "Content");
    const crypt = admin.getByTestId("pack-campaign").filter({ hasText: "The Lantern Crypt" });
    const sw = crypt.getByRole("switch");
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");

    // ── Security log: what happened, with times and IPs, filtered ──
    await nav(admin, "Security log");
    const log = admin.getByTestId("security-row");
    await expect(log.first()).toBeVisible();
    await expect(admin.getByTestId("security-row").filter({ hasText: "Knocked" }).first()).toBeVisible();
    await expect(admin.getByTestId("security-row").filter({ hasText: "Banned" }).first()).toBeVisible();
    await admin.getByLabel("Show").selectOption("knock");
    await expect.poll(async () => (await log.allInnerTexts()).every((t) => t.includes("Knocked"))).toBe(true);
    await admin.screenshot({ path: `${SHOTS}/admin-security.png` });

    // ── About & Credits ──
    await nav(admin, "About");
    await expect(admin.getByTestId("srd-attribution")).toHaveText(SRD);
    await expect(admin.getByTestId("font-licence")).toHaveCount(4);
    await expect(admin.getByTestId("library-licences")).toContainText("three");
    await admin.screenshot({ path: `${SHOTS}/admin-about.png` });
  });
});
