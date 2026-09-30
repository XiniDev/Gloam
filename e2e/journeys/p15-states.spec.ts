import type { Page, Route } from "@playwright/test";
import {
  adminAtTable,
  boardSettled,
  createScene,
  dmSection,
  hook,
  introDone,
  openPanel,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

/** A request to `path` exactly (not its sub-paths), held until released or failed as a dropped connection. */
async function intercept(p: Page, path: string, how: "hold" | "fail") {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const handler = async (route: Route) => {
    if (how === "fail") return route.abort("connectionfailed");
    await held;
    await route.continue().catch(() => {});
  };
  const match = (u: URL) => u.pathname === path;
  await p.route(match, handler);
  return {
    release: async () => {
      release();
      await p.unroute(match, handler);
    },
  };
}

async function nav(p: Page, name: string) {
  const link = p.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name, exact: true });
  await link.click();
}

/** The loading line for `what`, and the failed card for it (its words and its Try again). */
const loading = (p: Page, what: string) =>
  p
    .getByTestId("loading")
    .filter({ hasText: `Loading ${what}…` })
    .first();
const failed = (p: Page, what: string) =>
  p
    .getByTestId("load-failed")
    .filter({ hasText: `Couldn't load ${what}.` })
    .first();

/**
 * No blank panels (SPEC §28 EmptyState; AC-DS-05): everything a panel fetches shows while it's on its way, says what
 * couldn't be loaded and why — with Try again, which brings it — and says so when there's nothing. Checked through the
 * real code paths: the Admin console's pages with their requests held and dropped (Playwright routes), the table's
 * panels with their room requests held and failed (the test build's request faults), and every panel and DM section
 * of a new campaign holding words, not an empty frame.
 */
