import {
  expect,
  knockAsNew,
  newPlayerContext,
  openTableAs,
  test,
  watchForHeading,
} from "../fixtures/test.ts";

test.describe("P1 — joining, the waiting room and admission (AUTH)", () => {
  test("AC-AUTH-02 / AC-AUTH-03: knock → knock card with sound → admit → table without a reload (≤ 1 s)", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
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
