import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  checkerPng,
  createScene,
  dmSection,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, knockAsNew, newPlayerContext, test } from "../fixtures/test.ts";

const SHOTS = "artifacts/screens/p12";

type Tok = { id: string; name: string; pos: { x: number; y: number } };
const tokens = (p: Page) => hook<Tok[]>(p, "tokens");
const tokenId = async (p: Page, name: string) => (await tokens(p)).find((t) => t.name === name)?.id as string;

/** Where a token is on screen. */
async function screenOf(p: Page, id: string): Promise<{ x: number; y: number }> {
  const t = (await tokens(p)).find((x) => x.id === id) as Tok;
  const s = await hook<{ sx: number; sy: number }>(p, "project", t.pos.x, t.pos.y, 0.15);
  return { x: s.sx, y: s.sy };
}

/** The sections SPEC §8.19 lists, as the rail names them. */
const LISTED = [
  "Scenes",
  "Tokens & Units",
  "Vision & Fog",
  "Walls & Zones",
  "Lights",
  "Combat",
  "Requests",
  "Effects",
  "Library",
  "Sound",
  "Party",
  "Handouts & Notes",
  "Approvals",
  "History",
  "House rules",
];

/**
 * The DM control panel (SPEC §8.19): every section two clicks away and Ctrl/Cmd+K to jump anywhere (AC-DMP-01); the
 * per-token overrides set from a token's DM settings and shown as badges on its hover card (AC-DMP-02); Act as, with
 * "DM as <character>" on the rolls, the history and the log (AC-DMP-03); the Approvals inbox gathering knocks, uploads,
 * sheet and homebrew proposals with a live count (AC-DMP-04).
 */