test.describe("P15 — empty, loading and failed states (DS-05)", () => {
  test("AC-DS-05: the Admin console's pages — loading, a failure with Try again, then their content", async ({
    admin,
    guardLog,
  }) => {
    test.setTimeout(300_000);
    await expect(admin.getByRole("heading", { name: "Table", exact: true })).toBeVisible();
    const pages: [name: string, path: string, what: string | null][] = [
      ["People", "/api/admin/people", "the people"],
      ["Campaigns", "/api/admin/campaigns", "the campaigns"],
      ["Saves", "/api/admin/backups", "the backups"],
      ["Assets", "/api/admin/assets", "the storage figures"],
      ["Content", "/api/admin/content", "the content"],
      ["API & MCP", "/api/admin/api", null],
      ["Settings", "/api/admin/settings", null],
      ["Security log", "/api/admin/security-log", "the log"],
      ["About", "/api/admin/about", "the credits"],
    ];
    const whatFailed: Record<string, string> = { "API & MCP": "the API settings", Settings: "the settings" };
    for (const [name, path, what] of pages) {
      // Away first, so the page mounts (and fetches) with the request intercepted.
      await nav(admin, name === "People" ? "Campaigns" : "People");
      // ── Loading: a turning d20 and what's coming (the API and Settings pages hold their form's shape instead) ──
      const hold = await intercept(admin, path, "hold");
      await nav(admin, name);
      if (what) await expect(loading(admin, what), `${name}: loading`).toBeVisible();
      else await expect(admin.locator(".skeleton").first(), `${name}: its skeleton`).toBeVisible();
      await hold.release();
      if (what) await expect(loading(admin, what)).toBeHidden();
      else await expect(admin.locator(".skeleton").first()).toBeHidden();

      // ── Failed: what, why, Try again — which brings it ──
      await nav(admin, name === "People" ? "Campaigns" : "People");
      const drop = await intercept(admin, path, "fail");
      await nav(admin, name);
      const card = failed(admin, what ?? whatFailed[name] ?? name);
      await expect(card, `${name}: the failure said`).toBeVisible();
      await expect(card.getByText("Can't reach the table right now.")).toBeVisible();
      await drop.release();
      await card.getByRole("button", { name: "Try again" }).click();
      await expect(card, `${name}: Try again brought it`).toBeHidden();
      await expect(admin.getByRole("heading", { level: 1 }).first()).toBeVisible();
    }
    // ── The Table page (the console's first): its status and campaigns ──
    await nav(admin, "People");
    const drop = await intercept(admin, "/api/admin/table", "fail");
    await nav(admin, "Table");
    const card = failed(admin, "the table");
    await expect(card).toBeVisible();
    await drop.release();
    await card.getByRole("button", { name: "Try again" }).click();
    await expect(admin.getByRole("heading", { name: "Closed", exact: true })).toBeVisible();
    // (The browser logs each request this test dropped; those, and only those, aren't the page's errors.)
    const dropped = guardLog.errors.filter((e) =>
      /^Failed to load resource: net::ERR_CONNECTION_FAILED \(http:\/\/localhost:\d+\/api\/admin\//.test(e),
    );
    expect(dropped.length).toBeGreaterThanOrEqual(pages.length + 1);
    guardLog.errors.splice(0, guardLog.errors.length, ...guardLog.errors.filter((e) => !dropped.includes(e)));
  });

  test("AC-DS-05: the table's panels — the log, handouts, Library, sound, notes, approvals and history: loading, failed, Try again", async ({
    admin,
  }) => {
    test.setTimeout(300_000);
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 30,
    });
    await boardSettled(admin, sceneId);

    // ── The Journal: the log and the handouts, fetched for each connection ──
    await hook(admin, "holdRequests", ["log.list"]);
    await hook(admin, "reloadFunLists");
    await openPanel(admin, "Journal");
    await expect(loading(admin, "the log")).toBeVisible();
    await hook(admin, "holdRequests", []);
    await expect(loading(admin, "the log")).toBeHidden();
    await hook(admin, "failRequests", ["log.list"]);
    await hook(admin, "reloadFunLists");
    const log = failed(admin, "the log");
    await expect(log).toBeVisible();
    await expect(log.getByText("The table didn't answer.")).toBeVisible();
    // The handouts came with the log: their tab says so too.
    await admin.getByRole("tab", { name: /^Handouts/ }).click();
    await expect(failed(admin, "the handouts")).toBeVisible();
    await admin.getByRole("tab", { name: /^Log/ }).click();
    await hook(admin, "failRequests", []);
    await log.getByRole("button", { name: "Try again" }).click();
    await expect(log).toBeHidden();
    await expect(
      admin.getByTestId("log-sheet").or(admin.getByText("Nothing written yet", { exact: false })),
    ).toBeVisible();

    // ── DM panel sections that fetch: failed, then Try again ──
    const cases: [section: string, type: string, what: string, after: RegExp][] = [
      ["Library", "asset.list", "the Library", /Nothing here yet/],
      ["Sound", "asset.list", "the tracks", /No tracks yet/],
      ["Approvals", "asset.list", "what's waiting", /Nothing waiting/],
      ["Handouts & Notes", "scene.notes", "the notes", /./],
      ["History", "history.list", "the history", /./],
    ];
    for (const [section, type, what, after] of cases) {
      // (The section opened with its request failing; a section already open is left and opened again.)
      await dmSection(admin, "House rules");
      await hook(admin, "failRequests", [type]);
      await dmSection(admin, section);
      const card = failed(admin, what);
      await expect(card, `${section}: the failure said`).toBeVisible();
      await hook(admin, "failRequests", []);
      await card.getByRole("button", { name: "Try again" }).click();
      await expect(card, `${section}: Try again brought it`).toBeHidden();
      const panel = admin.getByRole("region", { name: "DM panel", exact: true });
      await expect(panel.getByText(after).first()).toBeVisible();
    }
    // The notes, back: their field.
    await dmSection(admin, "Handouts & Notes");
    await expect(admin.getByLabel("Notes on Hall")).toBeVisible();
  });

  test("AC-DS-05: no blank panels — every dock panel and every DM section of a new campaign has words in it", async ({
    admin,
  }) => {
    test.setTimeout(300_000);
    await adminAtTable(admin);
    await introDone(admin);
    const blank: string[] = [];
    const words = (text: string) => text.replace(/\s+/g, " ").trim().length;
    const regions = { Sheet: "Character sheet", Party: "Party", Journal: "Journal" } as const;
    for (const panel of ["Sheet", "Party", "Journal"] as const) {
      await openPanel(admin, panel);
      const sheet = admin.getByRole("region", { name: regions[panel], exact: true });
      await expect(sheet).toBeVisible();
      // (Nothing still loading when judged.)
      await expect(sheet.getByTestId("loading")).toHaveCount(0);
      if (words(await sheet.innerText()) < 24) blank.push(panel);
    }
    const sections = [
      "Scenes",
      "Tokens & Units",
      "Vision & Fog",
      "Walls & Zones",
      "Lights",
      "Combat",
      "Health",
      "Requests",
      "Effects",
      "Spells",
      "Library",
      "Sound",
      "Party",
      "Handouts & Notes",
      "Approvals",
      "History",
      "House rules",
    ];
    const region = admin.getByRole("region", { name: "DM panel", exact: true });
    for (const section of sections) {
      await dmSection(admin, section);
      await expect(region.getByTestId("loading")).toHaveCount(0);
      const all = await region.innerText();
      const tabs = await region.getByRole("tablist", { name: "DM panel sections" }).innerText();
      if (words(all) - words(tabs) < 24) blank.push(`DM panel: ${section}`);
    }
    expect(blank, "panels with (almost) nothing in them").toEqual([]);
  });
});
