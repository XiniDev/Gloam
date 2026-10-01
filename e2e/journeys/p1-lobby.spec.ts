import { dmSection, hook } from "../fixtures/board.ts";
import {
  expect,
  knockAsNew,
  newPlayerContext,
  openTableAs,
  test,
  watchForHeading,
} from "../fixtures/test.ts";

test.describe("P1 — joining, the waiting room and admission (AUTH)", () => {
  test("AC-AUTH-02 / AC-AUTH-03: knock → knock card with sound → admit → table without a reload (≤ 1 s)", {
    tag: "@timing",
  }, async ({ admin, browser, gloam, guardLog }) => {
    const code = await openTableAs(admin, "Local only");
    const { page: dave } = await newPlayerContext(browser, gloam.url, guardLog);
    const toWaitingRoom = await knockAsNew(dave, gloam.url, code, "Dave");
    test
      .info()
      .annotations.push({ type: "latency", description: `identity → waiting room ${toWaitingRoom} ms` });
    expect(toWaitingRoom).toBeLessThanOrEqual(1000);
    // Knock card: a toast with Admit, and the knock sound actually sounding on the Admin's page.
    const card = admin.getByRole("alert").filter({ hasText: "Dave is knocking" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("new");
    await expect
      .poll(() => admin.evaluate(() => window.__gloam?.sounds.filter((s) => s.name === "knock" && s.played)))
      .toHaveLength(1);
    await expect(admin.getByText("waiting 0:0")).toBeVisible();
    // The waiting room shows only the player's own state.
    await expect(dave.getByText(/Dave · amber · new/i)).toBeVisible();
    // Admit: the player moves to the table without a reload.
    await dave.evaluate(() => {
      (window as unknown as { __marker: number }).__marker = 42;
    });
    const seen = await watchForHeading(dave, "Test Campaign");
    // Timed from the moment the Admit click is delivered (Playwright's wait for the sliding card to settle is
    // harness time, not admission latency) to the table's heading being laid out in the player's page.
    await card.getByRole("button", { name: "Admit" }).click();
    const t1 = Date.now();
    await expect(dave).toHaveURL(/\/table$/);
    await expect(dave.getByRole("heading", { name: "Test Campaign" })).toBeVisible();
    const at = await seen();
    expect(at, "the table appeared without a page reload").not.toBeNull();
    test.info().annotations.push({ type: "latency", description: `admit → table ${(at as number) - t1} ms` });
    expect((at as number) - t1).toBeLessThanOrEqual(1000);
    expect(await dave.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(42);
    await expect
      .poll(() => dave.evaluate(() => window.__gloam?.sounds.some((s) => s.name === "admitted")))
      .toBe(true);
  });

  test("SPEC §8.2 step 3, §29.2: while waiting — Draw your character (saved as art the DM finds in Approvals), Choose your dice (saved to the profile: the table shows them), Test sound; nothing about the table", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await openTableAs(admin, "Local only");
    const { page: dave } = await newPlayerContext(browser, gloam.url, guardLog);
    await knockAsNew(dave, gloam.url, code, "Dave");
    const activities = dave.getByTestId("waiting-activities");
    for (const name of ["Draw your character", "Choose your dice", "Test sound"])
      await expect(activities.getByRole("button", { name, exact: true })).toBeVisible();
    // (Captured with its candle lit: the flame fades in once its first frame is drawn.)
    await expect(dave.locator('canvas[aria-label="A candle flame"][data-lit="true"]')).toBeAttached({
      timeout: 15_000,
    });
    await dave.screenshot({ path: "artifacts/screens/p1/waiting-room-activities.png" });

    // Choose your dice: metal, saved to the profile as it's picked.
    await activities.getByRole("button", { name: "Choose your dice", exact: true }).click();
    const diceDialog = dave.getByRole("dialog", { name: "Choose your dice" });
    await expect(diceDialog).toBeVisible();
    await diceDialog
      .getByRole("radiogroup", { name: "Dice material" })
      .getByRole("radio", { name: "Metal" })
      .click();
    await expect(diceDialog.locator("[data-material]")).toHaveAttribute("data-material", "metal");
    await dave.screenshot({ path: "artifacts/screens/p1/waiting-room-dice.png" });
    await diceDialog.getByRole("button", { name: "Done" }).click();
    await expect(diceDialog).toHaveCount(0);

    // Draw your character: a stroke, saved — as art, for the DM.
    await activities.getByRole("button", { name: "Draw your character", exact: true }).click();
    const pad = dave.getByTestId("drawing-pad");
    await expect(pad).toBeVisible();
    const canvas = pad.locator("canvas").first();
    const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number };
    await dave.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await dave.mouse.down();
    await dave.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
    await dave.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.7, { steps: 8 });
    await dave.mouse.up();
    await dave.getByRole("button", { name: "Save my drawing" }).click();
    await expect(dave.getByText("Drawing saved")).toBeVisible();
    await expect(pad).toHaveCount(0);
    // Still waiting: nothing about the table reached the page.
    await expect(dave.getByRole("heading", { name: "Waiting for the DM to let you in…" })).toBeVisible();

    // Let in: the table shows his dice as chosen; the DM finds his drawing in Approvals, from Dave.
    await admin
      .getByRole("alert")
      .filter({ hasText: "Dave is knocking" })
      .getByRole("button", { name: "Admit" })
      .click();
    await expect(dave).toHaveURL(/\/table$/);
    await expect
      .poll(
        async () =>
          (await hook<{ name: string; diceSkin?: string }[]>(dave, "presenceList")).find(
            (p) => p.name === "Dave",
          )?.diceSkin ?? "",
      )
      .toContain('"material":"metal"');
    await admin.goto(`${gloam.url}/table`);
    await expect(admin.getByRole("heading", { name: "Test Campaign" })).toBeVisible();
    await dmSection(admin, "Approvals");
    const drawing = admin.locator('[data-pending="Dave\'s character"]');
    await expect(drawing).toBeVisible();
    await expect(drawing).toContainText("from Dave");
  });

  test("AC-AUTH-03: Deny shows the friendly message; Ban blocks future knocks", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await openTableAs(admin, "Local only");
    const { page: eve } = await newPlayerContext(browser, gloam.url, guardLog);
    await knockAsNew(eve, gloam.url, code, "Eve");
    await admin
      .getByRole("alert")
      .filter({ hasText: "Eve is knocking" })
      .getByRole("button", { name: "Deny" })
      .click();
    await expect(eve.getByRole("heading", { name: "The DM couldn't let you in right now" })).toBeVisible();

    const { page: mal } = await newPlayerContext(browser, gloam.url, guardLog);
    await knockAsNew(mal, gloam.url, code, "Mallory");
    await admin
      .getByRole("alert")
      .filter({ hasText: "Mallory is knocking" })
      .getByRole("button", { name: "Ban" })
      .click();
    await expect(mal.getByRole("heading", { name: "You can't join this table" })).toBeVisible();
    await mal.goto(`${gloam.url}/join`);
    await mal.getByLabel("Invite code character 1 of 10").click();
    await mal.keyboard.insertText(code.replace("-", ""));
    await mal.getByLabel("Your name at the table").fill("Not Mallory");
    await mal.getByRole("button", { name: "Continue" }).click();
    await expect(mal.getByText("You can't join this table")).toBeVisible();
  });

  test("AC-AUTH-04 (UI): a returning player on a new browser picks their profile and enters the PIN", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await openTableAs(admin, "Local only");
    const { page: first, context } = await newPlayerContext(browser, gloam.url, guardLog);
    await first.goto(`${gloam.url}/join`);
    await first.getByLabel("Invite code character 1 of 10").click();
    await first.keyboard.insertText(code.replace("-", ""));
    await first.getByLabel("Your name at the table").fill("Thorin");
    await first.getByLabel("PIN character 1 of 4").click();
    await first.keyboard.insertText("2468");
    await first.getByRole("button", { name: "Continue" }).click();
    await expect(first.getByRole("heading", { name: "Waiting for the DM to let you in…" })).toBeVisible();
    await first.getByRole("button", { name: "Leave the lobby" }).click();
    await context.close();
    const { page: second } = await newPlayerContext(browser, gloam.url, guardLog);
    await second.goto(`${gloam.url}/join`);
    await second.getByLabel("Invite code character 1 of 10").click();
    await second.keyboard.insertText(code.replace("-", ""));
    await second.getByRole("tab", { name: "I've played before" }).click();
    await second.getByRole("radio", { name: /Thorin/ }).click();
    await second.getByLabel("PIN for Thorin character 1 of 4").click();
    await second.keyboard.insertText("2468");
    await second.getByRole("button", { name: "Continue" }).click();
    await expect(second.getByText(/Thorin · amber · returning ✓/i)).toBeVisible();
    await expect(admin.getByRole("alert").filter({ hasText: "Thorin is knocking" })).toContainText(
      "returning ✓ PIN verified",
    );
  });

  test("AC-AUTH-01 (UI): a wrong code shows the generic message", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    await openTableAs(admin, "Local only");
    const { page } = await newPlayerContext(browser, gloam.url, guardLog);
    await page.goto(`${gloam.url}/join`);
    await page.getByLabel("Invite code character 1 of 10").click();
    await page.keyboard.insertText("AAAAA00000");
    await expect(page.getByText("That code didn't open the door")).toBeVisible();
  });
});

test.describe("Resilience — code chunks over a flaky connection", () => {
  test("a route chunk that fails to load recovers with one automatic reload", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    await openTableAs(admin, "Local only");
    const { page } = await newPlayerContext(browser, gloam.url, guardLog);
    // The first request for the Join screen's code is dropped, as a flaky tunnel might.
    let dropped = 0;
    await page.route(/\/static\/Join-[^/]+\.js$/, async (route) => {
      if (dropped++ === 0) return route.abort("connectionreset");
      return route.continue();
    });
    await page.goto(`${gloam.url}/join`);
    await expect(page.getByLabel("Invite code character 1 of 10")).toBeVisible({ timeout: 20_000 });
    expect(dropped).toBeGreaterThanOrEqual(2);
    // The one failure is expected here (it's what the page recovered from); nothing else may appear.
    const expected = /Failed to fetch dynamically imported module|net::ERR_CONNECTION_RESET/;
    const other = guardLog.errors.filter((e) => !expected.test(e));
    guardLog.errors.splice(0, guardLog.errors.length, ...other);
  });
});
