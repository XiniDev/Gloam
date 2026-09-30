import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  camera,
  createScene,
  dmSection,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1440, height: 900 };
const PLAYER = { width: 1280, height: 800 };
const SHOTS = "artifacts/screens/p9";

interface P {
  x: number;
  y: number;
}
interface Token {
  id: string;
  actorId: string;
  name: string;
  pos: P;
  hp?: { hp: number; hpMax: number };
}
const tokens = (p: Page) => hook<Token[]>(p, "tokens");
const idOf = async (p: Page) => (await hook<{ userId: string }>(p, "me")).userId;

/** The screen point of a table point (the test hook), for the pointer. */
async function screen(p: Page, x: number, y: number, elevation = 0.15) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, elevation)) as {
    sx: number;
    sy: number;
  };
  return { x: s.sx, y: s.sy };
}

/** Opens a dock panel from its rail (it stays open if it already is). */
async function openDock(p: Page, name: "Sheet" | "Party" | "DM panel") {
  const panel = { Sheet: "Character sheet", Party: "Party", "DM panel": "DM panel" }[name];
  const aside = p.getByRole("region", { name: panel, exact: true });
  const button =
    name === "DM panel"
      ? p.getByRole("button", { name: /^DM panel/ })
      : p.getByRole("button", { name, exact: true });
  if (!(await aside.isVisible())) await button.click();
  await expect(aside).toBeVisible();
  return aside;
}

/** Opens a section of the sheet: its tab, or (when the row has no room for it) from the "…" menu. */
async function sheetTab(p: Page, name: string) {
  const sheet = p.getByTestId("sheet");
  const tab = sheet.getByRole("tab", { name, exact: true });
  if (await tab.count()) await tab.click();
  else {
    await sheet.getByRole("button", { name: "More sections" }).click();
    await p.getByRole("menuitem", { name, exact: true }).click();
  }
  await expect(sheet.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  return p.getByTestId(`sheet-tab-${name.toLowerCase()}`);
}

/** The SRD pack's spells, as the server loads them (an oracle for the browser's filters). */
interface PackSpell {
  id: string;
  name: string;
  level: number;
  school: string;
  classes?: string[];
  castingTime: { unit: string };
  duration: { concentration: boolean };
  ritual?: boolean;
  damage?: { type: string; typeOptions?: string[] }[];
  save?: { ability: string };
  area?: { shape: string } | null;
  areaAlternatives?: { area: { shape: string } }[];
}
function packSpells(): PackSpell[] {
  const raw = JSON.parse(readFileSync("packages/content/packs/srd-5.2.1/spells.json", "utf8"));
  return (Array.isArray(raw) ? raw : raw.spells) as PackSpell[];
}

/** A wizard for Dave: level 5, Intelligence 18 (DC 15, +7), slots 4 / 3 / 2, Fireball, Web, See Invisibility. */
function wizardSheet() {
  return {
    core: {
      name: "Mira",
      classes: [{ name: "Wizard", level: 5 }],
      abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
      hp: { max: 28, current: 28, temp: 0 },
      ac: { value: 12 },
      spellcasting: {
        ability: "int",
        slots: [
          { level: 1, max: 4 },
          { level: 2, max: 3 },
          { level: 3, max: 2 },
        ],
        spells: [
          { name: "Fireball", level: 3, prepared: true },
          { name: "Web", level: 2, prepared: true },
          { name: "See Invisibility", level: 2, prepared: true },
          { name: "Blur", level: 2, prepared: true },
          { name: "Magic Missile", level: 1, prepared: true },
          { name: "Hold Person", level: 2, prepared: true },
        ],
      },
      attacks: [
        { name: "Dagger", attack: "1d20 + @dex + @prof", damage: "1d4 + @dex [piercing]", range: "20/60" },
      ],
    },
  };
}

/** Dave's wizard Mira on a field with goblins (and a wall), the camera over it. */
async function wizardScene(
  admin: Page,
  browser: Parameters<typeof admitPlayer>[1],
  gloam: Parameters<typeof admitPlayer>[2],
  guardLog: Parameters<typeof admitPlayer>[3],
) {
  const code = await adminAtTable(admin);
  await introDone(admin);
  const sceneId = await createScene(admin, {
    name: "Crossroads",
    mapKind: "procedural",
    floorStyle: "grass",
    widthFt: 120,
    heightFt: 60,
  });
  await boardSettled(admin, sceneId);
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: PLAYER });
  await boardSettled(dave, sceneId);
  const { actorId } = await req<{ actorId: string }>(dave, "actor.create", {
    ownerUserId: await idOf(dave),
    sheet: wizardSheet(),
  });
  await expect.poll(async () => (await tokens(admin)).some((t) => t.actorId === actorId)).toBe(true);
  const mira = (await tokens(admin)).find((t) => t.actorId === actorId) as Token;
  await req(admin, "move.commit", { tokenId: mira.id, points: [mira.pos, { x: 15, y: 30 }] });
  const goblin = async (name: string, pos: P) =>
    (
      await req<{ tokenId: string }>(admin, "token.create", {
        sceneId,
        name,
        pos,
        disposition: "hostile",
        stats: { hp: 30, hpMax: 30, ac: 13, saves: { dex: 2, wis: 0 } },
      })
    ).tokenId;
  await boardSettled(dave, sceneId);
  return { sceneId, dave, actorId, mira: mira.id, goblin };
}

/** Casts one of Mira's spells from Dave's sheet: its row's Cast, a slot, then the dialog's go button. */
async function castFromSheet(dave: Page, spell: string, slot: RegExp | null, go: string) {
  await openDock(dave, "Sheet");
  const tab = await sheetTab(dave, "Spells");
  await tab.getByTestId("sheet-spell").filter({ hasText: spell }).getByTestId("cast-spell").click();
  const dialog = dave.getByRole("dialog", { name: new RegExp(`Cast ${spell}`) });
  await expect(dialog).toBeVisible();
  if (slot) await dialog.getByRole("radio", { name: slot }).click();
  await dialog.getByRole("button", { name: go }).click();
  return dialog;
}

