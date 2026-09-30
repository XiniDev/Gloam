import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { admitPlayer, dmSection, hook, intro, req } from "../fixtures/board.ts";
import { freshShotsDir } from "../fixtures/shotsDir.ts";
import { adminSection, expect, knockAsNew, newPlayerContext, test } from "../fixtures/test.ts";

type Tok = { id: string; name: string; pos: { x: number; y: number } };

/**
 * The key screens of phase 12 (SPEC §4 Screenshots): the admin console's first run (the checklist, the demo) and its
 * new sections — People, Campaigns, Assets, Content, Security log, About & Credits; the Lantern Crypt as the DM and as a
 * new player sees it (the first-steps callout); the DM panel's rail and its new sections — Tokens & Units, Vision &
 * Fog, Walls & Zones, Lights, Party, Handouts & Notes, Approvals with work waiting, House rules; Jump to; a token's DM
 * settings and the badges on its hover card; Act as, in the top bar and on a roll card.
 */
test("P12 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  test.setTimeout(1_200_000);
  const dir = join("artifacts", "screens", "p12", info.project.name);
  freshShotsDir(dir);
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const phone = viewport.width < 640;
  const shot = async (page: Page, name: string) => {
    await page.bringToFront();
    await page.mouse.move(Math.round(viewport.width / 2), 1);
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
  const step = async (name: string, page: Page, fn: () => Promise<unknown>, capture = true) => {
    try {
      await fn();
      if (capture) await shot(page, name);
    } catch (e) {
      const lines = (e as Error).message.split("\n");
      notes.push(
        `${name}: ${lines.slice(0, 3).join(" | ")} ${lines.filter((l) => l.includes("Received")).join(" ")}`,
      );
      await page.screenshot({ path: join(dir, `_failed-${name}.png`) }).catch(() => {});
    }
  };
  // (A phone's console: the section picker opened first.)
  const nav = (p: Page, name: string) => adminSection(p, name);
  const closeDock = async (p: Page) => {
    const close = p.getByRole("button", { name: "Close panel" });
    if (await close.isVisible().catch(() => false)) await close.click();
    else if (
      await p
        .getByRole("region", { name: "DM panel", exact: true })
        .isVisible()
        .catch(() => false)
    )
      await p.getByRole("button", { name: /^DM panel/ }).click();
  };

  // ── The console's first run: the checklist, then the demo ──
  await step("01-admin-checklist", admin, async () => {
    await expect(admin.getByTestId("first-run-checklist")).toBeVisible();
  });
  await admin.getByRole("button", { name: "Start with the demo" }).click();
  await expect(admin.getByText("The Lantern Crypt is ready")).toBeVisible({ timeout: 30_000 });
  await step("02-admin-checklist-demo", admin, async () => {
    await expect(admin.getByTestId("first-run-checklist").locator('[data-step="map"]')).toHaveAttribute(
      "data-done",
      "1",
    );
  });
  await admin.getByRole("radio", { name: "Local only" }).click();
  await admin.getByRole("button", { name: "Open table" }).click();
  await expect(admin.getByRole("heading", { name: "Open", exact: true })).toBeVisible({ timeout: 30_000 });
  const code = (await admin.locator(".mono.select-all").first().innerText()).trim();

  // A player, let in; a second one knocking (for Approvals later).
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport });
  const daveId = (await hook<{ userId: string }>(dave, "me")).userId;

  // ── The admin pages ──
  await step("03-admin-people", admin, async () => {
    await nav(admin, "People");
    await expect(admin.getByTestId("person-row").first()).toBeVisible();
  });
  await step("04-admin-people-role", admin, async () => {
    // (A phone's row folds its actions into one menu.)
    if (phone) {
      await admin
        .getByTestId("person-row")
        .first()
        .getByRole("button", { name: /: actions$/ })
        .click();
      await admin.getByRole("menuitem", { name: "Role" }).click();
    } else await admin.getByTestId("person-row").first().getByRole("button", { name: "Role" }).click();
    await expect(admin.getByRole("dialog")).toBeVisible();
  });
  await admin.keyboard.press("Escape");
  await step("05-admin-campaigns", admin, async () => {
    await nav(admin, "Campaigns");
    await admin.getByLabel("A new campaign").fill("The Sunless Road");
    await admin.getByRole("button", { name: "Make it" }).click();
    await expect(admin.getByTestId("campaign-row")).toHaveCount(2);
  });
  await step("06-admin-assets", admin, async () => {
    await nav(admin, "Assets");
    await expect(admin.getByTestId("asset-campaign").first()).toBeVisible();
  });
  await step("07-admin-content", admin, async () => {
    await nav(admin, "Content");
    await expect(admin.getByTestId("pack-campaign").first()).toBeVisible();
  });
  await step("08-admin-security", admin, async () => {
    await nav(admin, "Security log");
    await expect(admin.getByTestId("security-row").first()).toBeVisible();
  });
  await step("09-admin-about", admin, async () => {
    await nav(admin, "About");
    await expect(admin.getByTestId("srd-attribution")).toBeVisible();
  });

  // ── The table: the DM's Lantern Crypt, and the new player's first steps ──
  await admin.goto(`${gloam.url}/table`);
  // (In front: a page behind gets no frames, and its intro would wait for ever.)
  await admin.bringToFront();
  await expect.poll(async () => (await intro(admin))?.phase, { timeout: 90_000 }).toBe("done");
  await step("10-crypt-dm", admin, async () => {
    await expect(admin.getByRole("heading", { name: "The Lantern Crypt" }).first()).toBeVisible();
  });
  await step("11-crypt-player-first-steps", dave, async () => {
    await expect(dave.getByTestId("first-steps")).toBeVisible();
  });

  // ── The DM panel: the rail and its new sections ──
  for (const [n, name] of [
    ["12", "Tokens & Units"],
    ["13", "Vision & Fog"],
    ["14", "Walls & Zones"],
    ["15", "Lights"],
    ["16", "House rules"],
  ] as const)
    await step(`${n}-dm-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`, admin, async () => {
      await dmSection(admin, name);
    });
  await step("17-dm-notes", admin, async () => {
    await dmSection(admin, "Handouts & Notes");
    const notes = admin.getByLabel(/^Notes on /);
    await notes.fill("The warden wakes when the secret door opens. The riddle's answer: a shadow.");
    await notes.blur();
    await admin.getByTestId("dm-notes").scrollIntoViewIfNeeded();
  });
  // Dave makes his character (Party has someone to show).
  await req(dave, "actor.create", {
    sheet: {
      core: {
        name: "Brin Ashdown",
        hp: { max: 12, current: 12 },
        ac: { value: 16 },
        speeds: { walk: 30 },
        classes: [{ name: "Fighter", level: 1 }],
      },
    },
  });
  await step("18-dm-party", admin, async () => {
    await dmSection(admin, "Party");
    await expect(admin.getByTestId("party-character").first()).toBeVisible();
  });
  // Work waiting: a knock, a proposed spell.
  const { page: erin } = await newPlayerContext(browser, gloam.url, guardLog, { viewport });
  await knockAsNew(erin, gloam.url, code, "Erin");
  await step("19-dm-approvals", admin, async () => {
    await dmSection(admin, "Approvals");
    await expect(admin.getByTestId("approval-knock")).toBeVisible();
  });

  // ── Jump to ──
  if (!phone)
    await step("20-jump-to", admin, async () => {
      await admin.keyboard.press("Control+k");
      await admin.getByTestId("jump-to").getByRole("combobox").fill("gob");
      await expect(admin.getByTestId("jump-option").first()).toBeVisible();
    });
  await admin.keyboard.press("Escape");

  // ── A goblin's DM settings, and its badges ──
  const gob = (await hook<Tok[]>(admin, "tokens")).find((t) => t.name === "Goblin") as Tok;
  await req(admin, "token.update", {
    tokenId: gob.id,
    overrides: { speedOverride: 40, bonusMove: { ft: 10, until: "removed" }, lockMovement: true },
    revealTo: "all",
    dmNote: "Carries the gate key.",
  });
  await step("21-token-settings", admin, async () => {
    await dmSection(admin, "Tokens & Units");
    // (A phone's row folds its actions into one menu.)
    if (phone) {
      await admin.getByRole("button", { name: "Goblin: actions" }).click();
      await admin.getByRole("menuitem", { name: "DM settings" }).click();
    } else await admin.getByRole("button", { name: "Goblin: DM settings" }).click();
    await expect(admin.getByTestId("token-settings")).toBeVisible();
  });
  await admin.keyboard.press("Escape");
  await closeDock(admin);
  if (!phone)
    await step(
      "22-hover-badges",
      admin,
      async () => {
        const s = await hook<{ sx: number; sy: number }>(admin, "project", gob.pos.x, gob.pos.y, 0.15);
        await admin.mouse.move(s.sx, s.sy);
        await expect(admin.getByTestId("dm-badges")).toBeVisible();
        // Its entrance played out (the pointer stays on the token: shot() would move it away).
        await admin.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) =>
                Number.isFinite(a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY),
              )
              .map((a) => a.finished.catch(() => undefined)),
          ),
        );
        await admin.screenshot({ path: join(dir, "22-hover-badges.png") });
      },
      false,
    );

  // ── Act as ──
  await step("23-acting-as", admin, async () => {
    await dmSection(admin, "Party");
    await admin.getByRole("button", { name: "Act as Brin Ashdown" }).click();
    await expect(admin.getByTestId("acting-as")).toBeVisible();
  });
  await req(admin, "dice.roll", { formula: "1d20 + @str", visibility: "public" });
  await step("24-dm-as-roll", dave, async () => {
    await expect(dave.locator('[data-testid="roll-card"]').first()).toContainText("DM as Brin Ashdown", {
      timeout: 20_000,
    });
    await expect
      .poll(
        async () => {
          const st = await hook<{ throws: { done: boolean }[] } | null>(dave, "diceStage").catch(() => null);
          return !st || st.throws.every((t) => t.done);
        },
        { timeout: 20_000 },
      )
      .toBe(true)
      .catch(() => {});
  });
  void daveId;

  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
