import { type Browser, type BrowserContext, test as base, expect, type Page } from "@playwright/test";
import { type GloamProcess, spawnServer } from "./server.ts";

export interface Guard {
  violations: string[];
  external: string[];
  errors: string[];
  /** Browser contexts opened during the test; closed at teardown so none leak into the next test. */
  contexts: BrowserContext[];
}

/** Watches a page: CSP violations and non-origin requests fail the test (AC-BRD-01, SPEC §22.4, §36.1). */
export function guard(page: Page, origin: string, g: Guard): void {
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to /i.test(t)) g.violations.push(t);
    if (
      m.type() === "error" &&
      !/Failed to load resource: the server responded with a status of 4\d\d/.test(t)
    ) {
      // Where it came from too: "Failed to load resource" alone doesn't say what failed to load.
      const at = m.location().url;
      g.errors.push(at && /Failed to load resource/.test(t) ? `${t} (${at})` : t);
    }
  });

  page.on("pageerror", (e) => g.errors.push(`pageerror: ${e.message}`));
  // The board hidden at the table (React's Suspense sets display: none on it when a suspension reaches the page):
  // a blank board for the player, its frame loop stopped. Never allowed.
  void page.addInitScript(() => {
    const check = (el: Node) => {
      if (!(el instanceof HTMLElement) || el.style.display !== "none" || location.pathname !== "/table")
        return;
      if (el.matches("[data-testid=board]") || el.querySelector("[data-testid=board]"))
        console.error(
          "The board was hidden (display: none): a suspension reached the page's Suspense boundary.",
        );
    };
    new MutationObserver((ms) => {
      for (const m of ms) if (m.type === "attributes") check(m.target);
    }).observe(document, { attributes: true, attributeFilter: ["style"], subtree: true });
  });
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:")) return;
    const host = new URL(u).host;
    if (host !== new URL(origin).host) g.external.push(u);
  });
}

export async function closeContexts(g: Guard): Promise<void> {
  await Promise.all(g.contexts.splice(0).map((c) => c.close().catch(() => {})));
}

export async function newPlayerContext(
  browser: Browser,
  origin: string,
  g: Guard,
  options: { viewport?: { width: number; height: number } } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: origin, ...options });
  g.contexts.push(context);
  const page = await context.newPage();
  guard(page, origin, g);
  return { context, page };
}

interface Fixtures {
  gloam: GloamProcess;
  guardLog: Guard;
  admin: Page;
}

/**
 * `gloam` spawns a fresh server per test; `admin` is a page already through first-run setup and signed in to
 * the Admin console. Every page created with `guard()` records CSP violations and off-origin requests, which are
 * asserted empty at the end of the test.
 */
export const test = base.extend<Fixtures>({
  // Depends on guardLog so the pages close before the server stops (a stopped server would log socket errors).
  gloam: async ({ guardLog }, use) => {
    const s = await spawnServer();
    await use(s);
    await closeContexts(guardLog);
    guardLog.violations.push(...s.cspReports);
    await s.stop();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first parameter
  guardLog: async ({}, use) => {
    const g: Guard = { violations: [], external: [], errors: [], contexts: [] };
    await use(g);
    await closeContexts(g);
    expect(g.violations, "CSP violations").toEqual([]);
    expect(g.external, "requests that left the origin").toEqual([]);
    expect(g.errors, "console errors and uncaught page exceptions").toEqual([]);
  },
  admin: async ({ browser, gloam, guardLog, viewport, deviceScaleFactor }, use) => {
    const context = await browser.newContext({
      baseURL: gloam.url,
      // The configured (or test.use) viewport and pixel ratio; a hand-made context would otherwise get
      // Playwright's defaults (1280 × 720 at 1×).
      viewport,
      deviceScaleFactor,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    guardLog.contexts.push(context);
    const page = await context.newPage();
    guard(page, gloam.url, guardLog);
    await page.goto(gloam.bootstrapLink);
    await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
    await page.getByLabel("Confirm password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Set password and continue" }).click();
    await expect(page.getByRole("heading", { name: "Table", exact: true })).toBeVisible();
    await use(page);
    await context.close();
  },
});

export { expect };

/** Admin console: create the first campaign and open the table in a mode; returns the invite code text. */
export async function openTableAs(
  admin: Page,
  mode: "Quick tunnel" | "Local only" | "LAN" = "Local only",
): Promise<string> {
  const create = admin.getByRole("button", { name: "Create campaign" });
  // The Table page renders the status card and (with no campaign yet) the first-campaign form together,
  // once both the status and the campaign list have loaded.
  await expect(admin.getByRole("heading", { name: "Closed", exact: true })).toBeVisible();
  if (await create.isVisible()) {
    await admin.getByLabel("Campaign name").fill("Test Campaign");
    await create.click();
    await expect(admin.getByText("Start your first campaign")).toBeHidden();
  }
  await admin.getByRole("radio", { name: mode }).click();
  await admin.getByRole("button", { name: "Open table" }).click();
  if (mode === "LAN") await admin.getByRole("button", { name: "Open on the network" }).click();
  await expect(admin.getByRole("heading", { name: "Open", exact: true })).toBeVisible({ timeout: 30_000 });
  const code = await admin.locator(".mono.select-all").first().innerText();
  return code.trim();
}

/**
 * Player: code → new identity → waiting room. Returns the milliseconds from submitting the identity to the
 * waiting room being on screen (AC-AUTH-02's "within 1 s").
 */
export async function knockAsNew(page: Page, origin: string, code: string, name: string): Promise<number> {
  await page.goto(`${origin}/join`);
  await page.getByLabel("Invite code character 1 of 10").click();
  // The tenth character checks the code automatically.
  await page.keyboard.insertText(code.replace("-", ""));
  await page.getByLabel("Your name at the table").fill(name);
  const seen = await watchForHeading(page, "Waiting for the DM to let you in…");
  await page.getByRole("button", { name: "Continue" }).click();
  const t0 = Date.now();
  await expect(page.getByRole("heading", { name: "Waiting for the DM to let you in…" })).toBeVisible();
  const at = await seen();
  expect(at, "the waiting room appeared without a page reload").not.toBeNull();
  return (at as number) - t0;
}

/** Test hooks exposed by the test-mode web build (packages/web/src/test/hooks.ts, SPEC §23.7). */
declare global {
  interface Window {
    __gloam?: {
      sounds: { name: string; played: boolean; at: number }[];
      loadedAt: number;
      ready(): boolean;
      state(): unknown;
      [k: string]: unknown;
    };
  }
}

/**
 * Records, inside the page, the wall-clock time at which a heading with exactly `text` is first rendered and laid
 * out. Latency assertions use this instead of Playwright's retrying checks, whose polling back-off (0/100/250/500 ms)
 * would add up to half a second of measurement error. The observer survives client-side navigation (and a full
 * reload would lose it, which the caller notices as a missing timestamp).
 */
export async function watchForHeading(page: Page, text: string): Promise<() => Promise<number | null>> {
  const key = `__seen_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(
    ({ key, text }) => {
      const w = window as unknown as Record<string, number | undefined>;
      const check = () => {
        if (w[key]) return;
        for (const el of document.querySelectorAll("h1, h2, h3, [role=heading]")) {
          if (el.textContent?.trim() === text && el.getClientRects().length > 0) {
            w[key] = Date.now();
            obs.disconnect();
            return;
          }
        }
      };
      const obs = new MutationObserver(check);
      obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      check();
    },
    { key, text },
  );
  return () =>
    page.evaluate((k) => (window as unknown as Record<string, number | undefined>)[k] ?? null, key);
}
