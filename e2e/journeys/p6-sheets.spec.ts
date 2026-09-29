import { readFileSync } from "node:fs";
import type { CDPSession, Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  assetFixtures,
  boardSettled,
  camera,
  createScene,
  dmSection,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };
const SHOTS = "artifacts/screens/p6";

interface Block {
  id: string;
  type: string;
  title: string;
  value?: number;
  max?: number;
  pinToToken?: boolean;
  [k: string]: unknown;
}
interface Actor {
  id: string;
  kind: string;
  ownerUserId: string | null;
  lockLevel: string;
  templateId: string | null;
  sheet: {
    core: {
      name: string;
      classes: { name: string; level: number }[];
      hp: { max: number; current: number; temp: number };
      ac: { value: number };
      speeds: { walk: number };
      senses: { darkvision: number };
      abilities: Record<string, number>;
      overrides: Record<string, number>;
      portraitAssetId?: string;
      tokenAssetId?: string;
      [k: string]: unknown;
    };
    custom: Block[];
    [k: string]: unknown;
  };
}
interface Term {
  kind: string;
  ref?: string;
  value?: number;
  count?: number;
  dice?: { value: number; kept: boolean }[];
}
interface Roll {
  id: string;
  userId: string;
  formula: string;
  normalized: string;
  label?: string;
  total: number;
  tokenId?: string;
  terms: Term[];
}
interface Token {
  id: string;
  name: string;
  actorId: string;
  pos: { x: number; y: number };
  pinnedBars: string[];
  conditions: string[];
  hpFrac: number;
  hp?: { hp: number; hpMax: number };
  dm?: { link: string };
}

const sheets = (p: Page) => hook<Actor[]>(p, "sheets");
const actorNamed = async (p: Page, name: string) => (await sheets(p)).find((a) => a.sheet.core.name === name);
const feed = (p: Page) => hook<Roll[]>(p, "rollFeed");
const tokens = (p: Page) => hook<Token[]>(p, "tokens");

