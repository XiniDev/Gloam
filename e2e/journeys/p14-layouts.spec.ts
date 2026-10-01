import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { dmSection, introDone, openPanel } from "../fixtures/board.ts";
import { layoutAudit } from "../fixtures/layout.ts";
import { freshShotsDir } from "../fixtures/shotsDir.ts";
import { adminSection, expect, type Guard, guard, knockAsNew, openTableAs, test } from "../fixtures/test.ts";

/** SPEC §28's seven layouts: phones upright and on their side, a tablet both ways, laptops and a large screen. */
const VIEWPORTS = [
  { width: 360, height: 740, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 768, height: 1024, touch: true },
  { width: 1024, height: 768, touch: false },
  { width: 1440, height: 900, touch: false },
  { width: 1920, height: 1080, touch: false },
] as const;

const ADMIN_PAGES = [
  "Table",
  "People",
  "Campaigns",
  "Saves",
  "Assets",
  "Content",
  "API & MCP",
  "Settings",
  "Security log",
  "About",
];

/**
 * Every layout (SPEC §28; AC-RSP-01) with no sideways scrolling and no controls on top of each other: the Admin console's
 * pages, the join page and the waiting room, and the table — the DM's (the demo campaign: its panels, the DM panel's
 * sections, the dice tray, Settings) and a player's (their sheet, the dice tray). Each screen is audited
 * (fixtures/layout.ts) and photographed into artifacts/screens/rsp01/<viewport>/ for the screenshot review.
 */
