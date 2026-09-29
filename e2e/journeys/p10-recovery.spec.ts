import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, type Guard, newPlayerContext, openTableAs, test } from "../fixtures/test.ts";

const requireFromServer = createRequire(
  join(import.meta.dirname, "..", "..", "packages", "server", "package.json"),
);
type Sqlite = { prepare(sql: string): { all(...a: unknown[]): unknown[] }; close(): void };
const Database = requireFromServer("better-sqlite3") as new (
  path: string,
  opts: { readonly: boolean; fileMustExist: boolean },
) => Sqlite;

type Token = { id: string; name: string; pos: { x: number; y: number }; hp?: { hp: number } };
const tokens = (p: Page) => hook<Token[]>(p, "tokens");
/**
 * A table page's intro done, however long its first load takes: a restarted table with combat, a web and painted
 * fog compiles some sixty shader programs on first load — on software GL at 2 fps that's the better part of a minute.
 * What these journeys test is what comes back, not how fast a slow renderer warms up.
 */
const tableUp = (p: Page) =>
  expect
    .poll(
      async () =>
        await p.evaluate(() => (window.__gloam?.intro as (() => { phase: string }) | undefined)?.().phase),
      {
        timeout: 90_000,
      },
    )
    .toBe("done");

/**
 * The console errors a planned outage makes — the browser's own reports of connections to this server that failed
 * while it was away (a refused socket, a refused WebSocket handshake) — and only those, forgiven.
 */
function forgiveOutage(g: Guard, url: string): void {
  const host = new URL(url).host;
  const outage = (e: string) =>
    (e.includes(`ws://${host}`) && /WebSocket connection to .* failed/.test(e)) ||
    (/Failed to load resource: net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE)/.test(e) &&
      e.includes(host));
  const keep = g.errors.filter((e) => !outage(e));
  g.errors.splice(0, g.errors.length, ...keep);
}