test.describe("P12 — the DM control panel (DMP)", () => {
  test("AC-DMP-01 / AC-DMP-02 / AC-DMP-03 / AC-DMP-04: sections two clicks away and Jump to; overrides as badges; Act as recorded; the Approvals inbox", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(420_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave");
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    const sceneId = await createScene(admin, {
      name: "Crypt hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
      fogMode: "off",
    });
    const { actorId: gobActor } = await req<{ actorId: string }>(admin, "actor.create", {
      kind: "npc",
      sheet: { core: { name: "Goblin", size: "small", hp: { max: 7, current: 7 }, ac: { value: 15 } } },
    });
    await req(admin, "token.create", {
      sceneId,
      name: "Goblin",
      pos: { x: 32.5, y: 17.5 },
      actorId: gobActor,
      link: "unlinked",
      stats: { hp: 7, hpMax: 7, ac: 15 },
    });
    for (const p of [admin, dave]) await boardSettled(p, sceneId);
    const gob = await tokenId(admin, "Goblin");

    // ── AC-DMP-01: every listed section two clicks away (the rail's DM button, then the section) ──
    const panel = admin.getByRole("region", { name: "DM panel", exact: true });
    await admin.getByRole("button", { name: /^DM panel/ }).click();
    const rail = panel.getByRole("tablist", { name: "DM panel sections" });
    for (const name of LISTED) {
      await admin.keyboard.press("Escape");
      const tab = rail.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(panel.getByRole("tabpanel", { name, exact: true })).toBeVisible();
    }
    await admin.screenshot({ path: `${SHOTS}/dm-panel-rules.png` });
    // Ctrl/Cmd+K: any section or command by name.
    const jump = admin.getByTestId("jump-to");
    await admin.keyboard.press("Control+k");
    await expect(jump).toBeVisible();
    await jump.getByRole("combobox").fill("combat");
    await admin.screenshot({ path: `${SHOTS}/jump-to.png` });
    await admin.keyboard.press("Enter");
    await expect(jump).toBeHidden();
    await expect(panel.getByRole("tabpanel", { name: "Combat", exact: true })).toBeVisible();
    await admin.keyboard.press("Control+k");
    await jump.getByRole("combobox").fill("quick unit");
    await admin.keyboard.press("Enter");
    await expect(admin.getByRole("dialog", { name: "Quick unit" })).toBeVisible();
    await admin.keyboard.press("Escape");
    await admin.keyboard.press("Control+k");
    await jump.getByRole("combobox").fill("goblin");
    await expect(jump.getByTestId("jump-option").first()).toContainText("Goblin");
    await admin.keyboard.press("Enter");
    await expect
      .poll(async () => (await hook<{ selection: string[] }>(admin, "ui")).selection)
      .toEqual([gob]);
    await admin.keyboard.press("Control+k");
    await jump.getByRole("combobox").fill("house rules");
    await admin.keyboard.press("Enter");
    await expect(panel.getByRole("tabpanel", { name: "House rules", exact: true })).toBeVisible();

    // ── AC-DMP-02: the goblin's DM settings, from Tokens & Units; every override shown on its hover card ──
    await dmSection(admin, "Tokens & Units");
    await panel.getByRole("button", { name: "Goblin: DM settings" }).click();
    const settings = admin.getByTestId("token-settings");
    await expect(settings).toBeVisible();
    const speed = settings.getByLabel("Speed override");
    await speed.fill("40");
    await speed.press("Enter");
    await settings.getByLabel("Bonus feet").fill("10");
    await settings.getByRole("button", { name: "Give it" }).click();
    for (const label of [
      "Free movement",
      "Lock movement",
      "Ignore conditions' speed",
      "Count my moves",
      "Hidden",
    ])
      await settings.getByRole("switch", { name: label }).click();
    await settings.getByRole("radio", { name: "Always, to all" }).click();
    await settings.getByRole("group", { name: "Shares its sight with" }).getByText("Dave").click();
    await settings.getByLabel("Players see its HP as").selectOption("exact");
    await settings.getByRole("button", { name: "Link to sheet" }).click();
    await settings.getByLabel("DM note").fill("Carries the crypt key.");
    await settings.getByLabel("DM note").blur();
    const badges = [
      "hidden",
      "speed",
      "bonus",
      "free",
      "stuck",
      "ignore",
      "count",
      "share",
      "reveal",
      "link",
      "hp",
      "note",
    ];
    await admin.screenshot({ path: `${SHOTS}/token-settings.png` });
    await admin.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    // (The dock put away: the goblin in the open.)
    await admin.getByRole("button", { name: /^DM panel/ }).click();
    await expect(panel).toBeHidden();
    const at = await screenOf(admin, gob);
    await admin.mouse.move(at.x, at.y);
    const card = admin.getByTestId("hover-card");
    await expect(card).toBeVisible();
    for (const b of badges)
      await expect(card.locator(`[data-badge="${b}"]`), `the ${b} badge`).toBeVisible({ timeout: 10_000 });
    await admin.screenshot({ path: `${SHOTS}/hover-badges.png` });
    // Hidden outranks every reveal: Dave doesn't have it; unhidden, "always shown to all" gives it him — its DM view and
    // its note never.
    expect((await tokens(dave)).some((t) => t.id === gob)).toBe(false);
    await req(admin, "token.update", { tokenId: gob, hidden: false });
    await expect.poll(async () => (await tokens(dave)).some((t) => t.id === gob)).toBe(true);
    const seen = (await tokens(dave)).find((t) => t.id === gob) as Tok & { dm?: unknown };
    expect(seen.dm).toBeUndefined();
    await admin.mouse.move(5, 450);

    // ── AC-DMP-03: Act as Dave's character ──
    const { actorId: thorin } = await req<{ actorId: string }>(dave, "actor.create", {
      sheet: {
        core: {
          name: "Thorin",
          hp: { max: 12, current: 12 },
          ac: { value: 16 },
          speeds: { walk: 30 },
          abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
        },
      },
    });
    // (His token joins the board at the party's spawn by itself.)
    await expect.poll(async () => (await tokens(admin)).some((t) => t.name === "Thorin")).toBe(true);
    void daveId;
    await dmSection(admin, "Party");
    await panel.getByRole("button", { name: "Act as Thorin" }).click();
    await expect(admin.getByTestId("acting-as")).toContainText("Acting as Thorin");
    await expect(dave.getByText("is playing Thorin for you")).toBeVisible();
    await admin.screenshot({ path: `${SHOTS}/acting-as.png` });
    // A roll from the tray: Thorin's (his Strength behind @str), "DM as Thorin" on Dave's card.
    await admin.getByTestId("dice-button").click();
    await admin.getByTestId("dice-formula").fill("1d20 + @str");
    await admin.getByTestId("dice-tray").getByRole("button", { name: "Roll", exact: true }).click();
    const daveCard = dave.locator('[data-testid="roll-card"]').first();
    await expect(daveCard).toContainText("DM as Thorin", { timeout: 20_000 });
    // A change while acting: the history says so.
    await req(admin, "hp.apply", { targets: [await tokenId(admin, "Thorin")], kind: "damage", amount: 2 });
    await dmSection(admin, "History");
    await expect(panel.getByTestId("history-row").first()).toContainText("as Thorin");
    // A line in the log while acting.
    await admin.getByRole("button", { name: /^Journal/ }).click();
    await admin.getByLabel("A line for the log").fill("Thorin keeps watch.");
    await admin.getByRole("button", { name: "Add to the log" }).click();
    await expect(admin.getByTestId("campaign-log")).toContainText("as Thorin");
    // Let go: from the bar.
    await admin.getByTestId("acting-as").getByRole("button", { name: "Stop" }).click();
    await expect(admin.getByTestId("acting-as")).toBeHidden();
    await expect(dave.getByText("gave your character back")).toBeVisible();

    // ── AC-DMP-04: the Approvals inbox, its count live ──
    await admin.getByRole("button", { name: /^DM panel/ }).click();
    await dmSection(admin, "Approvals");
    const approvals = rail.getByRole("tab", { name: "Approvals", exact: true });
    const count = () => approvals.evaluate((el) => Number(el.querySelector("span")?.textContent || 0));
    // A knock at the door.
    const { page: erin } = await newPlayerContext(browser, gloam.url, guardLog);
    await knockAsNew(erin, gloam.url, code, "Erin");
    await expect(panel.getByTestId("approval-knock")).toContainText("Erin is knocking");
    await expect.poll(count).toBe(1);
    // A homebrew spell proposed by Dave, an upload from him, a sheet change he proposes (his sheet fully locked).
    const fireball = await dave.evaluate(async () => {
      const r = (await fetch("/api/table/content/spells").then((x) => x.json())) as {
        data: { spells: Record<string, unknown>[] };
      };
      return r.data.spells.find((s) => s.id === "fireball") as Record<string, unknown>;
    });
    const { provenance: _p, ...rest } = fireball;
    await req(dave, "content.spell.save", {
      spell: { ...rest, id: "frost-ball", name: "Frost Ball", source: { pack: "homebrew" } },
    });
    await expect(panel.getByTestId("approval-homebrew")).toContainText("Frost Ball");
    await expect.poll(count).toBe(2);
    await hook(dave, "upload", (await checkerPng(256, 4)).toString("base64"), "Dave's cloak.png", "token");
    await expect(panel.getByRole("list", { name: "Uploads waiting for approval" })).toBeVisible();
    await expect.poll(count).toBe(3);
    await req(admin, "actor.setLock", { actorId: thorin, level: "full" });
    await req(dave, "actor.propose", {
      actorId: thorin,
      changes: [{ path: ["core", "ac", "value"], after: 17 }],
      note: "New shield",
    });
    await expect.poll(count).toBe(4);
    await admin.screenshot({ path: `${SHOTS}/approvals.png` });
    // Decided here, one by one: the count follows.
    await panel.getByTestId("approval-knock").getByRole("button", { name: "Admit" }).click();
    await expect(erin).toHaveURL(/\/table$/);
    await expect.poll(count).toBe(3);
    await panel.getByTestId("approval-homebrew").getByRole("button", { name: "Approve" }).click();
    await expect.poll(count).toBe(2);
    // The sheet change and the upload.
    while ((await count()) > 0) {
      const before = await count();
      await panel
        .getByRole("button", { name: /^Approve/ })
        .first()
        .click();
      await expect.poll(count).toBe(before - 1);
    }
    await expect(panel.getByText("Nothing waiting.", { exact: false })).toBeVisible();
  });
});
