import { boardSettled, hook, intro, introDone } from "../fixtures/board.ts";
import { expect, guard, knockAsNew, newPlayerContext, test } from "../fixtures/test.ts";

type Tok = { id: string; name: string; pos: { x: number; y: number }; ownerIds?: string[] };

/**
 * The first run (SPEC §8.24; AC-DEMO-03): from the setup link to a player moving their token on the Lantern Crypt —
 * set the password, start with the demo, open the table on this PC, a friend joins with the code in another browser
 * and is let in, makes a character and moves it — in under three minutes, every step saying what to do next.
 */
test.describe("P12 — the first run with the demo (DEMO)", () => {
  // A wall-clock budget: run alone (the timing project), not beside another table's rendering.
  test("AC-DEMO-03: setup → the demo → open locally → a player joins, is admitted and moves a token, in under 3 minutes with guidance at every step", {
    tag: "@timing",
  }, async ({ browser, gloam, guardLog }) => {
    test.setTimeout(240_000);
    const t0 = Date.now();
    // Where the time goes (printed with the result): each step's end, in seconds from the start.
    const marks: string[] = [];
    const mark = (what: string) => {
      marks.push(`${what} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(`first run · ${marks[marks.length - 1]}`);
    };
    // Dave's view: where it looks (the dock's slide when his sheet opens must come back when it closes).
    const target = async () =>
      ((await hook<{ target: number[] }>(dave, "camera")) as { target: number[] }).target;
    test.info().annotations.push({ type: "timing", description: "" });
    const shots = "artifacts/screens/p12";
    // ── The Admin's first run ──
    const context = await browser.newContext({ baseURL: gloam.url, viewport: { width: 1440, height: 900 } });
    guardLog.contexts.push(context);
    const admin = await context.newPage();
    guard(admin, gloam.url, guardLog);
    await admin.goto(gloam.bootstrapLink);
    await expect(admin.getByRole("heading", { name: "Set the Admin password" })).toBeVisible();
    await expect(admin.getByText("Friends never need it — they join with an invite code.")).toBeVisible();
    await admin.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
    await admin.getByLabel("Confirm password").fill("correct horse battery staple");
    await admin.getByRole("button", { name: "Set password and continue" }).click();
    mark("set password");
    // The console: a first campaign — or the demo.
    await expect(admin.getByText("Start your first campaign")).toBeVisible();
    await expect(admin.getByText("Or try the demo first")).toBeVisible();
    await admin.screenshot({ path: `${shots}/first-run-console.png` });
    await admin.getByRole("button", { name: "Start with the demo" }).click();
    await expect(admin.getByText("The Lantern Crypt is ready")).toBeVisible({ timeout: 30_000 });
    mark("demo made");
    await expect(admin.getByText("Start your first campaign")).toBeHidden();
    // Open the table on this PC.
    await expect(admin.getByRole("heading", { name: "Closed", exact: true })).toBeVisible();
    await admin.getByRole("radio", { name: "Local only" }).click();
    await admin.getByRole("button", { name: "Open table" }).click();
    await expect(admin.getByRole("heading", { name: "Open", exact: true })).toBeVisible({ timeout: 30_000 });
    mark("table open");
    const code = (await admin.locator(".mono.select-all").first().innerText()).trim();
    await admin.getByRole("button", { name: "Go to the table" }).click();
    await expect(admin).toHaveURL(/\/table$/);
    await introDone(admin);
    mark("admin at the table");
    await expect(admin.getByRole("heading", { name: "The Lantern Crypt" }).first()).toBeVisible();

    // ── A friend joins in another browser ──
    const { page: dave } = await newPlayerContext(browser, gloam.url, guardLog);
    await dave.goto(`${gloam.url}/join`);
    await expect(dave.getByText("Got the code from your DM?")).toBeVisible();
    await knockAsNew(dave, gloam.url, code, "Dave");
    await expect(dave.getByRole("heading", { name: "Waiting for the DM to let you in…" })).toBeVisible();
    mark("dave knocked");
    // The DM lets him in from the knock at the table.
    const knock = admin.getByRole("alert").filter({ hasText: "Dave is knocking" });
    await expect(knock).toBeVisible();
    await knock.getByRole("button", { name: "Admit" }).click();
    await expect(dave).toHaveURL(/\/table$/);
    mark("dave admitted");
    await dave.bringToFront();
    // (Two software-rendered tables in one machine: the second's first load is slow — not what this measures.)
    await expect.poll(async () => (await intro(dave))?.phase, { timeout: 60_000 }).toBe("done");
    mark("dave at the table");
    const framed = await target();
    // What to do first, said plainly: make a character.
    const first = dave.getByTestId("first-steps");
    await expect(first).toBeVisible({ timeout: 20_000 });
    await expect(first).toContainText("Make your character");
    await dave.screenshot({ path: `${shots}/first-steps.png` });
    await first.getByRole("button", { name: "Make my character" }).click();

    const sheet = dave.getByRole("region", { name: "Character sheet", exact: true });
    await sheet.getByRole("button", { name: "Quick create" }).click();
    const dialog = dave.getByTestId("quick-create");
    await dialog.getByLabel("Name").fill("Brin Ashdown");
    await dialog.getByLabel("Class and level").fill("Fighter 1");
    await dialog.getByLabel("Max HP").fill("12");
    await dialog.getByLabel("AC").fill("16");
    await dave.getByRole("button", { name: "Create character" }).click();
    mark("character made");

    // His token joins the board at the party's spawn (the hall's west end).
    const mine = async () => (await hook<Tok[]>(dave, "tokens")).find((x) => x.name === "Brin Ashdown");
    await expect.poll(async () => (await mine())?.pos, { timeout: 20_000 }).toEqual({ x: 12, y: 35 });
    mark("token placed");
    await expect(first).toBeHidden();
    // (The sheet put away: the dock's Sheet button again.)
    await dave
      .getByRole("navigation", { name: "Panels" })
      .getByRole("button", { name: "Sheet", exact: true })
      .click();
    const scene = await hook<{ shown: string | null }>(dave, "boardScene");
    await boardSettled(dave, scene.shown as string);
    mark("board settled");
    // The sheet put away, the view is where it was framed: the hall in the clear, not under the tool bar.
    await expect
      .poll(async () => Math.hypot(...(await target()).map((v, k) => v - (framed[k] ?? 0))))
      .toBeLessThan(0.5);
    await dave.screenshot({ path: `${shots}/before-move.png` });
    // …and he moves it: drag it five squares east.
    const tok = (await mine()) as Tok;
    const from = await hook<{ sx: number; sy: number }>(dave, "project", tok.pos.x, tok.pos.y, 0.2);
    const to = await hook<{ sx: number; sy: number }>(dave, "project", tok.pos.x + 15, tok.pos.y, 0.2);
    await dave.mouse.move(from.sx, from.sy);
    await dave.mouse.down();
    await dave.mouse.move((from.sx + to.sx) / 2, (from.sy + to.sy) / 2, { steps: 6 });
    await dave.mouse.move(to.sx, to.sy, { steps: 6 });
    await dave.mouse.up();
    await expect
      .poll(async () => (await mine())?.pos.x ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(tok.pos.x + 10);
    await dave.screenshot({ path: `${shots}/first-move.png` });
    mark("moved");
    const timing = test.info().annotations.find((x) => x.type === "timing");
    if (timing) timing.description = marks.join(" · ");
    console.log(`first run: ${marks.join(" · ")}`);
    const took = Date.now() - t0;
    expect(took, `the first run took ${(took / 1000).toFixed(0)} s`).toBeLessThan(180_000);
  });
});