test.describe("P14 — the seven layouts (RSP)", () => {
  // (Each layout on its own server: they run side by side. A control that can't be pressed fails its step in 20 s,
  // and the other screens are still looked at.)
  test.describe.configure({ mode: "parallel" });
  test.use({ actionTimeout: 20_000 });
  for (const vp of VIEWPORTS) {
    const label = `${vp.width}x${vp.height}`;
    test(`AC-RSP-01: ${label} — no sideways scrolling, no overlapping controls`, async ({
      admin,
      browser,
      gloam,
      guardLog,
    }) => {
      test.setTimeout(600_000);
      const dir = join("artifacts", "screens", "rsp01", label);
      freshShotsDir(dir);
      const problems: string[] = [];
      const context = (storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>) =>
        openContext(browser, gloam.url, guardLog, vp, storageState);
      let n = 0;
      const check = async (p: Page, what: string) => {
        await settle(p);
        problems.push(...(await layoutAudit(p, what)));
        n++;
        await p.screenshot({
          path: join(dir, `${String(n).padStart(2, "0")}-${what.replace(/[^a-z0-9]+/gi, "-")}.png`),
        });
      };
      // Each screen on its own: one that can't be reached is a problem too, and the rest are still looked at.
      const step = async (p: Page, what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
          await check(p, what);
        } catch (e) {
          problems.push(`${what}: couldn't show it — ${(e as Error).message.split("\n")[0]}`);
        }
      };

      await admin.getByRole("button", { name: "Start with the demo" }).click();
      await expect(admin.getByText("The Lantern Crypt is ready")).toBeVisible({ timeout: 30_000 });
      const code = await openTableAs(admin, "Local only");

      // ── The Admin console, at this size ──
      const console_ = await (await context(await admin.context().storageState())).newPage();
      guard(console_, gloam.url, guardLog);
      await console_.goto(`${gloam.url}/admin`);
      for (const name of ADMIN_PAGES)
        await step(console_, `admin ${name}`, async () => {
          // (On a phone, or a short screen on its side, the sections are behind the section picker.)
          await adminSection(console_, name);
          await expect(console_.getByRole("heading", { level: 1 }).first()).toBeVisible();
          await console_.waitForLoadState("networkidle");
        });

      // ── The table as the DM ──
      await step(console_, "table DM", async () => {
        await console_.goto(`${gloam.url}/table`);
        await expect(console_.getByRole("heading", { name: "The Lantern Crypt" })).toBeVisible();
        await introDone(console_);
      });
      const dm = console_;
      for (const panel of ["Sheet", "Party", "Journal"] as const)
        await step(dm, `table DM ${panel}`, async () => {
          await openPanel(dm, panel);
          await expect(shownPanel(dm, panel)).toBeVisible();
        });
      for (const section of ["Scenes", "Tokens & Units", "Lights"])
        await step(dm, `DM panel ${section}`, () => dmSection(dm, section));
      await closePanel(dm);
      await step(dm, "table DM dice tray", async () => {
        await dm.getByTestId("dice-button").click();
        await expect(dm.getByTestId("dice-tray")).toBeVisible();
      });
      await dm.keyboard.press("Escape");
      await step(dm, "table DM settings", async () => {
        await dm.getByRole("button", { name: "Settings" }).click();
        await expect(dm.getByRole("dialog")).toBeVisible();
      });
      await dm.keyboard.press("Escape");
      // …and with no panel open: under its gear (critic RSP-01 r2 — every capture had a panel beside it).
      await step(dm, "table DM settings under its gear", async () => {
        const region = dm.getByRole("region", { name: "DM panel", exact: true });
        if (await region.isVisible().catch(() => false))
          await dm.getByRole("button", { name: /^DM panel/ }).click();
        await expect(region).toBeHidden();
        await dm.getByRole("button", { name: "Settings" }).click();
        await expect(dm.getByRole("dialog")).toBeVisible();
      });
      await dm.keyboard.press("Escape");

      // ── A new player: the door, the waiting room, the table ──
      const player = await (await context()).newPage();
      guard(player, gloam.url, guardLog);
      await step(player, "join", async () => {
        await player.goto(`${gloam.url}/join`);
        await expect(player.getByLabel("Invite code character 1 of 10")).toBeVisible();
        // (Its blurred table behind: the backdrop fades in once its first frame is drawn.)
        await expect(player.locator('main canvas[data-lit="true"]')).toBeAttached({ timeout: 15_000 });
      });
      await knockAsNew(player, gloam.url, code, "Wren");
      await step(player, "waiting room", async () => {
        await expect(player.getByRole("button", { name: "Leave the lobby" })).toBeInViewport();
        // (Its candle lit: the flame fades in once its first frame is drawn.)
        await expect(player.locator('canvas[aria-label="A candle flame"][data-lit="true"]')).toBeAttached({
          timeout: 15_000,
        });
      });
      await dm
        .getByRole("alert")
        .filter({ hasText: "Wren is knocking" })
        .getByRole("button", { name: "Admit" })
        .click();
      await step(player, "table player", async () => {
        await expect(player).toHaveURL(/\/table$/);
        await introDone(player);
      });
      await step(player, "table player Sheet", async () => {
        await openPanel(player, "Sheet");
        await expect(shownPanel(player, "Sheet")).toBeVisible();
      });
      await closePanel(player);
      await step(player, "table player dice tray", async () => {
        await player.getByTestId("dice-button").click();
        await expect(player.getByTestId("dice-tray")).toBeVisible();
      });
      await player.keyboard.press("Escape");

      expect(problems).toEqual([]);
    });
  }
});

async function openContext(
  browser: Browser,
  baseURL: string,
  g: Guard,
  vp: (typeof VIEWPORTS)[number],
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.touch,
    isMobile: vp.touch && Math.min(vp.width, vp.height) < 600,
    ...(storageState ? { storageState } : {}),
  });
  g.contexts.push(context);
  return context;
}

/** Transitions and entrances finished (at most 2 s), so a screen is judged at rest. */
async function settle(p: Page): Promise<void> {
  await p.evaluate(() =>
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
  await p.waitForTimeout(250);
}

/** A panel as it shows: a phone's bottom sheet, or the dock's panel (named for what it holds). */
function shownPanel(p: Page, panel: "Sheet" | "Party" | "Journal") {
  const name = { Sheet: "Character sheet", Party: "Party", Journal: "Journal" }[panel];
  return p.getByTestId("dock-sheet").or(p.getByRole("region", { name, exact: true }));
}

/**
 * A phone's sheet is closed before the next screen (it covers the board). The dock's panel stays open: the dice tray
 * and Settings are looked at beside it, as they're used.
 */
async function closePanel(p: Page): Promise<void> {
  const close = p.getByRole("button", { name: "Close panel" });
  if (await close.isVisible().catch(() => false)) await close.click();
}