test.describe("P10 — recovery (PER)", () => {
  test("AC-PER-06: the host gone for a while and back — both screens say so, and pick up again without a reload", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(240_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Watchtower",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 30,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave");
    await boardSettled(dave, sceneId);
    const loaded = {
      dave: await dave.evaluate(() => window.__gloam?.loadedAt),
      admin: await admin.evaluate(() => window.__gloam?.loadedAt),
    };
    // Gone for 70 s — longer than the client library's own retries (about a minute): the table's own rejoin brings
    // them back (SPEC J9: a PC asleep).
    gloam.blackout(70_000);
    for (const p of [dave, admin])
      await expect(p.getByText(/Connection lost/)).toBeVisible({ timeout: 15_000 });
    // (Visible to Playwright from its first frame, at opacity 0: captured once it has faded in.)
    await expect(dave.getByRole("status").filter({ hasText: /Connection lost/ })).toHaveCSS("opacity", "1");
    await dave.screenshot({ path: "artifacts/screens/p10/reconnecting.png" });
    for (const p of [dave, admin])
      await expect
        .poll(() => hook<string>(p, "connection"), { timeout: 150_000, intervals: [1000] })
        .toBe("open");
    for (const p of [dave, admin]) await expect(p.getByText(/Connection lost/)).toBeHidden();
    // No reload: the same pages, picked up where they were.
    expect(await dave.evaluate(() => window.__gloam?.loadedAt)).toBe(loaded.dave);
    expect(await admin.evaluate(() => window.__gloam?.loadedAt)).toBe(loaded.admin);
    // And live: what the DM does now reaches Dave's board.
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Sentry",
      pos: { x: 12, y: 12 },
      disposition: "party",
    });
    await expect.poll(async () => (await tokens(dave)).some((t) => t.id === tokenId)).toBe(true);
    forgiveOutage(guardLog, gloam.url);
  });

  test("AC-PER-02 / AC-PER-07: killed mid-session and started again — the board, combat, sheets, effects and fog as they were; old codes dead, the session logged as ended unexpectedly; Dave back with his PIN to the same character, place and dice", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(300_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Crypt of Ash",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);

    // Dave joins with a PIN (he'll need it: a crash revokes the codes, and a new browser won't know him).
    const { page: dave, context: daveContext } = await newPlayerContext(browser, gloam.url, guardLog);
    await dave.goto(`${gloam.url}/join`);
    await dave.getByLabel("Invite code character 1 of 10").click();
    await dave.keyboard.insertText(code.replace("-", ""));
    await dave.getByLabel("Your name at the table").fill("Dave");
    await dave.getByLabel("PIN character 1 of 4").click();
    await dave.keyboard.insertText("2468");
    await dave.getByRole("button", { name: "Continue" }).click();
    await admin
      .getByRole("alert")
      .filter({ hasText: "Dave is knocking" })
      .getByRole("button", { name: "Admit" })
      .click();
    await expect(dave).toHaveURL(/\/table$/);
    await introDone(dave);
    await boardSettled(dave, sceneId);
    const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;

    // His dice skin, his character (sheet and token), a wounded foe, combat under way, a web, the fog painted open.
    await req(dave, "profile.diceSkin", { body: "#aa3355", number: "#ffeedd", material: "gemstone" });
    const { actorId } = await req<{ actorId: string }>(admin, "actor.create", {
      kind: "character",
      ownerUserId: daveId,
      sheet: { core: { name: "Mira", size: "medium", hp: { max: 12, current: 12 } } },
    });
    // (A player's character is placed on the active scene by itself — AC-SCN-06: the DM moves it into the room.)
    const mira = await expect
      .poll(
        async () =>
          (await hook<{ id: string; actorId?: string }[]>(admin, "tokens")).find((t) => t.actorId === actorId)
            ?.id,
      )
      .toBeTruthy()
      .then(
        async () =>
          (await hook<{ id: string; actorId?: string }[]>(admin, "tokens")).find((t) => t.actorId === actorId)
            ?.id as string,
      );
    const from = (await tokens(admin)).find((t) => t.id === mira)?.pos as { x: number; y: number };
    await req(admin, "move.commit", { tokenId: mira, points: [from, { x: 22, y: 14 }] });
    await expect
      .poll(async () => (await tokens(admin)).find((t) => t.id === mira)?.pos)
      .toEqual({ x: 22, y: 14 });
    const { tokenId: ghoul } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Ghoul",
      pos: { x: 40, y: 20 },
      disposition: "hostile",
      stats: { hp: 22, hpMax: 22, ac: 12 },
    });
    await req(admin, "hp.apply", { targets: [ghoul], kind: "damage", amount: 9 });
    await req(admin, "hp.apply", { targets: [mira], kind: "damage", amount: 4 });
    await req(admin, "spell.cast", {
      casterTokenId: ghoul,
      spellId: "web",
      mode: "free",
      level: 2,
      placement: { origin: { x: 48, y: 30, z: 0 } },
    });
    await req(admin, "combat.quickStart", {});
    const card = dave.getByTestId("request-group").filter({ hasText: "Initiative" });
    await card.getByRole("button", { name: "Enter physical roll" }).first().click();
    await card.getByLabel("Your total").first().fill("17");
    await card.getByLabel("Your total").first().press("Enter");
    await expect
      .poll(async () => (await hook<{ begun: boolean }>(admin, "combat")).begun, { timeout: 20_000 })
      .toBe(true);
    await req(admin, "scene.update", { sceneId, fogMode: "painted" });
    await req(admin, "fog.paint", {
      sceneId,
      mode: "reveal",
      target: "all",
      shape: { kind: "rect", x: 10, y: 5, w: 30, h: 20 },
    });

    // As the board stands (every accepted change is on disk before anyone sees it: AC-PER-01).
    const snapshot = async (p: Page) => {
      const ts = (await tokens(p))
        .map((t) => ({ id: t.id, name: t.name, pos: t.pos, hp: t.hp?.hp }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const combat = (await hook<{
        round: number;
        activeIndex: number;
        entries: { tokenId?: string; initiative?: number }[];
      }>(p, "combat")) as {
        round: number;
        activeIndex: number;
        entries: { tokenId?: string; initiative?: number }[];
      };
      const effects = ((await hook<{ name: string }[]>(p, "effectsDrawn")) ?? []).map((e) => e.name).sort();
      const fog = (await hook<{ layers: Record<string, number> }>(p, "fog"))?.layers ?? {};
      return {
        tokens: ts,
        combat: {
          round: combat.round,
          activeIndex: combat.activeIndex,
          entries: combat.entries.map((e) => [e.tokenId, e.initiative]),
        },
        effects,
        fog,
      };
    };
    await expect.poll(async () => (await snapshot(admin)).effects).toContain("Web");
    await expect
      .poll(async () => Object.values((await snapshot(admin)).fog).reduce((a, b) => a + b, 0))
      .toBeGreaterThan(0);
    const before = await snapshot(admin);
    const sheetBefore = ((await hook<{ id: string; sheet: unknown }[]>(dave, "sheets")) ?? []).find(
      (a) => a.id === actorId,
    );
    expect(sheetBefore).toBeTruthy();

    // Killed outright: no shutdown, nothing flushed. Both screens say they've lost the table.
    await gloam.kill();
    for (const p of [dave, admin])
      await expect(p.getByText(/Connection lost/)).toBeVisible({ timeout: 15_000 });
    await gloam.restart();
    // (This browser is done: Dave comes back on another. Closed, so four pages don't share one software renderer.)
    await daveContext.close();

    // The Admin opens the table again: a new code; the old one no longer works.
    await admin.goto(`${gloam.url}/admin`);
    const newCode = await openTableAs(admin, "Local only");
    expect(newCode).not.toBe(code);
    const { page: stranger, context: strangerContext } = await newPlayerContext(browser, gloam.url, guardLog);
    await stranger.goto(`${gloam.url}/join`);
    await stranger.getByLabel("Invite code character 1 of 10").click();
    await stranger.keyboard.insertText(code.replace("-", ""));
    await expect(stranger.getByText("That code didn't open the door")).toBeVisible();
    await expect(stranger.getByLabel("Your name at the table")).toHaveCount(0);
    await strangerContext.close();

    // The previous session is closed in the log as ended unexpectedly.
    const db = new Database(join(gloam.dataDir, "gloam.db"), { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare("SELECT campaign_id, session_no, close_reason FROM table_sessions ORDER BY opened_at")
        .all() as { campaign_id: string; session_no: number; close_reason: string | null }[];
      const campaignCount = db.prepare("SELECT id FROM campaigns").all().length;
      const detail = JSON.stringify({ rows, campaignCount });
      // One campaign; its first session closed as a crash, the one opened now still open.
      expect(campaignCount, detail).toBe(1);
      expect(
        rows.map((r) => [r.session_no, r.close_reason]),
        detail,
      ).toEqual([
        [1, "crash"],
        [2, null],
      ]);
      const logged = db.prepare("SELECT text FROM log_entries WHERE kind = 'session.close'").all() as {
        text: string;
      }[];
      expect(logged.map((r) => r.text)).toContain("Session 1 ended unexpectedly.");
    } finally {
      db.close();
    }

    // Dave, on a browser that doesn't know him: the new code, "I've played before", his PIN — admitted as returning.
    const { page: back } = await newPlayerContext(browser, gloam.url, guardLog);
    await back.goto(`${gloam.url}/join`);
    await back.getByLabel("Invite code character 1 of 10").click();
    await back.keyboard.insertText(newCode.replace("-", ""));
    await back.getByRole("tab", { name: "I've played before" }).click();
    await back.getByRole("radio", { name: /Dave/ }).click();
    await back.getByLabel("PIN for Dave character 1 of 4").click();
    await back.keyboard.insertText("2468");
    await back.getByRole("button", { name: "Continue" }).click();
    const knock = admin.getByRole("alert").filter({ hasText: "Dave is knocking" });
    await expect(knock).toContainText("returning ✓ PIN verified");
    await knock.getByRole("button", { name: "Admit" }).click();
    await expect(back).toHaveURL(/\/table$/);
    // (Each page in front while its table comes up: a page behind others gets no animation frames.)
    await back.bringToFront();
    await tableUp(back);
    await boardSettled(back, sceneId);
    // The same person, character, sheet, place and dice.
    expect(((await hook<{ userId: string }>(back, "me")) as { userId: string }).userId).toBe(daveId);
    await expect
      .poll(async () => (await tokens(back)).find((t) => t.id === mira)?.pos)
      .toEqual({ x: 22, y: 14 });
    await expect
      .poll(
        async () =>
          ((await hook<{ id: string; sheet: unknown }[]>(back, "sheets")) ?? []).find((a) => a.id === actorId)
            ?.sheet,
      )
      .toEqual(sheetBefore?.sheet);
    const skin = async () =>
      JSON.parse(
        ((await hook<{ userId: string; diceSkin: string }[]>(back, "presenceList")) ?? []).find(
          (x) => x.userId === daveId,
        )?.diceSkin ?? "{}",
      ) as { body?: string; material?: string };
    await expect.poll(skin).toMatchObject({ body: "#aa3355", material: "gemstone" });

    // The board as it stood (AC-PER-02): tokens and their HP, combat, the web, the fog painted open.
    await admin.goto(`${gloam.url}/table`);
    await admin.bringToFront();
    await tableUp(admin);
    await boardSettled(admin, sceneId);
    await expect.poll(async () => (await snapshot(admin)).effects).toEqual(before.effects);
    await expect.poll(() => snapshot(admin)).toEqual(before);
    forgiveOutage(guardLog, gloam.url);
  });
});
