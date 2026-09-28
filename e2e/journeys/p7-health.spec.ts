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
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };
const SHOTS = "artifacts/screens/p7";

interface Token {
  id: string;
  name: string;
  actorId: string;
  pos: { x: number; y: number };
  conditions: string[];
  markers: string[];
  exhaustion: number;
  concentrating: boolean;
  dead: boolean;
  hp?: { hp: number; hpMax: number; hpTemp: number };
  own?: { ac: number; budgetFt: number };
}
interface Fx {
  tokenId: string;
  kind: string;
  amount: number;
  parts?: { type: string; amount: number }[];
  dead?: boolean;
  down?: boolean;
}
interface TokenState {
  parts: Record<string, { visible: boolean; status?: string }>;
  lie: number;
}
const tokenOf = (p: Page, id: string) => hook<Token | null>(p, "token", id);
const tokens = (p: Page) => hook<Token[]>(p, "tokens");
const tokenState = (p: Page, id: string) => hook<TokenState | null>(p, "tokenState", id);
const fxLog = (p: Page) => hook<Fx[]>(p, "hpFx");

async function screenOf(p: Page, id: string): Promise<{ x: number; y: number }> {
  await expect.poll(() => tokenState(p, id)).not.toBeNull();
  const t = (await tokenOf(p, id)) as Token;
  const s = await hook<{ sx: number; sy: number }>(p, "project", t.pos.x, t.pos.y, 0.15);
  return { x: s.sx, y: s.sy };
}
async function radial(p: Page, id: string, ...path: string[]): Promise<void> {
  // (The radial opening itself is p2-tokens' to prove; here a slow frame may drop a click — a second one, as a player
  // would.)
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = await screenOf(p, id);
    await p.mouse.click(at.x, at.y, { button: "right" });
    try {
      await p.getByRole("menu").getByRole("menuitem").first().waitFor({ state: "visible", timeout: 4000 });
      break;
    } catch {
      await p.keyboard.press("Escape");
    }
  }
  for (const name of path) await p.getByRole("menuitem", { name, exact: true }).click();
}
/** In front (a page behind another draws no frames: its CSS animations wait), its entrances played. */
async function settle(p: Page): Promise<void> {
  await p.bringToFront();
  await p.evaluate(() =>
    Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 1500)),
    ]),
  );
}
const statusIcons = async (p: Page, id: string) =>
  Object.entries((await tokenState(p, id))?.parts ?? {})
    .filter(([k, v]) => k.startsWith("status:") && v.visible)
    .map(([, v]) => v.status);