test.describe("P9 — spells (SPL)", () => {
  test.use({ viewport: VIEWPORT });
  test.setTimeout(360_000);

  test("AC-SPL-02: the spell browser searches by name and text and filters by level, school, class, casting time, concentration, ritual, damage type, save and area shape — its counts the pack's", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Library",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 30,
    });
    await boardSettled(admin, sceneId);
    await dmSection(admin, "Spells");
    const panel = admin.getByTestId("spells-panel");
    await panel.getByRole("button", { name: "Browse spells" }).click();
    const browser = admin.getByTestId("spell-browser");
    await expect(browser.getByTestId("spell-count")).toHaveText("339 spells");
    const all = packSpells();
    const count = async () => Number((await browser.getByTestId("spell-count").innerText()).split(" ")[0]);
    // Search: by name first (Fireball leads a search for "fireball"), and by what the text says.
    await browser.getByTestId("spell-search").fill("fireball");
    await expect(browser.getByTestId("spell-row").first()).toHaveAttribute("data-spell", "fireball");
    await browser.getByTestId("spell-search").fill("");
    await browser.getByRole("button", { name: "Filters" }).click();
    const filters = browser.getByTestId("spell-filters");
    const chip = (group: string, name: string) =>
      filters.getByRole("group", { name: group }).getByRole("button", { name, exact: true });
    // Level 3 · Evocation · Wizard.
    await chip("Level", "3").click();
    await chip("School", "Evocation").click();
    await chip("Class", "Wizard").click();
    const l3 = all.filter(
      (s) => s.level === 3 && s.school === "evocation" && (s.classes ?? []).includes("wizard"),
    );
    await expect.poll(count).toBe(l3.length);
    // …that deal fire, with a Dexterity save, in a sphere: Fireball among them.
    await chip("Damage", "Fire").click();
    await chip("Save", "DEX").click();
    await chip("Area", "Sphere").click();
    const fire = l3.filter(
      (s) =>
        (s.damage ?? []).some((d) => d.type === "fire" || (d.typeOptions ?? []).includes("fire")) &&
        s.save?.ability === "dex" &&
        s.area?.shape === "sphere",
    );
    await expect.poll(count).toBe(fire.length);
    await expect(browser.locator('[data-testid="spell-row"][data-spell="fireball"]')).toBeVisible();
    await browser.getByRole("button", { name: "Clear the filters" }).click();
    // Concentration, ritual, casting time: each against the pack.
    await chip("Concentration · ritual", "Ritual").click();
    await expect.poll(count).toBe(all.filter((s) => s.ritual).length);
    await browser.getByRole("button", { name: "Clear the filters" }).click();
    await chip("Concentration · ritual", "Concentration").click();
    await chip("Casting time", "Bonus").click();
    await expect
      .poll(count)
      .toBe(all.filter((s) => s.duration.concentration && s.castingTime.unit === "bonus").length);
    await browser.getByRole("button", { name: "Clear the filters" }).click();
    await chip("Area", "Emanation").click();
    // An area shape finds the spells that can take it — their other forms too (Darkness on an object: an Emanation).
    await expect
      .poll(count)
      .toBe(
        all.filter(
          (s) =>
            s.area?.shape === "emanation" ||
            (s.areaAlternatives ?? []).some((a) => a.area.shape === "emanation"),
        ).length,
      );
    // A spell picked: its card beside the list.
    await browser.getByTestId("spell-row").first().click();
    await expect(browser.getByTestId("spell-shown")).toBeVisible();
    await admin.screenshot({ path: `${SHOTS}/spell-browser.png` });
  });

  test("AC-SPL-03/04/05/06: Dave casts Fireball from his sheet — the slot (upcast shown), the template with its range ring following the pointer, a click to cast; the DM's card takes the goblins in it (not the one behind the wall — added anyway, then left out), rolls their saves with one click; Dave rolls the damage; Apply all takes it off them; the slot is spent", async ({
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
      widthFt: 120,
      heightFt: 60,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: PLAYER });
    await boardSettled(dave, sceneId);
    const { actorId } = await req<{ actorId: string }>(dave, "actor.create", {
      ownerUserId: await idOf(dave),
      sheet: wizardSheet(),
    });
    await expect.poll(async () => (await tokens(admin)).some((t) => t.actorId === actorId)).toBe(true);
    const mira = (await tokens(admin)).find((t) => t.actorId === actorId) as Token;
    await req(admin, "move.commit", { tokenId: mira.id, points: [mira.pos, { x: 15, y: 30 }] });
    const goblin = async (name: string, pos: P) =>
      (
        await req<{ tokenId: string }>(admin, "token.create", {
          sceneId,
          name,
          pos,
          disposition: "hostile",
          stats: { hp: 30, hpMax: 30, ac: 13, saves: { dex: 2 } },
        })
      ).tokenId;
    const g1 = await goblin("Goblin", { x: 70, y: 30 });
    const g2 = await goblin("Goblin 2", { x: 76, y: 34 });
    const behind = await goblin("Goblin 3", { x: 74, y: 16 });
    await req(admin, "wall.create", {
      sceneId,
      walls: [{ a: { x: 64, y: 21 }, b: { x: 84, y: 21 }, kind: "wall" }],
    });
    await boardSettled(dave, sceneId);
    await camera(dave, { pitchDeg: 70, frame: { minX: 5, minY: 5, maxX: 100, maxY: 55 } });
    await dave.waitForTimeout(300);

    // The sheet → Spells → Cast on Fireball: the slot, 3rd; the 4th shows its dice grown.
    await openDock(dave, "Sheet");
    const tab = await sheetTab(dave, "Spells");
    await tab.getByTestId("sheet-spell").filter({ hasText: "Fireball" }).getByTestId("cast-spell").click();
    const dialog = dave.getByTestId("cast-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: /3rd/ }).click();
    await expect(dave.getByRole("dialog", { name: /Cast Fireball/ })).toContainText("8d6");
    await dave
      .getByRole("dialog", { name: /Cast Fireball/ })
      .getByRole("button", { name: "Place on the board" })
      .click();
    // Aiming: the template follows the pointer; a range ring round Mira; a click casts.
    await expect(dave.getByTestId("targeting-bar")).toBeVisible();
    const aim = await screen(dave, 72, 32, 0);
    await dave.mouse.move(aim.x - 30, aim.y);
    await dave.mouse.move(aim.x, aim.y, { steps: 4 });
    await expect
      .poll(async () => (await hook<{ at: P | null } | null>(dave, "targeting"))?.at?.x ?? 0)
      .toBeGreaterThan(65);
    // What it would take, as Dave's client sees it: the two goblins; the third behind the wall.
    await expect
      .poll(async () => (await hook<{ inside: string[] } | null>(dave, "targeting"))?.inside?.sort())
      .toEqual([g1, g2].sort());
    expect((await hook<{ ring: boolean }>(dave, "targeting")).ring).toBe(true);
    await dave.screenshot({ path: `${SHOTS}/fireball-aim.png` });
    await dave.mouse.click(aim.x, aim.y);
    await expect(dave.getByTestId("targeting-bar")).toBeHidden();

    // The DM's card: both goblins in the sphere; the third blocked by the wall.
    await admin.bringToFront();
    const card = admin.getByTestId("resolution-card").filter({ hasText: "Fireball" });
    await expect(card).toBeVisible();
    const row = (id: string) => card.locator(`[data-testid="cast-target"][data-token="${id}"]`);
    await expect(row(g1)).toHaveAttribute("data-state", "in");
    await expect(row(g2)).toHaveAttribute("data-state", "in");
    await expect(row(behind)).toHaveAttribute("data-state", "blocked");
    // Added anyway, then left out again (AC-SPL-04).
    await row(behind).getByRole("button", { name: "Add anyway" }).click();
    await expect(row(behind)).toHaveAttribute("data-state", "in");
    await row(behind).getByRole("button", { name: "More on Goblin 3" }).click();
    await row(behind).getByRole("button", { name: "Leave out" }).click();
    await expect(row(behind)).toHaveAttribute("data-state", "removed");
    // NPC saves: one click.
    await card.getByRole("button", { name: "Roll NPC saves" }).click();
    await expect(row(g1).getByTestId("save-result")).toBeVisible();
    await expect(row(g2).getByTestId("save-result")).toBeVisible();
    await admin.screenshot({ path: `${SHOTS}/fireball-card-dm.png` });

    // Dave rolls the damage on his card.
    await dave.bringToFront();
    const his = dave.getByTestId("resolution-card").filter({ hasText: "Fireball" });
    await his.getByRole("button", { name: "Roll" }).first().click();
    await expect(his.getByTestId("cast-rolled")).toBeVisible();
    const rolled = Number((await his.getByTestId("cast-rolled").innerText()).replace(/\D+/g, " ").trim());
    expect(rolled).toBeGreaterThanOrEqual(8);
    expect(rolled).toBeLessThanOrEqual(48);
    // Nothing more asked of him, he hides his card (a close control of his own, as the DM's X): gone from his screen,
    // still the DM's.
    await his.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(his).toBeHidden();

    // The DM applies it all: each goblin down by all or half of it, by its save.
    await admin.bringToFront();
    await expect(card.getByTestId("cast-rolled")).toBeVisible();
    const saved = async (id: string) =>
      (await row(id).getByTestId("save-result").getAttribute("data-success")) === "true";
    const expectHp = async (id: string) => 30 - ((await saved(id)) ? Math.floor(rolled / 2) : rolled);
    const want = { [g1]: await expectHp(g1), [g2]: await expectHp(g2) };
    await card.getByRole("button", { name: /^Apply( all)?$/ }).click();
    for (const id of [g1, g2])
      await expect
        .poll(async () => (await tokens(admin)).find((t) => t.id === id)?.hp?.hp)
        .toBe(Math.max(0, want[id] as number));
    // The 3rd-level slot is spent (AC-SPL-06).
    await dave.bringToFront();
    const slots = dave.getByTestId("spell-slots");
    await expect(slots.locator("div").filter({ hasText: "3rd" }).first()).toContainText("1 of");
  });

  test("AC-SPL-03/07: Magic Missile at 2nd level — four darts, two at the same goblin (a repeated pick), cast when the last is picked; a self spell (See Invisibility) takes effect at once; an area's point behind a wall is refused on the bar; a second concentration spell asks to end the first, and ending it takes its web away", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const { dave, goblin, mira } = await wizardScene(admin, browser, gloam, guardLog);
    const g1 = await goblin("Goblin", { x: 45, y: 26 });
    const g2 = await goblin("Goblin 2", { x: 50, y: 36 });
    await req(admin, "wall.create", {
      sceneId: (await hook<{ id: string }>(admin, "scene")).id,
      walls: [{ a: { x: 70, y: 5 }, b: { x: 70, y: 55 }, kind: "wall" }],
    });
    await camera(dave, { pitchDeg: 70, frame: { minX: 5, minY: 5, maxX: 100, maxY: 55 } });
    await dave.waitForTimeout(300);
    const click = async (at: P) => {
      const q = await screen(dave, at.x, at.y, 0.3);
      await dave.mouse.click(q.x, q.y);
    };

    // Magic Missile, 2nd-level slot: 4 darts (3 + 1 a slot level).
    await castFromSheet(dave, "Magic Missile", /2nd/, "Choose targets");
    const bar = dave.getByTestId("targeting-bar");
    // The darts counted at the bar's left; a creature picked twice marked ×2 by it on the board.
    await expect(bar.getByTestId("targeting-picks")).toContainText("0 / 4");
    await expect(bar.getByTestId("targeting-picks")).toContainText("darts");
    await click({ x: 45, y: 26 });
    await click({ x: 45, y: 26 });
    await expect(dave.getByTestId("pick-count")).toHaveText("×2");
    await click({ x: 50, y: 36 });
    await expect(bar.getByTestId("targeting-picks")).toContainText("3 / 4");
    await expect(dave.getByTestId("pick-count")).toHaveCount(1);
    await dave.screenshot({ path: `${SHOTS}/darts-picking.png` });
    await click({ x: 50, y: 36 });
    await expect(bar).toBeHidden();
    // The DM's card: each goblin once, two darts each.
    const card = admin.getByTestId("resolution-card").filter({ hasText: "Magic Missile" });
    await expect(card).toBeVisible();
    for (const id of [g1, g2])
      await expect(card.locator(`[data-testid="cast-target"][data-token="${id}"]`)).toContainText("×2");

    // See Invisibility (self): no aiming — on Mira at once.
    await castFromSheet(dave, "See Invisibility", /2nd/, "Cast");
    await expect
      .poll(async () =>
        (await hook<{ id: string; name: string }[]>(admin, "effectsDrawn")).some(
          (e) => e.name === "See Invisibility",
        ),
      )
      .toBe(true);
    await expect(dave.getByTestId("targeting-bar")).toBeHidden();
    void mira;

    // Web aimed past its 60-ft range, then in range but behind the wall (no clear line from Mira): the bar says why
    // each time, and a click there doesn't cast.
    await castFromSheet(dave, "Web", /2nd/, "Place on the board");
    const far = await screen(dave, 85, 30, 0);
    await dave.mouse.move(far.x - 10, far.y);
    await dave.mouse.move(far.x, far.y, { steps: 3 });
    await expect(bar.getByTestId("targeting-why")).toHaveText(/range/i);
    const behind = await screen(dave, 73, 30, 0);
    await dave.mouse.move(behind.x, behind.y, { steps: 3 });
    await expect(bar.getByTestId("targeting-why")).toHaveText(/clear|line|wall/i);
    await dave.mouse.click(behind.x, behind.y);
    await expect(bar).toBeVisible();
    // The reason stays in the bar — no toast repeats it over the board (critic P9 r2 B2).
    await dave.waitForTimeout(400);
    await expect(dave.getByText(/Couldn't cast/)).toHaveCount(0);
    await expect(bar.getByTestId("targeting-why")).toHaveText(/clear|line|wall/i);
    await dave.screenshot({ path: `${SHOTS}/web-blocked.png` });
    // In the open: cast.
    const open = await screen(dave, 40, 45, 0);
    await dave.mouse.move(open.x, open.y, { steps: 3 });
    await expect(bar.getByTestId("targeting-why")).toBeHidden();
    await dave.mouse.click(open.x, open.y);
    await expect(bar).toBeHidden();
    await expect
      .poll(async () => (await hook<{ name: string }[]>(admin, "effectsDrawn")).some((e) => e.name === "Web"))
      .toBe(true);

    // Blur (concentration) while the Web holds: asked first; "End it and cast" — the web goes.
    await castFromSheet(dave, "Blur", /3rd/, "Cast"); // (her three 2nd-level slots are spent)
    const ask = dave.getByRole("dialog", { name: "End concentration?" });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("Web");
    await expect(ask).toContainText("the Web on the board goes too");
    await dave.screenshot({ path: `${SHOTS}/concentration-ask.png` });
    await ask.getByRole("button", { name: "End it and cast" }).click();
    await expect
      .poll(async () => (await hook<{ name: string }[]>(admin, "effectsDrawn")).some((e) => e.name === "Web"))
      .toBe(false);
  });

  test("AC-SPL-05/12/13: Dave's dagger through the same card — he rolls to hit, the DM calls it a hit, he rolls its damage, the DM edits the number and applies it; the goblin half behind a wall shows its cover hint on the card; Hold Person: the goblin fails its save and the card lands Paralyzed; a Magic Missile cancelled gives its slot back; a skipped target takes nothing", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const { dave, goblin, sceneId, actorId } = await wizardScene(admin, browser, gloam, guardLog);
    const g1 = await goblin("Goblin", { x: 30, y: 30 });
    // Goblin 2 stands just past the end of a wall across Mira's line to it: part of it covered. Goblin 3 is behind
    // it altogether.
    const g2 = await goblin("Goblin 2", { x: 45, y: 42 });
    await goblin("Goblin 3", { x: 45, y: 52 });
    await req(admin, "wall.create", {
      sceneId,
      walls: [{ a: { x: 35, y: 38.5 }, b: { x: 35, y: 58 }, kind: "wall" }],
    });
    await camera(dave, { pitchDeg: 70, frame: { minX: 5, minY: 10, maxX: 60, maxY: 55 } });
    await dave.waitForTimeout(300);
    const clickAt = async (at: P) => {
      const q = await screen(dave, at.x, at.y, 0.3);
      await dave.mouse.click(q.x, q.y);
    };

    // The dagger (Actions → Attack…) at the goblin: the same card, an attack step.
    await openDock(dave, "Sheet");
    const actions = await sheetTab(dave, "Actions");
    await actions.getByTestId("attack-at").first().click();
    await expect(dave.getByTestId("targeting-bar")).toContainText("Dagger");
    await clickAt({ x: 30, y: 30 });
    const his = dave.getByTestId("resolution-card").filter({ hasText: "Dagger" });
    await expect(his).toBeVisible();
    const hisRow = his.locator(`[data-testid="cast-target"][data-token="${g1}"]`);
    // Mira holds Heroic Inspiration (rules audit C4): the d20 on the card can be rolled again, once, before it's applied.
    await req(admin, "actor.change", { actorId, changes: [{ path: ["core", "inspiration"], after: true }] });
    await hisRow.getByRole("button", { name: "Attack" }).click();
    await expect(hisRow.getByTestId("attack-result")).toBeVisible();
    const again = hisRow.getByRole("button", { name: /^Reroll the d20 \(\d+\)$/ });
    await expect(again).toHaveCount(1);
    await dave.screenshot({ path: `${SHOTS}/attack-inspiration.png` });
    await again.click();
    await expect(again).toHaveCount(0);
    await expect(hisRow.getByTestId("attack-inspired")).toBeVisible();
    // The DM calls it a hit (whatever the die said), and Dave rolls its damage.
    const card = admin.getByTestId("resolution-card").filter({ hasText: "Dagger" });
    const row = card.locator(`[data-testid="cast-target"][data-token="${g1}"]`);
    await expect(row.getByTestId("attack-result")).toContainText(/hit|miss/);
    await row.getByRole("button", { name: "More on Goblin" }).click();
    await row.getByRole("button", { name: "Hit" }).click();
    await expect(row.getByTestId("attack-result")).toContainText("hit");
    await hisRow.getByRole("button", { name: "Roll" }).click();
    await expect(row.getByText(/rolled \d+/)).toBeVisible();
    // The DM's own number (editable finals, §8.13): 7, applied.
    const final = row.getByLabel("What Goblin takes");
    await final.fill("7");
    await final.press("Enter");
    await card
      .getByRole("button", { name: /^Apply/ })
      .last()
      .click();
    await expect.poll(async () => (await tokens(admin)).find((t) => t.id === g1)?.hp?.hp).toBe(23);
    await admin.screenshot({ path: `${SHOTS}/dagger-card-dm.png` });

    // Hold Person at Goblin 2, behind the wall's end: the cover hint on the card; it fails; Paralyzed lands.
    await castFromSheet(dave, "Hold Person", /2nd/, "Choose the target");
    // Goblin 3 first: behind total cover — refused on the bar, the pick not taken.
    await clickAt({ x: 45, y: 52 });
    await expect(dave.getByTestId("targeting-why")).toHaveText(/total cover/);
    await expect(dave.getByTestId("targeting-picks")).toContainText("0 / 1");
    await clickAt({ x: 45, y: 42 });
    const hold = admin.getByTestId("resolution-card").filter({ hasText: "Hold Person" });
    const held = hold.locator(`[data-testid="cast-target"][data-token="${g2}"]`);
    await expect(held).toBeVisible();
    await expect(held).toContainText(/cover · \+\d AC/);
    await expect(hold.getByTestId("cover-note")).toBeVisible();
    await held.getByRole("button", { name: "More on Goblin 2" }).click();
    await held.getByRole("button", { name: "Failed" }).click();
    await expect(held.getByRole("checkbox", { name: "Paralyzed" })).toBeChecked();
    await admin.screenshot({ path: `${SHOTS}/hold-person-card.png` });
    await hold
      .getByRole("button", { name: /^Apply/ })
      .last()
      .click();
    await expect
      .poll(async () => (await hook<{ conditions: string[] }>(admin, "token", g2))?.conditions)
      .toContain("paralyzed");

    // Magic Missile at the goblin, cancelled by Dave: the slot comes back.
    const slots = dave.getByTestId("spell-slots").locator("div").filter({ hasText: "1st" }).first();
    await expect(slots).toContainText("4 of");
    await castFromSheet(dave, "Magic Missile", /1st/, "Choose targets");
    for (let i = 0; i < 3; i++) await clickAt({ x: 30, y: 30 });
    await expect(slots).toContainText("3 of");
    const mm = dave.getByTestId("resolution-card").filter({ hasText: "Magic Missile" });
    await mm.getByRole("button", { name: "Cancel & refund slot" }).click();
    await expect(slots).toContainText("4 of");
    await expect(mm).toBeHidden();

    // Skip: a second Hold Person (the first one's concentration ended for it), its target left with nothing.
    await castFromSheet(dave, "Hold Person", /2nd/, "Choose the target");
    await clickAt({ x: 30, y: 30 });
    // Asked in the bar itself, where it's aimed (a modal hid what it was about): End it and cast.
    const inline = dave.getByTestId("targeting-bar").getByRole("group", { name: "End concentration?" });
    await expect(inline).toContainText("Hold Person");
    await inline.getByRole("button", { name: "End it and cast" }).click();
    // The first one's Paralyzed ends with it.
    await expect
      .poll(async () => (await hook<{ conditions: string[] }>(admin, "token", g2))?.conditions)
      .not.toContain("paralyzed");
    const skip = admin
      .getByTestId("resolution-card")
      .filter({ hasText: "Hold Person" })
      .filter({ has: admin.locator(`[data-testid="cast-target"][data-token="${g1}"]`) });
    const sRow = skip.locator(`[data-testid="cast-target"][data-token="${g1}"]`);
    await sRow.getByRole("button", { name: "More on Goblin" }).click();
    await sRow.getByRole("button", { name: "Skip" }).click();
    // Its only target skipped, the card is done and leaves the table; the goblin takes nothing.
    await expect(skip).toBeHidden();
    expect((await hook<{ conditions: string[] }>(admin, "token", g1))?.conditions ?? []).not.toContain(
      "paralyzed",
    );
  });

  test("rules audit Q6: Haste, Bless and Bane on the table — Mira's sheet gives her AC and Speed under Haste; her dagger entered by hand asks for Bless's d4 too; the DM's card ticks Baned on a failed save, and unticked it doesn't land", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const { dave, goblin, mira } = await wizardScene(admin, browser, gloam, guardLog);
    const g1 = await goblin("Goblin", { x: 30, y: 30 });
    const priest = await goblin("Priest", { x: 20, y: 50 });
    const shaman = await goblin("Shaman", { x: 30, y: 50 });
    const hexer = await goblin("Hexer", { x: 40, y: 50 });
    await camera(dave, { pitchDeg: 70, frame: { minX: 5, minY: 10, maxX: 60, maxY: 55 } });
    await dave.waitForTimeout(300);

    // Haste on Mira: her sheet says AC now 14 (her own 12 stays editable) and Speed 60 ft (base 30).
    await req(admin, "spell.cast", {
      casterTokenId: shaman,
      spellId: "haste",
      mode: "free",
      level: 3,
      targets: [mira],
    });
    await openDock(dave, "Sheet");
    await expect(dave.getByTestId("sheet-ac-now")).toHaveText("now 14");
    await expect(dave.getByTestId("sheet-speed")).toHaveText("60 ft");
    await expect(dave.getByTestId("sheet-speed-base")).toHaveText("base 30");

    // Bless on Mira: her dagger's hints say +1d4; entered by hand, it asks for the d20 and Bless's d4.
    await req(admin, "spell.cast", {
      casterTokenId: priest,
      spellId: "bless",
      mode: "free",
      level: 1,
      targets: [mira],
    });
    const actions = await sheetTab(dave, "Actions");
    await actions.getByTestId("attack-at").first().click();
    const q = await screen(dave, 30, 30, 0.3);
    await dave.mouse.click(q.x, q.y);
    const his = dave.getByTestId("resolution-card").filter({ hasText: "Dagger" });
    const hisRow = his.locator(`[data-testid="cast-target"][data-token="${g1}"]`);
    await expect(hisRow.getByTestId("attack-hints")).toContainText("+1d4 from Blessed");
    await hisRow.getByRole("button", { name: "Enter…" }).click();
    await hisRow.getByLabel("d20 rolled").fill("11");
    await hisRow.getByLabel("d4 rolled (Blessed)").fill("3");
    await dave.screenshot({ path: `${SHOTS}/q6-bless-entry.png` });
    await hisRow.getByRole("button", { name: "Enter", exact: true }).click();
    // 11 + 5 (Dex and proficiency) + 3.
    await expect(hisRow.getByTestId("attack-result")).toContainText(/^19/);
    await req(admin, "cast.close", {
      castId: (await hook<{ id: string; name: string }[]>(admin, "casts")).find((c) => c.name === "Dagger")
        ?.id,
    });

    // Bane at two goblins: the DM's card has Baned beside each save; failed, it's ticked; the one unticked gets nothing.
    await req(admin, "spell.cast", {
      casterTokenId: hexer,
      spellId: "bane",
      mode: "free",
      level: 1,
      targets: [g1, priest],
    });
    const card = admin.getByTestId("resolution-card").filter({ hasText: "Bane" });
    const rowOf = (id: string) => card.locator(`[data-testid="cast-target"][data-token="${id}"]`);
    for (const [id, name] of [
      [g1, "Goblin"],
      [priest, "Priest"],
    ] as const) {
      await rowOf(id)
        .getByRole("button", { name: `More on ${name}` })
        .click();
      await rowOf(id).getByRole("button", { name: "Failed" }).click();
      await expect(rowOf(id).getByRole("checkbox", { name: "Baned" })).toBeChecked();
    }
    await admin.screenshot({ path: `${SHOTS}/q6-bane-card.png` });
    // (One row's details open at a time: the goblin's again.)
    await rowOf(g1).getByRole("button", { name: "More on Goblin" }).click();
    await rowOf(g1).getByRole("checkbox", { name: "Baned" }).uncheck();
    await expect(rowOf(g1).getByRole("checkbox", { name: "Baned" })).not.toBeChecked();
    await card
      .getByRole("button", { name: /^Apply/ })
      .last()
      .click();
    await expect
      .poll(async () => (await hook<{ markers: string[] }>(admin, "token", priest))?.markers)
      .toContain("baned");
    expect((await hook<{ markers: string[] }>(admin, "token", g1))?.markers ?? []).not.toContain("baned");
  });

  test("AC-SPL-05/08/13: a cultist's Fireball catches Mira — Dave's own save card, his roll on the DM's card; a Cure Wounds heals her through a card; the dagger at a goblin half behind a wall shows the cover hint on the attack card; Mira's Moonbeam dragged by its handle (no further than 60 ft); Call Lightning struck again at a point under its cloud", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const { dave, goblin, sceneId, mira } = await wizardScene(admin, browser, gloam, guardLog);
    const g1 = await goblin("Goblin", { x: 45, y: 42 });
    await req(admin, "wall.create", {
      sceneId,
      walls: [{ a: { x: 35, y: 38.5 }, b: { x: 35, y: 58 }, kind: "wall" }],
    });
    const { tokenId: cultist } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Cultist",
      pos: { x: 100, y: 10 },
      disposition: "hostile",
      stats: { hp: 9, hpMax: 9, ac: 12 },
    });
    await camera(dave, { pitchDeg: 70, frame: { minX: 0, minY: 0, maxX: 110, maxY: 60 } });
    await dave.waitForTimeout(300);

    // The cultist's Fireball on Mira (the DM casts it, free): Dave's save card — he rolls; the DM's card shows it.
    await req(admin, "spell.cast", {
      casterTokenId: cultist,
      spellId: "fireball",
      mode: "free",
      level: 3,
      placement: { origin: { x: 15, y: 30, z: 0 } },
    });
    const saveCard = dave.getByTestId("request-group").filter({ hasText: "Fireball" });
    await expect(saveCard).toBeVisible();
    await expect(saveCard).toContainText(/Dexterity|DEX/);
    await saveCard.getByRole("button", { name: "Roll", exact: true }).click();
    const fb = admin.getByTestId("resolution-card").filter({ hasText: "Fireball" });
    const miraRow = fb.locator(`[data-testid="cast-target"][data-token="${mira}"]`);
    await expect(miraRow.getByTestId("save-result")).toBeVisible();
    await fb.getByRole("button", { name: "Enter…" }).click();
    await fb.getByLabel("Damage total").fill("10");
    await fb.getByLabel("Damage total").press("Enter");
    await fb
      .getByRole("button", { name: /^Apply/ })
      .last()
      .click();
    const hpOf = async (id: string) => (await tokens(admin)).find((t) => t.id === id)?.hp?.hp;
    await expect.poll(() => hpOf(mira)).toBeLessThan(28);
    const hurt = (await hpOf(mira)) as number;

    // Cure Wounds on her (the DM casts it for the cultist, free: a card with its healing).
    await req(admin, "spell.cast", {
      casterTokenId: cultist,
      spellId: "cure-wounds",
      mode: "free",
      level: 1,
      targets: [mira],
    });
    const cw = admin.getByTestId("resolution-card").filter({ hasText: "Cure Wounds" });
    await expect(cw).toContainText("Healing");
    await cw.getByRole("button", { name: "Roll" }).first().click();
    await expect(cw.getByTestId("cast-rolled")).toBeVisible();
    await cw
      .getByRole("button", { name: /^Apply/ })
      .last()
      .click();
    await expect.poll(() => hpOf(mira)).toBeGreaterThan(hurt);

    // The dagger at the goblin half behind the wall's end: the attack card shows the cover hint.
    await openDock(dave, "Sheet");
    const actions = await sheetTab(dave, "Actions");
    await actions.getByTestId("attack-at").first().click();
    const gAt = await screen(dave, 45, 42, 0.3);
    await dave.mouse.click(gAt.x, gAt.y);
    const dag = admin.getByTestId("resolution-card").filter({ hasText: "Dagger" });
    await expect(dag.locator(`[data-testid="cast-target"][data-token="${g1}"]`)).toContainText(
      /cover · \+\d AC/,
    );
    await expect(dag.getByTestId("cover-note")).toContainText("to its AC");
    await dag.getByRole("button", { name: "Close the card" }).click();

    // Mira's Moonbeam (the DM casts it for her): Dave drags its handle — 80 ft is held to 60.
    const mb = await req<{ effectId: string }>(admin, "spell.cast", {
      casterTokenId: mira,
      spellId: "moonbeam",
      mode: "free",
      level: 2,
      placement: { origin: { x: 25, y: 10, z: 0 } },
    });
    for (const c of await admin.getByTestId("resolution-card").all())
      await c
        .getByRole("button", { name: "Close the card" })
        .click()
        .catch(() => {});
    type H = {
      id: string;
      movable: boolean;
      maxFt: number | null;
      sx: number;
      sy: number;
      strike: number | null;
    };
    const handle = async (id: string) =>
      (await hook<H[]>(dave, "effectHandles")).find((h) => h.id === id) as H;
    await expect.poll(async () => (await handle(mb.effectId))?.movable).toBe(true);
    expect((await handle(mb.effectId)).maxFt).toBe(60);
    // The sheet steps aside (its rail button), so the drag has the board.
    if (await dave.getByRole("region", { name: "Character sheet", exact: true }).isVisible())
      await dave.getByRole("button", { name: "Sheet", exact: true }).click();
    await expect(dave.getByRole("region", { name: "Character sheet", exact: true })).toBeHidden();
    // The view slides back by what the sheet's opening moved it (CameraRig): press the handle once it's still — the
    // camera at rest where it was going (two equal readings alone can come before the slide's first frame).
    await expect.poll(async () => (await camera(dave))?.moving, { timeout: 15_000 }).toBe(false);
    let last = { sx: -1, sy: -1 };
    await expect
      .poll(async () => {
        const h = await handle(mb.effectId);
        const still = Math.hypot(h.sx - last.sx, h.sy - last.sy) < 0.5;
        last = h;
        return still;
      })
      .toBe(true);
    const from = await handle(mb.effectId);
    const to = await screen(dave, 105, 10, 0);
    await dave.mouse.move(from.sx, from.sy);
    await dave.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await dave.mouse.move(from.sx + ((to.x - from.sx) * i) / 8, from.sy + ((to.y - from.sy) * i) / 8);
      await dave.waitForTimeout(40);
    }
    await dave.screenshot({ path: `${SHOTS}/moonbeam-drag.png` });
    await dave.mouse.up();
    const origin = async () => {
      const e = (await hook<{ id: string; shapeJson: string }[]>(admin, "effects")).find(
        (x) => x.id === mb.effectId,
      );
      return e ? (JSON.parse(e.shapeJson) as { origin: P }).origin : null;
    };
    await expect.poll(async () => (await origin())?.x ?? 0).toBeGreaterThan(80);
    const o = (await origin()) as P;
    expect(Math.hypot(o.x - 25, o.y - 10)).toBeLessThanOrEqual(60.5);

    // Call Lightning for Mira: its handle's chip — Strike again — a point under the cloud: the bolt's card.
    const cl = await req<{ effectId: string; castId: string }>(admin, "spell.cast", {
      casterTokenId: mira,
      spellId: "call-lightning",
      mode: "free",
      level: 3,
      placement: { origin: { x: 20, y: 45, z: 0 } },
      endConcentration: true,
    });
    await expect.poll(async () => (await handle(cl.effectId))?.strike).toBe(5);
    const h = await handle(cl.effectId);
    // Drawn and under the pointer (the board draws on demand: a handle's data comes before its frame).
    await expect
      .poll(async () =>
        (await hook<{ owner: string }[]>(dave, "pickAt", h.sx, h.sy)).some(
          (x) => x.owner === `handle:${cl.effectId}`,
        ),
      )
      .toBe(true);
    await dave.mouse.click(h.sx, h.sy);
    const chip = dave.getByTestId("effect-chip");
    await expect(chip).toBeVisible();
    await chip.getByRole("button", { name: "Strike again" }).click();
    const bolt = await screen(dave, 45, 42, 0);
    await dave.mouse.move(bolt.x - 20, bolt.y);
    await dave.mouse.move(bolt.x, bolt.y, { steps: 3 });
    await dave.screenshot({ path: `${SHOTS}/call-lightning-strike.png` });
    await dave.mouse.click(bolt.x, bolt.y);
    const strike = admin
      .getByTestId("resolution-card")
      .filter({ hasText: "Call Lightning" })
      .filter({ has: admin.locator(`[data-testid="cast-target"][data-token="${g1}"]`) });
    await expect(strike.last()).toBeVisible();
  });

  test("AC-SPL-08/09: each of the 12 VFX presets plays on a real cast; the 16 named lasting effects each draw their look; lasting areas animate at the ambient pace (not every frame) with their particles within the tier's budget", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Proving grounds",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 200,
      heightFt: 120,
    });
    await boardSettled(admin, sceneId);
    const npc = async (name: string, pos: P) =>
      (
        await req<{ tokenId: string }>(admin, "token.create", {
          sceneId,
          name,
          pos,
          disposition: "hostile",
          stats: { hp: 200, hpMax: 200, ac: 10 },
        })
      ).tokenId;
    const mage = await npc("Archmage", { x: 20, y: 60 });
    const dummy = await npc("Dummy", { x: 40, y: 60 });
    await camera(admin, { pitchDeg: 60, frame: { minX: 0, minY: 0, maxX: 200, maxY: 120 } });
    // A cast per preset (the DM casting for the archmage, free): the VFX each plays is the spell's own.
    const casts: [string, Record<string, unknown>][] = [
      ["fireball", { placement: { origin: { x: 60, y: 60, z: 0 } } }],
      ["ray-of-frost", { targets: [dummy] }],
      ["lightning-bolt", { placement: { origin: { x: 20, y: 60, z: 0 }, dirDeg: -90 } }],
      ["thunderwave", { placement: { origin: { x: 20, y: 60, z: 0 }, dirDeg: -90 } }],
      ["acid-splash", { placement: { origin: { x: 40, y: 60, z: 0 } } }],
      ["poison-spray", { targets: [dummy] }],
      ["chill-touch", { targets: [dummy] }],
      ["sacred-flame", { targets: [dummy] }],
      ["magic-missile", { targets: [dummy, dummy, dummy] }],
      ["vicious-mockery", { targets: [dummy] }],
      ["cure-wounds", { targets: [dummy] }],
      ["sleep", { placement: { origin: { x: 40, y: 60, z: 0 } } }],
    ];
    // (Paced as a DM clicks: commands are rate-limited, §13.5.)
    const paced = async (payload: Record<string, unknown>) => {
      await admin.waitForTimeout(260);
      return req(admin, "spell.cast", payload);
    };
    for (const [spellId, extra] of casts)
      await paced({ casterTokenId: mage, spellId, mode: "free", level: 5, ...extra });
    type Played = { preset: string; kind: string; parts: number; particles: number };
    const played = () => hook<Played[]>(admin, "vfxPlayed");
    const PRESETS = [
      "fire",
      "cold",
      "lightning",
      "thunder",
      "acid",
      "poison",
      "necrotic",
      "radiant",
      "force",
      "psychic",
      "healing",
      "arcane",
    ];
    await expect
      .poll(async () => [...new Set((await played()).map((p) => p.preset))].sort(), { timeout: 20_000 })
      .toEqual([...PRESETS].sort());
    for (const p of await played()) expect(p.parts, p.preset).toBeGreaterThan(0);
    // Two casts at once (§24.5's budget case): their particles, at the tier's share, within 2 × 1600 at 100 %.
    const tier = await hook<{ name: string; particles: number }>(admin, "tier");
    const counts = (await played()).map((p) => p.particles).sort((a, b) => b - a);
    expect((counts[0] ?? 0) + (counts[1] ?? 0)).toBeLessThanOrEqual(2 * 1600 * tier.particles + 16);
    await admin.screenshot({ path: `${SHOTS}/vfx-casts.png` });
    // The Archmage has no sheet, so its Fireball has no DC: the DM sees "DC — set" and sets it on the card (critic P9
    // r2 B1).
    const fireCard = admin.getByTestId("resolution-card").filter({ hasText: "Fireball" }).first();
    await expect(fireCard.getByTestId("cast-dc")).toHaveText("DC — set");
    await fireCard.getByTestId("cast-dc").click();
    await fireCard.getByLabel("Save DC").fill("15");
    await fireCard.getByLabel("Save DC").press("Enter");
    await expect(fireCard.getByTestId("cast-dc")).toHaveText("DC 15");
    for (const c of await admin.getByTestId("resolution-card").all())
      await c
        .getByRole("button", { name: "Close the card" })
        .click({ timeout: 2000 })
        .catch(() => {});

    // The sixteen lasting effects, spread over the field (each cast free by an adept of its own: one concentration
    // apiece).
    const lasting: [string, number, P][] = [
      ["fog-cloud", 1, { x: 30, y: 20 }],
      ["darkness", 2, { x: 70, y: 20 }],
      ["daylight", 3, { x: 185, y: 110 }],
      ["light", 0, { x: 20, y: 60 }],
      ["spirit-guardians", 3, { x: 20, y: 60 }],
      ["moonbeam", 2, { x: 110, y: 20 }],
      ["web", 2, { x: 140, y: 20 }],
      ["spike-growth", 2, { x: 175, y: 25 }],
      ["sleet-storm", 3, { x: 30, y: 100 }],
      ["stinking-cloud", 3, { x: 75, y: 100 }],
      ["cloudkill", 5, { x: 120, y: 100 }],
      ["wall-of-fire", 4, { x: 150, y: 70 }],
      ["silence", 2, { x: 100, y: 60 }],
      ["faerie-fire", 1, { x: 40, y: 60 }],
      ["flaming-sphere", 2, { x: 60, y: 80 }],
      ["call-lightning", 3, { x: 30, y: 45 }],
    ];
    for (const [i, [spellId, level, at]] of lasting.entries()) {
      const who =
        spellId === "light" || spellId === "spirit-guardians"
          ? mage
          : await npc(`Adept ${i + 1}`, { x: 190 - (i % 8) * 3, y: 5 + Math.floor(i / 8) * 3 });
      const r = (await paced({
        casterTokenId: who,
        spellId,
        mode: "free",
        level,
        endConcentration: true,
        ...(spellId === "light"
          ? { targets: [who] }
          : spellId === "wall-of-fire"
            ? {
                placement: {
                  origin: { x: at.x, y: at.y - 20, z: 0 },
                  points: [
                    { x: at.x, y: at.y - 20 },
                    { x: at.x, y: at.y + 20 },
                  ],
                },
              }
            : { placement: { origin: { x: at.x, y: at.y, z: 0 } } }),
      })) as { castId: string | null };
      // Faerie Fire's outline goes on those who fail: the dummy fails (the card's steps are other journeys').
      if (spellId === "faerie-fire" && r.castId) {
        await req(admin, "cast.set", { castId: r.castId, targetId: dummy, saveSuccess: false });
        await admin.waitForTimeout(260);
        await req(admin, "cast.apply", { castId: r.castId });
      }
    }
    for (const c of await admin.getByTestId("resolution-card").all())
      await c
        .getByRole("button", { name: "Close the card" })
        .click({ timeout: 2000 })
        .catch(() => {});
    const NAMES = [
      "Fog Cloud",
      "Darkness",
      "Daylight",
      "Light",
      "Spirit Guardians",
      "Moonbeam",
      "Web",
      "Spike Growth",
      "Sleet Storm",
      "Stinking Cloud",
      "Cloudkill",
      "Wall of Fire",
      "Silence",
      "Faerie Fire",
      "Flaming Sphere",
      "Call Lightning",
    ];
    type Drawn = { id: string; name: string; preset: string; parts: number };
    await expect
      .poll(
        async () => [...new Set((await hook<Drawn[]>(admin, "effectsDrawn")).map((d) => d.name))].sort(),
        { timeout: 20_000 },
      )
      .toEqual([...NAMES].sort());
    for (const d of await hook<Drawn[]>(admin, "effectsDrawn")) expect(d.parts, d.name).toBeGreaterThan(0);
    // Every card closed (the DM's), so the board shows.
    for (const c of await hook<{ id: string; status: string }[]>(admin, "casts"))
      if (c.status === "open") {
        await admin.waitForTimeout(220);
        await req(admin, "cast.close", { castId: c.id }).catch(() => {});
      }
    await expect(admin.getByTestId("resolution-card")).toHaveCount(0);
    await admin.mouse.move(1, 1);
    await admin.waitForTimeout(1500);
    await admin.screenshot({ path: `${SHOTS}/lasting-effects.png` });
    // The DM thins the Fog Cloud to light obscurement: it stays drawn — as a haze (AC-VIS-07; what it hides is the
    // server's, spellVision.test.ts).
    const fog = (await hook<{ id: string; name: string }[]>(admin, "effects")).find(
      (e) => e.name === "Fog Cloud",
    );
    await req(admin, "effect.update", { effectId: fog?.id, props: { obscurement: "light" } });
    await expect
      .poll(
        async () => (await hook<Drawn[]>(admin, "effectsDrawn")).find((d) => d.id === fog?.id)?.parts ?? 0,
      )
      .toBeGreaterThan(0);
    await camera(admin, { pitchDeg: 60, frame: { minX: 0, minY: 0, maxX: 70, maxY: 45 } });
    await admin.waitForTimeout(1200);
    await admin.screenshot({ path: `${SHOTS}/haze.png` });
    await camera(admin, { pitchDeg: 60, frame: { minX: 0, minY: 0, maxX: 200, maxY: 120 } });
    // Idle, they keep moving — at the ambient pace (§24.5 "subtle"): about 24 frames a second, not every display
    // frame (a margin for the timer's jitter), and not stopped.
    const f0 = await hook<number>(admin, "frameCount");
    await admin.waitForTimeout(3000);
    const perSecond = ((await hook<number>(admin, "frameCount")) - f0) / 3;
    expect(perSecond).toBeGreaterThan(2);
    expect(perSecond).toBeLessThanOrEqual(26);
  });

  test("AC-SPL-10/11: the DM's builder checks every field as it's typed with a live card, and saves a spell; Fireball duplicated into Poison Ball; Dave proposes one from his sheet — the DM approves it; Import spells: a dry run's report (valid, invalid with why, clashes), then renamed in", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const { dave } = await wizardScene(admin, browser, gloam, guardLog);
    await dmSection(admin, "Spells");
    const panel = admin.getByTestId("spells-panel");

    // New spell: the card waits for a valid spell; a bad formula is named; fixed, the card shows and it saves.
    await panel.getByRole("button", { name: "New spell" }).click();
    const builder = admin.getByTestId("homebrew-builder");
    await expect(builder).toBeVisible();
    await expect(admin.getByTestId("builder-status")).toContainText(/\d+ problems?/);
    await builder.getByLabel("Name", { exact: true }).fill("Frost Nova");
    await expect(builder.getByLabel("Id", { exact: true })).toHaveValue("frost-nova");
    await builder
      .getByLabel("Description (Markdown)")
      .fill("A ring of frost bursts from a point you choose.");
    await builder.getByRole("button", { name: /Add damage/ }).click();
    const dmg = builder.getByTestId("damage-row").first();
    await dmg.getByLabel("Damage 1", { exact: true }).fill("3d8 +");
    await expect(admin.getByTestId("builder-errors")).toContainText("Damage 1");
    await expect(admin.getByTestId("builder-status")).toContainText("1 problem");
    // Said on the field itself too, and the status press takes you there.
    await expect(dmg.getByTestId("field-error")).toBeVisible();
    await expect(dmg.getByLabel("Damage 1", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await admin.getByTestId("builder-status").click();
    await expect(dmg.getByLabel("Damage 1", { exact: true })).toBeFocused();
    await dmg.getByLabel("Damage 1", { exact: true }).fill("3d8");
    await dmg.getByLabel("Type").selectOption("cold");
    await expect(admin.getByTestId("builder-status")).toHaveText("Valid");
    await expect(builder.getByTestId("spell-card")).toContainText("Frost Nova");
    await expect(builder.getByTestId("spell-card")).toContainText("3d8");
    await admin.screenshot({ path: `${SHOTS}/homebrew-builder.png` });
    await admin.getByRole("button", { name: "Save spell" }).click();
    await expect(panel.locator('[data-testid="homebrew-row"][data-spell="frost-nova"]')).toBeVisible();

    // Fireball as a template: Poison Ball.
    await panel.getByRole("button", { name: "Browse spells" }).click();
    const list = admin.getByTestId("spell-browser");
    await list.getByTestId("spell-search").fill("fireball");
    await list.locator('[data-testid="spell-row"][data-spell="fireball"]').click();
    await list.getByRole("button", { name: "Duplicate as homebrew" }).click();
    await expect(builder.getByLabel("Name", { exact: true })).toHaveValue("Fireball (copy)");
    await builder.getByLabel("Name", { exact: true }).fill("Poison Ball");
    await builder.getByLabel("Id", { exact: true }).fill("poison-ball");
    await builder.getByTestId("damage-row").first().getByLabel("Type").selectOption("poison");
    // Its VFX follows the damage type (§8.13: chosen from it, overridable), so Poison Ball looks like poison.
    await expect(builder.getByLabel("VFX")).toHaveValue("poison");
    await expect(builder.getByLabel("VFX").locator("option:checked")).toHaveText("Poison · from the damage");
    await expect(builder.getByTestId("spell-card")).toContainText("poison");
    await admin.getByRole("button", { name: "Save spell" }).click();
    await expect(panel.locator('[data-testid="homebrew-row"][data-spell="poison-ball"]')).toBeVisible();

    // Dave proposes one from his sheet: Mira's own Magic Missile variant; waiting on the DM till approved.
    await dave.bringToFront();
    await openDock(dave, "Sheet");
    const tab = await sheetTab(dave, "Spells");
    await tab.getByRole("button", { name: "New homebrew spell…" }).click();
    const his = dave.getByTestId("homebrew-builder");
    await his.getByLabel("Name", { exact: true }).fill("Arcane Dart");
    await his.getByLabel("Description (Markdown)").fill("A dart of force.");
    await dave.getByRole("button", { name: "Propose to the DM" }).click();
    await expect(tab.locator('[data-testid="own-homebrew-row"][data-status="proposed"]')).toContainText(
      "Arcane Dart",
    );
    await admin.bringToFront();
    const proposed = panel.getByRole("region", { name: "Proposed spells" });
    await expect(proposed).toContainText("Arcane Dart");
    await proposed.getByRole("button", { name: "Approve" }).click();
    await expect(panel.locator('[data-testid="homebrew-row"][data-spell="arcane-dart"]')).toBeVisible();
    await expect(tab.getByTestId("own-homebrew-row")).toHaveCount(0);

    // Import: a dry run reports, then the clashes renamed in.
    await panel.getByRole("button", { name: "Import…" }).click();
    const dialog = admin.getByTestId("import-spells");
    const base = {
      level: 1,
      school: "evocation",
      classes: ["wizard"],
      castingTime: { amount: 1, unit: "action" },
      ritual: false,
      range: { kind: "ranged", ft: 60 },
      components: { v: true, s: true, m: false },
      duration: { kind: "instantaneous", concentration: false },
      text: "Imported.",
      targeting: { kind: "creatures", count: 1 },
      vfx: "arcane",
      source: { pack: "homebrew" },
    };
    const batch = [
      { ...base, id: "star-shard", name: "Star Shard" },
      { ...base, id: "broken-one", name: "Broken", level: 12 },
      { ...base, id: "fireball", name: "Fireball (ours)" },
      { ...base, id: "poison-ball", name: "Poison Ball II" },
    ];
    await dialog.getByLabel("Spells as JSON").fill(JSON.stringify(batch));
    await admin.getByRole("button", { name: "Dry run" }).click();
    const report = admin.getByTestId("import-report");
    await expect(report).toContainText("3 of 4 valid");
    await expect(report).toContainText("Invalid (1)");
    await expect(report).toContainText(/level/);
    await expect(report).toContainText(/fireball/);
    // What it would import, each clash's fate under the choice made, and why the invalid one is, in plain words.
    await expect(report.getByTestId("import-will")).toContainText("Will import (1)");
    await expect(report.getByTestId("import-will")).toContainText("Star Shard");
    await expect(report.getByTestId("import-clashes")).toContainText("Fireball (ours)");
    await expect(report.getByTestId("import-clashes")).toContainText(
      "taken by an SRD spell · would be skipped",
    );
    await expect(report.getByTestId("import-invalid")).toContainText("level must be 9 or less (it's 12)");
    await admin.screenshot({ path: `${SHOTS}/import-dry-run.png` });
    // Rename for the clashes (a new strategy asks for a fresh dry run first), then import.
    await dialog
      .getByRole("radiogroup", { name: "When a spell's id is taken" })
      .getByRole("radio", { name: "Rename" })
      .click();
    await admin.getByRole("button", { name: "Dry run" }).click();
    await expect(report).toContainText("rename 2");
    await expect(report.getByTestId("import-clashes")).toContainText("would be renamed fireball-2");
    await expect(report.getByTestId("import-will")).toContainText("Will import (3)");
    await admin.getByRole("button", { name: "Import", exact: true }).click();
    await expect(report).toContainText("fireball-2");
    await expect(report).toContainText("poison-ball-2");
    for (const id of ["star-shard", "fireball-2", "poison-ball-2"])
      await expect(panel.locator(`[data-testid="homebrew-row"][data-spell="${id}"]`)).toBeVisible();
  });
});