/** Opens a dock panel from its rail (it stays open if it already is). */
async function openDock(p: Page, name: "Sheet" | "Party" | "DM panel") {
  const panel = { Sheet: "Character sheet", Party: "Party", "DM panel": "DM panel" }[name];
  const aside = p.getByRole("region", { name: panel, exact: true });
  // The DM panel's button carries its badge ("DM panel (1 waiting for approval)").
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

/** The newest roll once it has arrived (the feed lists newest first). */
async function nextRoll(p: Page, before: number): Promise<Roll> {
  await expect.poll(async () => (await feed(p)).length, { timeout: 10_000 }).toBeGreaterThan(before);
  return (await feed(p))[0] as Roll;
}

/** Screen point over a token (its base, a little above the table). */
async function screenOf(p: Page, id: string): Promise<{ x: number; y: number }> {
  const t = (await hook<Token | null>(p, "token", id)) as Token;
  const s = await hook<{ sx: number; sy: number }>(p, "project", t.pos.x, t.pos.y, 0.15);
  return { x: s.sx, y: s.sy };
}

/** A long press through Chromium's touch input (pointerType "touch"), `ms` long. */
async function longPress(cdp: CDPSession, x: number, y: number, ms: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await new Promise((r) => setTimeout(r, ms));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.describe("P6 — character sheets (SHEET)", () => {
  test.use({ viewport: VIEWPORT });
  test.setTimeout(300_000);

  test("AC-SHEET-01 / AC-SHEET-02 / AC-SHEET-08: a player makes a character in one dialog (art approved by the DM on the way); every derived number is set by hand and reverted; every rollable rolls its formula, Alt and Ctrl and the long-press menu set advantage", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const fx = await assetFixtures();
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Guildhall",
      mapKind: "procedural",
      floorStyle: "wood",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    await boardSettled(dave, sceneId);

    // ── AC-SHEET-01: Quick create — name, class and level, HP, AC, speed, darkvision and art, in one dialog. ──
    const panel = await openDock(dave, "Sheet");
    await panel.getByRole("button", { name: "Quick create" }).click();
    const dialog = dave.getByRole("dialog", { name: "Quick create" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill("Thorin Emberhand");
    await dialog.getByLabel("Class and level").fill("Fighter 3");
    await dialog.getByLabel("Max HP").fill("28");
    await dialog.getByLabel("AC", { exact: true }).fill("17");
    await dialog.getByLabel("Speed (ft)").fill("25");
    await dialog.getByLabel("Darkvision (ft)").fill("60");
    // Art: the player's upload waits for the DM; the picker lists it, marked, and not yet choosable.
    await dialog.getByRole("button", { name: "Portrait: choose" }).click();
    const picker = dialog.getByTestId("asset-picker");
    await picker.getByLabel("File to upload").setInputFiles({
      name: "thorin.png",
      mimeType: "image/png",
      buffer: await fx.portraitPng("knight", { size: 512 }),
    });
    const waiting = picker.getByRole("button", { name: /\(waiting for approval\)$/ });
    await expect(waiting).toBeVisible({ timeout: 15_000 });
    await expect(waiting).toBeDisabled();
    // The DM approves it from the Approvals inbox (the rail's badge counts it)…
    await expect(admin.getByRole("button", { name: /^DM panel \(1 waiting for approval\)$/ })).toBeVisible();
    const dm = await openDock(admin, "DM panel");
    await dmSection(admin, "Approvals");
    await dm.locator("[data-pending]").getByRole("button", { name: "Approve" }).click();
    // …and it becomes choosable while the picker is still open.
    const approved = picker.getByRole("button", { name: /^thorin/ });
    await expect(approved).toBeEnabled({ timeout: 10_000 });
    await approved.click();
    await expect(picker).toHaveCount(0);
    await dialog.getByRole("button", { name: "Create character" }).click();
    await expect(dialog).toHaveCount(0);
    const sheet = dave.getByTestId("sheet");
    await expect(sheet).toHaveAttribute("aria-label", "Thorin Emberhand's sheet");
    await expect.poll(() => actorNamed(dave, "Thorin Emberhand")).toBeTruthy();
    const thorin = (await actorNamed(dave, "Thorin Emberhand")) as Actor;
    expect(thorin.kind).toBe("character");
    expect(thorin.sheet.core.classes).toEqual([expect.objectContaining({ name: "Fighter", level: 3 })]);
    expect(thorin.sheet.core.hp).toEqual({ max: 28, current: 28, temp: 0 });
    expect(thorin.sheet.core.ac.value).toBe(17);
    expect(thorin.sheet.core.speeds.walk).toBe(25);
    expect(thorin.sheet.core.senses.darkvision).toBe(60);
    expect(thorin.sheet.core.portraitAssetId).toMatch(/.+/);
    await expect(sheet.locator("header img")).toBeVisible();
    // Playable at once: its token is on the board for everyone, with its numbers.
    await expect
      .poll(async () => (await tokens(admin)).find((t) => t.actorId === thorin.id)?.hp)
      .toEqual({ hp: 28, hpMax: 28, hpTemp: 0 });
    const thorinToken = ((await tokens(admin)).find((t) => t.actorId === thorin.id) as Token).id;
    await expect.poll(async () => (await tokens(dave)).some((t) => t.id === thorinToken)).toBe(true);
    await dave.screenshot({ path: `${SHOTS}/sheet-overview.png` });

    // ── AC-SHEET-02: a derived number follows its inputs, can be set by hand, and goes back when reverted. ──
    const abilities = await sheetTab(dave, "Abilities");
    const wis = abilities.getByLabel("Wisdom score", { exact: true });
    await wis.fill("14");
    await wis.press("Enter");
    // Perception: WIS +2, then proficient (+2 at level 3).
    await abilities.getByRole("button", { name: "Perception: none; change to half" }).click();
    await abilities.getByRole("button", { name: "Perception: half; change to proficient" }).click();
    const perception = abilities.getByRole("button", { name: "Roll Perception", exact: true });
    await expect(perception).toHaveText("+4");
    await abilities.getByRole("button", { name: "Set Perception by hand" }).click();
    const byHand = abilities.getByLabel("Perception (set by hand)");
    await byHand.fill("9");
    await byHand.press("Enter");
    await expect(perception).toHaveText("+9");
    const badge = abilities.getByRole("button", { name: "Perception is set by hand; revert to 4" });
    await expect(badge).toBeVisible();
    await expect
      .poll(async () => (await actorNamed(dave, "Thorin Emberhand"))?.sheet.core.overrides)
      .toEqual({ "skill.perception": 9 });
    // Passive Perception follows the number as set (10 + 9).
    await expect(
      abilities.getByRole("button", { name: "Set Passive Perception by hand" }).locator("xpath=.."),
    ).toContainText("19");
    await dave.screenshot({ path: `${SHOTS}/sheet-override.png` });
    await badge.click();
    await expect(perception).toHaveText("+4");
    await expect(badge).toHaveCount(0);
    await expect
      .poll(async () => (await actorNamed(dave, "Thorin Emberhand"))?.sheet.core.overrides)
      .toEqual({});
    // Every derived field offers the override: level (proficiency follows it), each modifier, save and skill,
    // proficiency, initiative, the passives, carrying capacity (and, with spellcasting, its DC and attack).
    const overview = await sheetTab(dave, "Overview");
    await overview.getByRole("button", { name: "Set Character level by hand" }).click();
    const level = overview.getByLabel("Character level (set by hand)");
    await level.fill("9");
    await level.press("Enter");
    await expect(
      overview.getByRole("button", { name: "Character level is set by hand; revert to 3" }),
    ).toBeVisible();
    // Level 9: proficiency +4, so Perception is WIS +2 and +4.
    await sheetTab(dave, "Abilities");
    await expect(perception).toHaveText("+6");
    await sheetTab(dave, "Overview");
    await overview.getByRole("button", { name: "Character level is set by hand; revert to 3" }).click();
    await sheetTab(dave, "Abilities");
    await expect(perception).toHaveText("+4");
    const overridable = [
      "Proficiency bonus",
      "Initiative",
      "Passive Perception",
      "Passive Investigation",
      "Passive Insight",
      ...["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"].flatMap((a) => [
        `${a} modifier`,
        `${a} save`,
      ]),
      ...[
        "Acrobatics",
        "Animal Handling",
        "Arcana",
        "Athletics",
        "Deception",
        "History",
        "Insight",
        "Intimidation",
        "Investigation",
        "Medicine",
        "Nature",
        "Perception",
        "Performance",
        "Persuasion",
        "Religion",
        "Sleight of Hand",
        "Stealth",
        "Survival",
      ],
    ];
    for (const name of overridable)
      await expect(abilities.getByRole("button", { name: `Set ${name} by hand`, exact: true })).toHaveCount(
        1,
      );
    const inventory = await sheetTab(dave, "Inventory");
    await expect(inventory.getByRole("button", { name: "Set Carrying capacity by hand" })).toHaveCount(1);

    // ── AC-SHEET-08: every rollable rolls its own formula — from the sheet's numbers, on the server. ──
    await sheetTab(dave, "Abilities");
    const rollables = abilities.getByTestId("rollable");
    const expected = new Map<string, string>([
      ["Roll Strength check", "1d20 + @str"],
      ["Roll Wisdom save", "1d20 + @wis.save"],
      ["Roll Initiative", "1d20 + @init"],
      ["Roll Perception", "1d20 + @skill.perception"],
      ["Roll Sleight of Hand", "1d20 + @skill.sleightOfHand"],
    ]);
    const all = await rollables.evaluateAll((els) =>
      els.map((e) => [e.getAttribute("aria-label"), e.getAttribute("data-formula")] as const),
    );
    // 6 checks, 6 saves, initiative and 18 skills — each with the formula its label names.
    expect(all).toHaveLength(31);
    for (const [label, formula] of all) {
      const name = (label as string).replace(/^Roll /, "");
      const skill = name
        .replace(/ (.)/g, (_, ch: string) => ch.toUpperCase())
        .replace(/^./, (ch) => ch.toLowerCase());
      const ability = name.slice(0, 3).toLowerCase();
      expect(formula, name).toBe(
        name === "Initiative"
          ? "1d20 + @init"
          : name.endsWith(" check")
            ? `1d20 + @${ability}`
            : name.endsWith(" save")
              ? `1d20 + @${ability}.save`
              : `1d20 + @skill.${skill}`,
      );
    }
    for (const [label, formula] of expected) expect(all.find(([l]) => l === label)?.[1], label).toBe(formula);
    // Rolled: the server resolves the references from this character (WIS 14 → +2; Perception +4).
    let n = (await feed(dave)).length;
    await perception.click();
    let r = await nextRoll(dave, n);
    expect(r.formula).toBe("1d20 + @skill.perception");
    expect(r.label).toBe("Perception");
    expect(r.terms.find((t) => t.kind === "ref")).toMatchObject({ ref: "@skill.perception", value: 4 });
    expect(r.terms.find((t) => t.kind === "dice")?.dice).toHaveLength(1);
    // Alt: advantage (two d20s, the higher kept); Ctrl: disadvantage (the lower kept).
    for (const [mod, tag, pick] of [
      ["Alt", "adv", Math.max],
      ["Control", "dis", Math.min],
    ] as const) {
      n = (await feed(dave)).length;
      await abilities
        .getByRole("button", { name: "Roll Wisdom save", exact: true })
        .click({ modifiers: [mod] });
      r = await nextRoll(dave, n);
      expect(r.formula).toBe(`1d20 + @wis.save ${tag}`);
      const d20 = r.terms.find((t) => t.kind === "dice")?.dice ?? [];
      expect(d20).toHaveLength(2);
      const kept = d20.filter((d) => d.kept).map((d) => d.value);
      expect(kept).toEqual([pick(...d20.map((d) => d.value))]);
      expect(r.total).toBe((kept[0] as number) + 2);
    }

    // The same from a phone: a long press opens the menu (Normal / Advantage / Disadvantage / Physical…).
    const cdp = await dave.context().newCDPSession(dave);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const initiative = abilities.getByRole("button", { name: "Roll Initiative", exact: true });
    await initiative.scrollIntoViewIfNeeded();
    const initBox = (await initiative.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    n = (await feed(dave)).length;
    await longPress(cdp, initBox.x + initBox.width / 2, initBox.y + initBox.height / 2, 800);
    const menu = abilities.getByRole("menu", { name: "Roll Initiative" });
    await expect(menu).toBeVisible();
    // The long press itself rolled nothing.
    await dave.waitForTimeout(400);
    expect((await feed(dave)).length).toBe(n);
    await dave.screenshot({ path: `${SHOTS}/sheet-longpress.png` });
    await menu.getByRole("menuitem", { name: "Disadvantage" }).click();
    r = await nextRoll(dave, n);
    expect(r.formula).toBe("1d20 + @init dis");
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

    // The tray rolls for the selected token: its references come from that token's sheet.
    await camera(dave, { pitchDeg: 90, distance: 60, target: [30, 20], ms: 0 });
    const at = await screenOf(dave, thorinToken);
    await dave.mouse.click(at.x, at.y);
    await expect
      .poll(async () => (await hook<{ selection: string[] }>(dave, "ui")).selection)
      .toEqual([thorinToken]);
    await dave.keyboard.press("d");
    const tray = dave.getByTestId("dice-tray");
    await expect(tray).toBeVisible();
    await dave.getByTestId("dice-formula").fill("1d20 + @wis");
    n = (await feed(dave)).length;
    await tray.getByRole("button", { name: "Roll", exact: true }).click();
    r = await nextRoll(dave, n);
    expect(r.tokenId).toBe(thorinToken);
    expect(r.terms.find((t) => t.kind === "ref")).toMatchObject({ ref: "@wis", value: 2 });
  });

  test("AC-SHEET-06 / AC-SHEET-07: import is checked against the published schema with readable errors, previewed and diffed before anything changes; export → import round-trips losslessly; Import with AI copies F.3's prompt with the schema in it", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Chapel",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const { actorId } = await req<{ actorId: string }>(dave, "actor.quickCreate", {
      name: "Brother Aldous",
      classLevel: "Cleric 4",
      hpMax: 31,
      ac: 18,
      speed: 25,
    });
    await req(dave, "actor.change", {
      actorId,
      changes: [
        { path: ["core", "abilities", "wis"], after: 17 },
        { path: ["core", "skills", "insight"], after: { prof: "proficient" } },
        {
          path: ["custom"],
          after: [
            { id: "b1", type: "counter", title: "Channel Divinity", value: 1, max: 2, pinToToken: false },
          ],
        },
        { path: ["core", "notes"], after: "Keeper of the lantern." },
      ],
    });
    await openDock(dave, "Sheet");
    const sheet = dave.getByTestId("sheet");
    await expect(sheet).toHaveAttribute("aria-label", "Brother Aldous's sheet");
    const menu = async (item: string) => {
      await sheet.getByRole("button", { name: "Sheet actions" }).click();
      await dave.getByRole("menuitem", { name: item }).click();
    };

    // Export: the sheet as JSON, downloaded.
    const [download] = await Promise.all([dave.waitForEvent("download"), menu("Export JSON")]);
    expect(download.suggestedFilename()).toBe("Brother Aldous.json");
    const exported = JSON.parse(readFileSync(await download.path(), "utf8")) as Actor["sheet"];
    const stored = (await actorNamed(dave, "Brother Aldous")) as Actor;
    expect(exported).toEqual(stored.sheet);

    // Import: refused with readable reasons, nothing changes.
    await menu("Import JSON…");
    const dialog = dave.getByRole("dialog", { name: "Import a sheet" });
    const text = dialog.getByTestId("import-text");
    await text.fill("{ core: ");
    await expect(dialog.getByTestId("import-errors")).toContainText("That isn't JSON");
    const bad = structuredClone(exported) as {
      core: Record<string, unknown> & { abilities: Record<string, number> };
    };
    bad.core.abilities.str = 99;
    (bad.core as Record<string, unknown>).speeds = { walk: -5 };
    await text.fill(JSON.stringify(bad));
    const errors = dialog.getByTestId("import-errors");
    await expect(errors).toContainText("Strength score");
    await expect(errors).toContainText("must be 30 or less (it's 99)");
    await expect(errors).toContainText("core.abilities.str");
    await expect(errors).toContainText("Walk speed");
    await expect(dialog.getByRole("button", { name: "Create a new character" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /^Replace/ })).toHaveCount(0);
    await dave.screenshot({ path: `${SHOTS}/import-errors.png` });

    // A good one: previewed, and diffed against the sheet it would replace.
    const edited = structuredClone(exported) as { core: Record<string, unknown> & { hp: { max: number } } };
    edited.core.hp.max = 38;
    (edited.core as Record<string, unknown>).background = "Acolyte";
    await text.fill(JSON.stringify(edited, null, 2));
    await expect(errors).toHaveCount(0);
    const preview = dialog.getByTestId("import-preview");
    await expect(preview).toContainText("Brother Aldous");
    await expect(preview).toContainText("Cleric 4");
    await expect(preview).toContainText("HP 38");
    await expect(preview).toContainText("1 custom block");
    const diff = dialog.getByTestId("import-diff");
    await expect(diff).toContainText("2 changes");
    await expect(diff).toContainText("Max HP");
    await expect(diff).toContainText("Background");
    await dave.screenshot({ path: `${SHOTS}/import-preview.png` });
    expect((await actorNamed(dave, "Brother Aldous"))?.sheet.core.hp.max).toBe(31);
    await dialog.getByRole("button", { name: "Replace Brother Aldous's sheet" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await actorNamed(dave, "Brother Aldous"))?.sheet.core.hp.max).toBe(38);

    // Round trip: what's exported imports as a new character with exactly the same sheet.
    const [again] = await Promise.all([dave.waitForEvent("download"), menu("Export JSON")]);
    const second = JSON.parse(readFileSync(await again.path(), "utf8")) as Actor["sheet"];
    expect(second).toEqual((await actorNamed(dave, "Brother Aldous"))?.sheet);
    (second.core as { name: string }).name = "Brother Aldous (copy)";
    await menu("Import JSON…");
    await text.fill(JSON.stringify(second));
    await dialog.getByRole("button", { name: "Create a new character" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await actorNamed(dave, "Brother Aldous (copy)"))?.sheet).toEqual(second);

    // AC-SHEET-07: the AI dialog copies F.3's prompt with this table's published schema in place of its marker.
    await menu("Import with AI…");
    const ai = dave.getByRole("dialog", { name: "Import with AI" });
    await ai.getByRole("button", { name: "Copy AI prompt" }).click();
    await expect(dave.getByText("Prompt copied")).toBeVisible();
    const prompt = await hook<string>(dave, "lastCopied");
    const schema = await (await dave.request.get(`${gloam.url}/api/v1/schemas/character.json`)).json();
    expect(prompt).toContain(JSON.stringify(schema, null, 2));
    expect(prompt).not.toContain("{{");
    // F.3's conversion rules, as written.
    for (const rule of [
      "Output ONLY one JSON object",
      "Never invent",
      "Distances in feet (1.5 m = 5 ft)",
      'List anything you were unsure about in "importNotes".',
    ])
      expect(prompt).toContain(rule);
    await dave.screenshot({ path: `${SHOTS}/import-ai.png` });
    // The assistant's reply, fenced as assistants do, reads as a sheet.
    await ai.getByTestId("import-text").fill(`Here is the sheet:

\`\`\`json
${JSON.stringify({ core: { name: "Wren", hp: { max: 9, current: 9 } } })}
\`\`\`
`);
    await expect(ai.getByTestId("import-preview")).toContainText("Wren");
  });

  test("AC-SHEET-03 / AC-SHEET-04 / AC-SHEET-05 / AC-TOK-13: custom blocks of all seven kinds, a counter pinned to the token as a bar; a template of them starts a new character; locks send edits to the DM as proposals with a diff; linked tokens share one state across scenes, copies keep their own, relinking asks", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const crypt = await createScene(admin, {
      name: "Crypt",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, crypt);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    await boardSettled(dave, crypt);
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    const { actorId: mira } = await req<{ actorId: string }>(admin, "actor.quickCreate", {
      name: "Mira Vell",
      classLevel: "Warlock 2",
      hpMax: 17,
      ac: 12,
      ownerUserId: daveId,
    });
    // Dave is here: his new character is placed round the spawn at once.
    await expect.poll(async () => (await tokens(admin)).some((t) => t.actorId === mira)).toBe(true);
    const miraOn = async (p: Page) => (await tokens(p)).find((t) => t.actorId === mira) as Token;
    const miraToken = (await miraOn(admin)).id;

    // ── AC-SHEET-03: every kind of custom block — added, renamed, moved, removed; a counter on the token. ──
    await openDock(dave, "Sheet");
    await expect(dave.getByTestId("sheet")).toHaveAttribute("aria-label", "Mira Vell's sheet");
    const custom = await sheetTab(dave, "Custom");
    const kinds = [
      ["text", "Text"],
      ["number", "Number"],
      ["counter", "Counter"],
      ["checklist", "Checklist"],
      ["table", "Table"],
      ["keyValue", "List of pairs"],
      ["image", "Image"],
    ] as const;
    for (const [k, [, label]] of kinds.entries()) {
      await custom.getByLabel("Kind of block").selectOption({ label });
      await custom.getByRole("button", { name: "Add block" }).click();
      await expect(custom.getByTestId("custom-block")).toHaveCount(k + 1);
    }
    const blocksOf = async (p: Page, name = "Mira Vell") => (await actorNamed(p, name))?.sheet.custom ?? [];
    await expect.poll(async () => (await blocksOf(dave)).map((b) => b.type)).toEqual(kinds.map(([t]) => t));
    const commit = async (label: string, value: string) => {
      // A textbox (a counter's label also names its stepper group).
      const f = custom.getByRole("textbox", { name: label, exact: true });
      await f.fill(value);
      await f.press("Enter");
    };
    await commit("Counter block title", "Sanity");
    await commit("Text block title", "Oath");
    await commit("Checklist block title", "Rites");
    await commit("Table block title", "Contacts");
    await commit("List of pairs block title", "Patron");
    await commit("Number block title", "Renown");
    await expect
      .poll(async () => (await blocksOf(dave)).map((b) => b.title))
      .toEqual(["Oath", "Renown", "Sanity", "Rites", "Contacts", "Patron", "Image"]);
    const oath = custom.getByLabel("Oath text");
    await oath.fill("Never leave a friend in the dark.");
    await oath.blur();
    const renown = custom.getByLabel("Renown value");
    await renown.fill("3");
    await renown.blur();
    await commit("Sanity value", "8");
    await custom.getByRole("button", { name: "Add an item" }).click();
    await commit("Rites item 1", "Dawn prayer");
    // (Sheet checkboxes show the sheet as the server has it: ticked once the change is in.)
    await custom.getByRole("checkbox", { name: "Dawn prayer done" }).click();
    await expect(custom.getByRole("checkbox", { name: "Dawn prayer done" })).toBeChecked();
    await custom.getByRole("button", { name: "Add a row" }).click();
    await commit("Contacts row 1 column 1", "Iskra");
    await commit("Contacts row 1 column 2", "Fence, Lowmarket");
    await custom.getByRole("button", { name: "Add a pair" }).click();
    await commit("Patron key 1", "Name");
    await commit("Patron value 1", "The Raven Queen");
    await custom.getByRole("checkbox", { name: "On the token" }).click();
    await expect(custom.getByRole("checkbox", { name: "On the token" })).toBeChecked();
    // Moved: Sanity to the top; removed: the empty image block.
    await custom.getByRole("button", { name: "Move Sanity up" }).click();
    await expect.poll(async () => (await blocksOf(dave))[1]?.title).toBe("Sanity");
    await custom.getByRole("button", { name: "Move Sanity up" }).click();
    await expect.poll(async () => (await blocksOf(dave))[0]?.title).toBe("Sanity");
    await custom.getByRole("button", { name: "Remove Image" }).click();
    await expect
      .poll(async () => (await blocksOf(dave)).map((b) => b.title))
      .toEqual(["Sanity", "Oath", "Renown", "Rites", "Contacts", "Patron"]);
    expect((await blocksOf(dave))[0]).toMatchObject({ type: "counter", value: 8, max: 10, pinToToken: true });
    await dave.screenshot({ path: `${SHOTS}/sheet-custom.png` });
    // The pinned counter is a thin bar under the HP bar, for everyone who sees the token.
    const pinOn = async (p: Page) =>
      (
        await hook<{ parts: Record<string, { visible: boolean; pin?: unknown }> } | null>(
          p,
          "tokenState",
          miraToken,
        )
      )?.parts["pinned:0"];
    for (const p of [admin, dave])
      await expect
        .poll(() => pinOn(p))
        .toEqual({ visible: true, pin: { label: "Sanity", value: 8, max: 10 } });
    await custom.getByRole("button", { name: "Sanity value up" }).click();
    await expect.poll(async () => ((await pinOn(admin))?.pin as { value: number })?.value).toBe(9);
    const at = (await miraOn(admin)).pos;
    await camera(admin, { pitchDeg: 55, distance: 22, target: [at.x, at.y], ms: 0 });
    await admin.waitForTimeout(300);
    await admin.screenshot({ path: `${SHOTS}/token-pinned-bar.png` });

    // ── AC-SHEET-04: the blocks' layout saved as a template; a new character starts from it. ──
    const sheet = dave.getByTestId("sheet");
    await sheet.getByRole("button", { name: "Sheet actions" }).click();
    await dave.getByRole("menuitem", { name: "Save custom blocks as a template…" }).click();
    const naming = dave.getByRole("dialog", { name: "Save as a template" });
    await naming.getByRole("textbox").fill("Warlock's pages");
    await naming.getByRole("button", { name: "Save template" }).click();
    await expect(naming).toHaveCount(0);
    await dave.getByRole("button", { name: "New character" }).click();
    const qc = dave.getByRole("dialog", { name: "Quick create" });
    await qc.getByLabel("Name", { exact: true }).fill("Ash");
    await qc.getByLabel("Max HP").fill("9");
    await qc.getByLabel("AC", { exact: true }).fill("11");
    await qc
      .getByLabel("Custom blocks from a template")
      .selectOption({ label: "Warlock's pages (6 blocks)" });
    await qc.getByRole("button", { name: "Create character" }).click();
    await expect(qc).toHaveCount(0);
    await expect(sheet).toHaveAttribute("aria-label", "Ash's sheet");
    await expect.poll(async () => (await blocksOf(dave, "Ash")).length).toBe(6);
    const ash = (await actorNamed(dave, "Ash")) as Actor;
    expect(ash.templateId).toMatch(/.+/);
    const tpl = ash.sheet.custom;
    expect(tpl.map((b) => [b.type, b.title])).toEqual((await blocksOf(dave)).map((b) => [b.type, b.title]));
    // The layout, not what was filled in: the counter full, ticks cleared, the pairs' values empty.
    expect(tpl[0]).toMatchObject({ type: "counter", value: 10, max: 10, pinToToken: true });
    expect(tpl[3]).toMatchObject({ type: "checklist", items: [{ label: "Dawn prayer", done: false }] });
    expect(tpl[5]).toMatchObject({ type: "keyValue", entries: [{ key: "Name", value: "" }] });
    expect(tpl[2]).toMatchObject({ type: "number", value: 0 });
    // Each block its own id on the new sheet.
    expect(tpl.map((b) => b.id)).not.toEqual((await blocksOf(dave)).map((b) => b.id));

    // ── AC-SHEET-05: Core locked — play-state goes in, the rest becomes a proposal the DM sees as a diff. ──
    await openDock(admin, "Party");
    await admin.getByTestId("party-character").filter({ hasText: "Mira Vell" }).click();
    const dmSheet = admin.getByTestId("sheet");
    await expect(dmSheet).toHaveAttribute("aria-label", "Mira Vell's sheet");
    await dmSheet
      .getByRole("radiogroup", { name: "Sheet lock" })
      .getByRole("radio", { name: "Core locked" })
      .click();
    await dave.getByLabel("Character", { exact: true }).selectOption({ label: "Mira Vell" });
    await expect(sheet).toHaveAttribute("aria-label", "Mira Vell's sheet");
    await expect(sheet.getByTestId("sheet-lock")).toHaveText(/Core locked/);
    // HP is play-state: straight in.
    await sheet.getByRole("button", { name: "Current HP down" }).click();
    await expect.poll(async () => (await actorNamed(dave, "Mira Vell"))?.sheet.core.hp.current).toBe(16);
    await expect(dave.getByRole("dialog", { name: "Propose this change" })).toHaveCount(0);
    // AC isn't: the edit opens the proposal, showing what would change.
    await sheetTab(dave, "Overview");
    const acField = sheet.getByLabel("Armour class");
    await acField.fill("15");
    await acField.press("Enter");
    const propose = dave.getByRole("dialog", { name: "Propose this change" });
    await expect(propose).toBeVisible();
    await expect(propose.getByTestId("propose-fields")).toContainText("AC");
    await expect(propose.getByTestId("propose-fields")).toContainText("12");
    await expect(propose.getByTestId("propose-fields")).toContainText("15");
    await propose.getByRole("textbox").fill("Mage armour, cast at dawn");
    await dave.screenshot({ path: `${SHOTS}/propose-dialog.png` });
    await propose.getByRole("button", { name: "Propose to the DM" }).click();
    await expect(propose).toHaveCount(0);
    await expect(sheet.getByTestId("sheet-pending")).toHaveText(/1 change waiting for the DM/);
    expect((await actorNamed(dave, "Mira Vell"))?.sheet.core.ac.value).toBe(12);
    // The DM: the badge, the diff and the player's note; approving applies it.
    await expect(admin.getByRole("button", { name: /^DM panel \(1 waiting for approval\)$/ })).toBeVisible();
    const dmPanel = await openDock(admin, "DM panel");
    await dmSection(admin, "Approvals");
    const proposal = dmPanel.getByTestId("proposal");
    await expect(proposal).toHaveCount(1);
    await expect(proposal).toContainText("Mira Vell");
    await expect(proposal).toContainText("from Dave");
    await expect(proposal).toContainText("Mage armour, cast at dawn");
    const row = proposal.getByRole("row").filter({ hasText: "AC" });
    await expect(row).toContainText("12");
    await expect(row).toContainText("15");
    await admin.screenshot({ path: `${SHOTS}/approvals-proposal.png` });
    await proposal.getByLabel("A note to Dave").fill("Granted — until your next long rest.");
    await proposal.getByRole("button", { name: "Approve" }).click();
    await expect(proposal).toHaveCount(0);
    await expect.poll(async () => (await actorNamed(dave, "Mira Vell"))?.sheet.core.ac.value).toBe(15);
    await expect(dave.getByText("The DM approved your change to Mira Vell")).toBeVisible();
    await expect(sheet.getByTestId("sheet-pending")).toHaveCount(0);
    // Declined: nothing changes, and the player hears why.
    const abilities = await sheetTab(dave, "Abilities");
    const str = abilities.getByLabel("Strength score", { exact: true });
    await str.fill("18");
    await str.press("Enter");
    await expect(propose.getByTestId("propose-fields")).toContainText("Strength score");
    await propose.getByRole("button", { name: "Propose to the DM" }).click();
    await expect(dmPanel.getByTestId("proposal")).toHaveCount(1);
    await dmPanel
      .getByTestId("proposal")
      .getByLabel("A note to Dave")
      .fill("Not until the gauntlets are yours.");
    await dmPanel.getByTestId("proposal").getByRole("button", { name: "Decline" }).click();
    await expect(dave.getByText("Not until the gauntlets are yours.")).toBeVisible();
    expect((await actorNamed(dave, "Mira Vell"))?.sheet.core.abilities.str).toBe(10);

    // ── AC-TOK-13: one character, one state on every scene; copies from one creature keep their own. ──
    await openDock(admin, "Sheet");
    await expect(dmSheet).toHaveAttribute("aria-label", "Mira Vell's sheet");
    await sheetTab(admin, "Overview");
    // (P7: conditions are added from the condition picker, the sheet's "add" opens it.)
    await dmSheet.getByRole("button", { name: "Add a condition" }).click();
    await admin.getByTestId("status-picker").getByRole("button", { name: "Prone", exact: true }).click();
    await expect(
      admin.getByTestId("status-picker").getByRole("button", { name: "Prone", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await admin.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await expect
      .poll(async () => (await hook<Token>(admin, "token", miraToken)).conditions)
      .toEqual(["prone"]);
    const hall = await createScene(admin, {
      name: "Great hall",
      mapKind: "procedural",
      floorStyle: "wood",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, hall);
    await boardSettled(dave, hall);
    // Placed on the new scene with the party: the same HP and conditions as on the last.
    await expect
      .poll(async () => {
        const t = await miraOn(admin);
        return t && { hp: t.hp?.hp, conditions: t.conditions };
      })
      .toEqual({ hp: 16, conditions: ["prone"] });
    const hallToken = (await miraOn(admin)).id;
    expect(hallToken).not.toBe(miraToken);
    // Three goblins from one creature: one hurt, the others not; the creature's sheet reaches none of them.
    const { actorId: goblin } = await req<{ actorId: string }>(admin, "actor.create", {
      kind: "npc",
      sheet: { core: { name: "Goblin", size: "small", hp: { max: 7, current: 7 }, ac: { value: 15 } } },
    });
    const goblins: string[] = [];
    for (const x of [35, 40, 45])
      goblins.push(
        (
          await req<{ tokenId: string }>(admin, "token.create", {
            sceneId: hall,
            name: "Goblin",
            actorId: goblin,
            link: "unlinked",
            pos: { x, y: 25 },
            disposition: "hostile",
          })
        ).tokenId,
      );
    await req(admin, "token.update", { tokenId: goblins[0], stats: { hp: 2 } });
    await req(admin, "actor.change", {
      actorId: goblin,
      changes: [{ path: ["core", "conditions"], after: ["frightened"] }],
    });
    const gob = async (id: string) =>
      (await hook<{ hp?: { hp: number }; conditions: string[] } | null>(admin, "token", id)) ?? null;
    await expect.poll(async () => (await gob(goblins[0] as string))?.hp?.hp).toBe(2);
    for (const id of goblins.slice(1)) expect((await gob(id))?.hp?.hp).toBe(7);
    for (const id of goblins) expect((await gob(id))?.conditions).toEqual([]);
    await camera(admin, { pitchDeg: 60, distance: 40, target: [38, 22], ms: 0 });
    await admin.waitForTimeout(300);
    // Every plate shows; one moved aside for room covers at most a quarter of another token (more would read as that
    // token's), and none buries a neighbour (covers more than half of it).
    type Rect = { x0: number; y0: number; x1: number; y1: number };
    const share = (a: Rect, b: Rect) =>
      (Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
        Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))) /
      Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
    await expect
      .poll(async () => {
        const diag = await hook<
          { id: string; clear: number; rect?: Rect; token: Rect | null; leader: boolean }[]
        >(admin, "overlays");
        // (A token under the HUD — the dock — shows no plate: nothing there to point at.)
        const covers = await hook<Rect[]>(admin, "plateCovers");
        const underHud = (t: Rect | null) =>
          !!t &&
          covers.some(
            (c) =>
              (t.x0 + t.x1) / 2 > c.x0 &&
              (t.x0 + t.x1) / 2 < c.x1 &&
              (t.y0 + t.y1) / 2 > c.y0 &&
              (t.y0 + t.y1) / 2 < c.y1,
          );
        const hidden = diag.filter((d) => d.clear !== 1 && !underHud(d.token)).map((d) => d.id);
        const onTokens = diag
          .filter((d) => d.clear === 1 && d.rect)
          .flatMap((d) =>
            diag
              .filter(
                (o) => o.id !== d.id && o.token && share(d.rect as Rect, o.token) > (d.leader ? 0.25 : 0.5),
              )
              // (With the share and whether it points back, so a failure says why.)
              .map(
                (o) =>
                  `${d.id} over ${o.id} (${share(d.rect as Rect, o.token as Rect).toFixed(2)} of it, leader ${d.leader})`,
              ),
          );
        return { hidden, onTokens };
      })
      .toEqual({ hidden: [], onTokens: [] });
    await admin.screenshot({ path: `${SHOTS}/goblins-own-hp.png` });
    // Unlinking copies the current numbers; after that the sheet no longer reaches it.
    const tokenTab = await sheetTab(admin, "Token");
    const mine = tokenTab.getByTestId("character-token");
    await expect(mine).toHaveCount(1);
    await mine.getByRole("button", { name: "Unlink" }).click();
    await expect(mine).toHaveAttribute("data-link", "unlinked");
    await expect.poll(async () => (await miraOn(admin)).hp?.hp).toBe(16);
    await sheetTab(dave, "Overview");
    await sheet.getByRole("button", { name: "Current HP up" }).click();
    await expect.poll(async () => (await actorNamed(dave, "Mira Vell"))?.sheet.core.hp.current).toBe(17);
    await admin.waitForTimeout(300);
    expect((await miraOn(admin)).hp?.hp).toBe(16);
    // Relinking would lose its own numbers: the DM is asked first.
    await mine.getByRole("button", { name: "Link to sheet" }).click();
    const ask = admin.getByRole("dialog", { name: "Link this token to the sheet?" });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("HP");
    await admin.screenshot({ path: `${SHOTS}/relink-ask.png` });
    await ask.getByRole("button", { name: "Keep its own" }).click();
    await expect(ask).toHaveCount(0);
    await expect(mine).toHaveAttribute("data-link", "unlinked");
    await mine.getByRole("button", { name: "Link to sheet" }).click();
    await ask.getByRole("button", { name: "Replace with the sheet's" }).click();
    await expect(mine).toHaveAttribute("data-link", "linked");
    await expect.poll(async () => (await miraOn(admin)).hp?.hp).toBe(17);

    // ── AC-SHEET-05: Fully locked — read-only for its player: even HP becomes a proposal (§8.10). ──
    await sheetTab(admin, "Overview");
    await dmSheet
      .getByRole("radiogroup", { name: "Sheet lock" })
      .getByRole("radio", { name: "Fully locked" })
      .click();
    await expect(sheet.getByTestId("sheet-lock")).toHaveText(/Fully locked/);
    // (Mira is at her maximum of 17: a step down.)
    await sheet.getByRole("button", { name: "Current HP down" }).click();
    await expect(propose).toBeVisible();
    await expect(propose.getByTestId("propose-fields")).toContainText("HP");
    await propose.getByRole("button", { name: "Leave it" }).click();
    await expect(propose).toHaveCount(0);
    await dave.waitForTimeout(300);
    expect((await actorNamed(dave, "Mira Vell"))?.sheet.core.hp.current).toBe(17);
  });
});