test.describe("P7 — HP, conditions and death (§8.11)", () => {
  test.use({ viewport: VIEWPORT });
  test.setTimeout(360_000);

  test("the DM's tools: damage with a preview and the consequences decided in it; conditions from the token menu, the sheet and the DM panel; exhaustion; the hover card; the feedback everyone who sees it gets (AC-HP-04/05/10/11/12, AC-TOK-04/12)", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Barrow",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    const { actorId: thorin } = await req<{ actorId: string }>(admin, "actor.quickCreate", {
      name: "Thorin",
      classLevel: "Fighter 3",
      hpMax: 28,
      ac: 16,
      ownerUserId: daveId,
    });
    const { tokenId: goblin } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Goblin",
      pos: { x: 36, y: 22 },
      disposition: "hostile",
      stats: { hp: 7, hpMax: 7, ac: 13 },
    });
    await expect.poll(async () => (await tokens(admin)).length).toBe(2);
    const hero = ((await tokens(admin)).find((t) => t.actorId === thorin) as Token).id;
    await boardSettled(dave, sceneId);
    await expect.poll(async () => Boolean(await tokenOf(dave, goblin))).toBe(true);

    // ── Damage from the token menu: the preview, and what follows decided before it applies (AC-HP-10, AC-HP-12). ──
    await radial(admin, goblin, "HP", "Damage…");
    const dialog = admin.getByTestId("hp-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Amount 1").fill("9");
    await dialog.getByLabel("Type 1").selectOption("slashing");
    const row = dialog.getByTestId("hp-preview-row");
    await expect(row.getByTestId("hp-preview-hp")).toContainText("7 → 0 / 7 HP");
    await expect(row).toContainText("overflow 2");
    // An NPC at 0: Dead / Unconscious / Keep at 0, Dead preselected (the house rule).
    const follows = row.getByTestId("hp-follows");
    await expect(follows.getByRole("checkbox", { name: "At 0 HP" })).toBeChecked();
    const choice = follows.getByRole("radiogroup", { name: "At 0 HP" });
    await expect(choice.getByRole("radio", { name: "Dead" })).toHaveAttribute("aria-checked", "true");
    await choice.getByRole("radio", { name: "Unconscious" }).click();
    await admin.screenshot({ path: `${SHOTS}/journey-damage-dialog.png` });
    await admin.getByRole("dialog").getByRole("button", { name: "Apply damage" }).click();
    await expect(dialog).toHaveCount(0);
    // A floating number in slashing's colour over the goblin, on Dave's screen as on the DM's (AC-HP-11).
    for (const p of [admin, dave])
      await expect
        .poll(async () =>
          (await hook<{ tokenId: string; text: string; color: string }[]>(p, "hpNumbers")).at(-1),
        )
        .toEqual({ tokenId: goblin, text: "−9", color: "var(--dmg-slashing)" });
    await expect.poll(async () => (await tokenOf(admin, goblin))?.conditions).toEqual(["unconscious"]);
    expect((await tokenOf(admin, goblin))?.dead).toBe(false);
    // Everyone who can see it gets the feedback: the typed number (the damage it took), for the DM and for Dave
    // (AC-HP-11).
    for (const p of [admin, dave])
      await expect
        .poll(async () => (await fxLog(p)).find((f) => f.tokenId === goblin && f.kind === "damage"))
        .toMatchObject({ amount: 9, parts: [{ type: "slashing", amount: 9 }], down: true });
    // Its shake and red flash played on both boards.
    for (const p of [admin, dave])
      await expect
        .poll(async () => (await hook<{ tokenId: string; kind: string }[]>(p, "fxPlayed")).at(-1))
        .toEqual({ tokenId: goblin, kind: "hit" });
    // It falls (unconscious: it lies down, animated), its icon under the plate (AC-TOK-04).
    await expect.poll(async () => (await tokenState(dave, goblin))?.lie).toBeCloseTo(1, 2);
    await expect.poll(() => statusIcons(dave, goblin)).toEqual(["unconscious"]);

    // ── Conditions from the token menu (AC-HP-04): the picker's grid, each with its name and summary. ──
    await radial(admin, goblin, "Conditions");
    const picker = admin.getByTestId("status-picker");
    await expect(picker).toBeVisible();
    await expect(
      picker.getByRole("button", { name: /./ }).filter({ has: admin.locator("[data-icon]") }),
    ).toHaveCount(14 + 16);
    await picker.getByRole("button", { name: "Poisoned", exact: true }).hover();
    await expect(picker.getByTestId("status-summary")).toContainText("Disadvantage on attack rolls");
    await picker.getByRole("button", { name: "Poisoned", exact: true }).click();
    await picker.getByRole("button", { name: "Blessed", exact: true }).click();
    await expect(picker.getByRole("button", { name: "Poisoned", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(async () => (await tokenOf(admin, goblin))?.conditions)
      .toEqual(["unconscious", "poisoned"]);
    await expect.poll(async () => (await tokenOf(admin, goblin))?.markers).toEqual(["blessed"]);
    // Search narrows the grid.
    await picker.getByLabel("Search conditions and markers").fill("speed");
    await expect(picker.getByRole("button", { name: "Grappled", exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Poisoned", exact: true })).toHaveCount(0);
    await admin.screenshot({ path: `${SHOTS}/journey-condition-picker.png` });
    await admin.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await expect.poll(() => statusIcons(dave, goblin)).toEqual(["unconscious", "poisoned", "blessed"]);
    // Six at most under the plate, then "+n" (AC-TOK-04).
    await req(admin, "status.change", {
      tokenId: goblin,
      add: ["blinded", "charmed", "deafened", "frightened", "grappled"].map((id) => ({ id })),
    });
    await expect.poll(async () => (await statusIcons(dave, goblin)).length).toBe(7);
    expect((await statusIcons(dave, goblin)).slice(0, 6)).toEqual([
      "unconscious",
      "poisoned",
      "blinded",
      "charmed",
      "deafened",
      "frightened",
    ]);
    expect((await statusIcons(dave, goblin)).at(-1)).toBe("+2");
    await req(admin, "status.change", {
      tokenId: goblin,
      remove: ["blinded", "charmed", "deafened", "frightened", "grappled"],
    });
    // HP display per token (AC-TOK-04): what Dave's client holds of the DM's goblin in each mode.
    // (Back above 0: the DM keeps what follows — it comes round — in the same breath, no prompt.)
    await req(admin, "hp.apply", {
      targets: [goblin],
      kind: "heal",
      amount: 5,
      decide: { [goblin]: { keep: ["revive"] } },
    });
    type Hp = { hpDisplay: string; hpFrac: number; hpBand: number; hp?: { hp: number } };
    const heldBy = async (mode: string) => {
      await req(admin, "token.update", { tokenId: goblin, hpDisplay: mode });
      await expect.poll(async () => ((await tokenOf(dave, goblin)) as unknown as Hp).hpDisplay).toBe(mode);
      return (await tokenOf(dave, goblin)) as unknown as Hp;
    };
    const exact = await heldBy("exact");
    expect(exact.hp?.hp).toBe(5);
    expect(exact.hpFrac).toBeCloseTo(5 / 7, 5);
    const bar = await heldBy("bar");
    expect(bar.hp).toBeUndefined();
    expect(bar.hpFrac).toBeCloseTo(5 / 7, 5);
    const descriptor = await heldBy("descriptor");
    expect([descriptor.hp, descriptor.hpFrac, descriptor.hpBand]).toEqual([undefined, -1, 3]);
    const hidden = await heldBy("hidden");
    expect([hidden.hp, hidden.hpFrac, hidden.hpBand]).toEqual([undefined, -1, 255]);
    await req(admin, "token.update", { tokenId: goblin, hpDisplay: "bar" });

    // ── From the sheet: Dave on his own character (AC-HP-04). ──
    await dave.getByRole("button", { name: "Sheet", exact: true }).click();
    const sheet = dave.getByTestId("sheet");
    await sheet.getByRole("button", { name: "Add a condition" }).click();
    await dave.getByTestId("status-picker").getByRole("button", { name: "Prone", exact: true }).click();
    await expect.poll(async () => (await tokenOf(dave, hero))?.conditions).toEqual(["prone"]);
    // Exhaustion: its level on the creature; −5 ft a level off its speed; −2 a level off its D20 Tests (AC-HP-05).
    await dave
      .getByTestId("status-picker")
      .getByRole("radiogroup", { name: "Exhaustion level" })
      .getByRole("radio", { name: "2", exact: true })
      .click();
    await expect(dave.getByTestId("status-picker")).toContainText("−4 to D20 Tests · −10 ft speed");
    await expect.poll(async () => (await tokenOf(dave, hero))?.exhaustion).toBe(2);
    await expect.poll(async () => (await tokenOf(dave, hero))?.own?.budgetFt).toBe(20);
    await dave.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await expect(sheet.getByTestId("sheet-conditions")).toContainText("Prone");
    await expect.poll(() => statusIcons(admin, hero)).toEqual(["prone", "exhaustion"]);

    // ── From the DM panel: Health, every creature on the scene (AC-HP-04). ──
    await admin.getByRole("button", { name: /^DM panel/ }).click();
    const panel = admin.getByRole("region", { name: "DM panel", exact: true });
    await panel.getByRole("tab", { name: "Health" }).click();
    const heroRow = panel.locator(`[data-testid="health-row"][data-token="${hero}"]`);
    await expect(heroRow).toContainText("Thorin");
    await heroRow.getByRole("button", { name: "Thorin: conditions" }).click();
    await admin.getByTestId("status-picker").getByRole("button", { name: "Prone", exact: true }).click();
    await expect.poll(async () => (await tokenOf(admin, hero))?.conditions).toEqual([]);
    // Exhaustion 6 asks the DM "Dead?" (AC-HP-05): a decision card over the board.
    await admin
      .getByTestId("status-picker")
      .getByRole("radiogroup", { name: "Exhaustion level" })
      .getByRole("radio", { name: "6", exact: true })
      .click();
    await admin.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    const prompt = admin.getByTestId("dm-prompt");
    await expect(prompt).toContainText("Dead? (Exhaustion 6)");
    await admin.screenshot({ path: `${SHOTS}/journey-dm-prompt.png` });
    await prompt.getByRole("button", { name: "Skip" }).click();
    await expect(prompt).toHaveCount(0);
    expect((await tokenOf(admin, hero))?.dead).toBe(false);
    await req(admin, "status.change", { tokenId: hero, exhaustion: 0 });

    // ── The hover card (AC-TOK-12): after 400 ms; AC for the DM and the owner only. ──
    await admin.bringToFront();
    await admin.keyboard.press("Escape");
    const heroAt = await screenOf(admin, hero);
    await admin.mouse.move(heroAt.x, heroAt.y);
    await expect(admin.getByTestId("hover-card")).toBeVisible();
    // Shown once the pointer had rested 400 ms (measured in the page: a busy test machine can't fake it).
    expect(Number(await admin.getByTestId("hover-card").getAttribute("data-waited"))).toBeGreaterThanOrEqual(
      400,
    );
    await expect(admin.getByTestId("hover-ac")).toHaveText("16");
    // (The card rises in with a CSS animation: settled before the picture — this page in front, so it draws frames.)
    await expect
      .poll(() => admin.getByTestId("hover-card").evaluate((e) => getComputedStyle(e).opacity))
      .toBe("1");
    await admin.screenshot({ path: `${SHOTS}/journey-hover-card.png` });
    await dave.bringToFront();
    const goblinAt = await screenOf(dave, goblin);
    await dave.mouse.move(goblinAt.x, goblinAt.y);
    await expect(dave.getByTestId("hover-card")).toBeVisible();
    await expect(dave.getByTestId("hover-card")).toContainText("Goblin");
    await expect(dave.getByTestId("hover-ac")).toHaveCount(0);
    const heroOnDave = await screenOf(dave, hero);
    await dave.mouse.move(heroOnDave.x, heroOnDave.y);
    await expect(dave.getByTestId("hover-ac")).toHaveText("16");

    // ── Temporary HP don't stack (AC-HP-03): the dialog offers keep or replace, the higher first. ──
    await req(admin, "hp.apply", { targets: [hero], kind: "temp", amount: 5 });
    await admin.bringToFront();
    await admin.keyboard.press("Escape");
    await radial(admin, hero, "HP", "Temporary HP…");
    const td = admin.getByTestId("hp-dialog");
    await td.getByLabel("Temporary HP").fill("8");
    const keepOrTake = td.getByRole("radiogroup", { name: "Temporary HP" });
    await expect(keepOrTake.getByRole("radio", { name: "Take 8" })).toHaveAttribute("aria-checked", "true");
    await expect(keepOrTake.getByRole("radio", { name: "Keep 5" })).toHaveAttribute("aria-checked", "false");
    await admin.getByRole("dialog").getByRole("button", { name: "Give temporary HP" }).click();
    await expect.poll(async () => (await tokenOf(admin, hero))?.hp?.hpTemp).toBe(8);
    // Choosing to keep what's there.
    await radial(admin, hero, "HP", "Temporary HP…");
    await td.getByLabel("Temporary HP").fill("3");
    await td.getByRole("radiogroup", { name: "Temporary HP" }).getByRole("radio", { name: "Keep 8" }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "Give temporary HP" }).click();
    await expect.poll(async () => (await tokenOf(admin, hero))?.hp?.hpTemp).toBe(8);
  });

  test("players: a player's damage waits on the DM; a concentration save and its failure; a condition's disadvantage set aside; dropping to 0 and a death save's natural 20 (AC-HP-07/09/12, AC-DICE-11)", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Crossroads",
      mapKind: "procedural",
      floorStyle: "grass",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    const { actorId: thorin } = await req<{ actorId: string }>(admin, "actor.quickCreate", {
      name: "Thorin",
      classLevel: "Cleric 3",
      hpMax: 24,
      ac: 18,
      ownerUserId: daveId,
    });
    const { tokenId: orc } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Orc",
      pos: { x: 34, y: 20 },
      disposition: "hostile",
      stats: { hp: 15, hpMax: 15, ac: 13 },
    });
    await expect.poll(async () => (await tokens(admin)).length).toBe(2);
    const hero = ((await tokens(admin)).find((t) => t.actorId === thorin) as Token).id;
    await boardSettled(dave, sceneId);
    await expect.poll(async () => Boolean(await tokenOf(dave, orc))).toBe(true);

    // ── Dave's damage to the orc goes to the DM first; the DM makes it 4 (AC-HP-12, house rule). ──
    await radial(dave, orc, "HP", "Damage…");
    const dd = dave.getByTestId("hp-dialog");
    await dd.getByLabel("Amount 1").fill("6");
    await expect(dd.getByTestId("hp-preview-row")).toContainText("The DM confirms it");
    // No numbers of the DM's creature for a player.
    await expect(dd.getByTestId("hp-preview-hp")).toHaveCount(0);
    await dave.getByRole("dialog").getByRole("button", { name: "Send to the DM" }).click();
    await expect(dave.getByText("Sent to the DM to confirm")).toBeVisible();
    const prompt = admin.getByTestId("dm-prompt");
    await expect(prompt).toContainText("Dave's damage to Orc");
    await expect(prompt.getByTestId("hp-preview-hp")).toContainText("15 → 9 / 15 HP");
    await prompt.getByLabel("Orc takes").fill("4");
    await expect(prompt.getByTestId("hp-preview-hp")).toContainText("15 → 11 / 15 HP");
    await prompt.getByRole("button", { name: "Apply" }).click();
    await expect.poll(async () => (await tokenOf(admin, orc))?.hp?.hp).toBe(11);
    await expect(dave.getByText("The DM applied your damage to Orc")).toBeVisible();

    // ── Concentration (AC-HP-07): Dave concentrates on Bless; the DM's 12 damage asks him for a CON save, DC 10. ──
    await radial(dave, hero, "Conditions");
    const picker = dave.getByTestId("status-picker");
    await picker.getByLabel("Concentrating on").fill("Bless");
    await picker.getByRole("button", { name: "Concentrate" }).click();
    await expect.poll(async () => (await tokenOf(dave, hero))?.concentrating).toBe(true);
    await dave.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await radial(admin, hero, "HP", "Damage…");
    const ad = admin.getByTestId("hp-dialog");
    await ad.getByLabel("Amount 1").fill("12");
    await expect(ad.getByTestId("hp-follows")).toContainText("Concentration save, DC 10");
    await admin.getByRole("dialog").getByRole("button", { name: "Apply damage" }).click();
    const card = dave.getByTestId("request-card");
    await expect(dave.getByTestId("request-group")).toContainText("Concentration · Bless");
    await expect(dave.getByTestId("request-group")).toContainText("DC 10");
    await settle(dave);
    await dave.screenshot({ path: `${SHOTS}/journey-concentration-card.png` });
    await card.getByRole("button", { name: "Enter physical roll" }).click();
    await card.getByLabel("Your total").fill("4");
    await card.getByRole("button", { name: "Send" }).click();
    // Failed: the DM confirms it ends (Assist).
    await expect(admin.getByTestId("dm-prompt")).toContainText("Concentration ends (failed the DC 10 save)");
    await admin.getByTestId("dm-prompt").getByRole("button", { name: "Apply" }).click();
    await expect.poll(async () => (await tokenOf(admin, hero))?.concentrating).toBe(false);

    // ── A condition's disadvantage on a requested check, set aside by the roller (AC-DICE-11). ──
    await req(admin, "status.change", { tokenId: hero, add: [{ id: "poisoned" }] });
    await req(admin, "request.create", { targets: [hero], type: "check", ability: "wis" });
    const hint = dave.getByTestId("roll-hint");
    await expect(hint).toContainText("Disadvantage");
    await expect(hint).toContainText("Poisoned");
    await settle(dave);
    await dave.screenshot({ path: `${SHOTS}/journey-roll-hint.png` });
    await hint.getByRole("button", { name: "Set aside" }).click();
    const feed = () => hook<{ formula?: string; label?: string }[]>(dave, "rollFeed");
    const before = (await feed()).length;
    await dave.getByTestId("request-card").getByRole("button", { name: "Roll", exact: true }).click();
    await expect.poll(async () => (await feed()).length).toBeGreaterThan(before);
    expect((await feed())[0]?.formula ?? "").not.toMatch(/dis/);
    await req(admin, "status.change", { tokenId: hero, remove: ["poisoned"] });

    // ── To 0: Unconscious and Prone, death saves (decided in the preview); it falls; a death save's 20 (§8.11). ──
    await radial(admin, hero, "HP", "Damage…");
    await ad.getByLabel("Amount 1").fill("30");
    await expect(
      ad.getByTestId("hp-follows").getByRole("checkbox", { name: /Unconscious and Prone/ }),
    ).toBeChecked();
    await admin.getByRole("dialog").getByRole("button", { name: "Apply damage" }).click();
    await expect.poll(async () => (await tokenOf(admin, hero))?.conditions).toEqual(["unconscious", "prone"]);
    await expect.poll(async () => (await tokenState(dave, hero))?.lie).toBeCloseTo(1, 2);
    await admin.getByRole("button", { name: /^DM panel/ }).click();
    const panel = admin.getByRole("region", { name: "DM panel", exact: true });
    await panel.getByRole("tab", { name: "Health" }).click();
    await panel
      .locator(`[data-testid="health-row"][data-token="${hero}"]`)
      .getByRole("button", { name: "Death save" })
      .click();
    const ds = dave.getByTestId("request-group").filter({ hasText: "Death saving throw" });
    await expect(ds.getByTestId("death-save-pips")).toHaveAttribute(
      "aria-label",
      "0 of 3 successes, 0 of 3 failures",
    );
    await settle(dave);
    await dave.screenshot({ path: `${SHOTS}/journey-death-save.png` });
    await ds.getByRole("button", { name: "Enter physical roll" }).click();
    await ds.getByLabel("Your total").fill("20");
    await ds.getByRole("button", { name: "Send" }).click();
    await expect(dave.getByText("Back on your feet!")).toBeVisible();
    await expect.poll(async () => (await tokenOf(dave, hero))?.hp?.hp).toBe(1);
    // The heal of a natural 20 glows, for Dave and for the DM (AC-HP-11).
    for (const p of [admin, dave])
      await expect
        .poll(async () => (await hook<{ tokenId: string; kind: string }[]>(p, "fxPlayed")).at(-1))
        .toEqual({ tokenId: hero, kind: "heal" });
    await expect.poll(async () => (await tokenOf(dave, hero))?.conditions).toEqual(["prone"]);
  });
});
