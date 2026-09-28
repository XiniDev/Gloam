import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  assetFixtures,
  boardSettled,
  camera,
  createScene,
  hook,
  introDone,
  req,
  sharp,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The key screens of phase 6 (SPEC §4 Screenshots, §8.10, §29.7, §8.9 Roll requests): a filled-in character sheet
 * and its sections; a counter pinned under a token's HP bar; quick create; import with its preview and the AI
 * dialog; a proposal on a locked field, as the player sends it and the DM sees it; the DM's roll-request board and a
 * player's card; the drawing pad and the paper cutout; the party panel; the radial menu's Sheet.
 */
test("P6 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p6", info.project.name);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const shot = async (page: Page, name: string) => {
    // The pointer off anything with a tooltip or a hover state.
    await page.mouse.move(1, 1);
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
  const step = async (name: string, page: Page, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await shot(page, name);
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: join(dir, `_failed-${name}.png`) }).catch(() => {});
    }
  };
  const openDock = async (p: Page, name: "Sheet" | "Party" | "DM panel") => {
    const region = { Sheet: "Character sheet", Party: "Party", "DM panel": "DM panel" }[name];
    const aside = p.getByRole("region", { name: region, exact: true });
    if (!(await aside.isVisible()))
      await (name === "DM panel"
        ? p.getByRole("button", { name: /^DM panel/ })
        : p.getByRole("button", { name, exact: true })
      ).click();
    await expect(aside).toBeVisible();
    return aside;
  };
  const sheetTab = async (p: Page, name: string) => {
    const sheet = p.getByTestId("sheet");
    const tab = sheet.getByRole("tab", { name, exact: true });
    if (await tab.count()) await tab.click();
    else {
      await sheet.getByRole("button", { name: "More sections" }).click();
      await p.getByRole("menuitem", { name, exact: true }).click();
    }
    await expect(sheet.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  };
  const closeDialogs = async (p: Page) => {
    for (let i = 0; i < 3 && (await p.getByRole("dialog").count()); i++) await p.keyboard.press("Escape");
  };

  const fx = await assetFixtures();
  const code = await adminAtTable(admin);
  await introDone(admin);
  await req(admin, "campaign.update", { name: "The Lantern Crypt" });
  const sceneId = await createScene(admin, {
    name: "Guard room",
    mapKind: "procedural",
    floorStyle: "stone",
    widthFt: 50,
    heightFt: 40,
  });
  await boardSettled(admin, sceneId);
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport });
  await boardSettled(dave, sceneId);
  const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
  const knight = await uploadVia(admin, await fx.portraitPng("knight", { size: 512 }), "Thorin", "portrait");
  const mage = await uploadVia(admin, await fx.portraitPng("mage", { size: 512 }), "Mira", "portrait");

  // A character with everything filled in.
  const { actorId: thorin } = await req<{ actorId: string }>(admin, "actor.create", {
    kind: "character",
    ownerUserId: daveId,
    sheet: {
      core: {
        name: "Thorin Emberhand",
        portraitAssetId: knight.id,
        tokenAssetId: knight.id,
        species: "Dwarf",
        background: "Soldier",
        alignment: "Lawful good",
        classes: [
          { name: "Fighter", level: 5, subclass: "Battle Master" },
          { name: "Cleric", level: 1 },
        ],
        abilities: { str: 17, dex: 12, con: 16, int: 10, wis: 14, cha: 8 },
        saves: { str: { proficient: true }, con: { proficient: true } },
        skills: {
          athletics: { prof: "proficient" },
          perception: { prof: "proficient" },
          intimidation: { prof: "expertise" },
          insight: { prof: "half" },
        },
        ac: { value: 18, note: "chain mail, shield" },
        speeds: { walk: 25 },
        senses: { darkvision: 60 },
        hp: { max: 52, current: 37, temp: 5 },
        hitDice: [{ die: "d10", total: 5, used: 1 }],
        conditions: ["poisoned"],
        inspiration: true,
        attacks: [
          {
            name: "Warhammer",
            attack: "1d20 + @str + @prof",
            damage: "1d8 + @str [bludgeoning]",
            properties: "versatile",
          },
          {
            name: "Handaxe",
            attack: "1d20 + @str + @prof",
            damage: "1d6 + @str [slashing]",
            range: "20/60 ft",
          },
        ],
        spellcasting: {
          ability: "wis",
          slots: [{ level: 1, max: 2, used: 1 }],
          spells: [
            { name: "Guidance", level: 0 },
            { name: "Bless", level: 1, prepared: true },
            { name: "Cure Wounds", level: 1, prepared: true },
            { name: "Shield of Faith", level: 1 },
          ],
        },
        inventory: [
          { name: "Warhammer", qty: 1, weight: 2, equipped: true },
          { name: "Chain mail", qty: 1, weight: 55, equipped: true },
          { name: "Torch", qty: 5, weight: 1, light: "torch" },
          { name: "Rations", qty: 6, weight: 2 },
        ],
        currency: { gp: 48, sp: 12, cp: 30 },
        features: [
          {
            name: "Second Wind",
            text: "Regain 1d10 + fighter level HP as a bonus action.",
            uses: { max: 1, used: 0, recharge: "short" },
          },
          {
            name: "Action Surge",
            text: "One additional action on your turn.",
            uses: { max: 1, used: 1, recharge: "short" },
          },
        ],
        notes: "Owes the Lantern Guild 200 gp. Doesn't trust elves with boats.",
      },
      custom: [
        { id: "b1", type: "counter", title: "Sanity", value: 8, max: 10, pinToToken: true },
        { id: "b2", type: "text", title: "Oath", markdown: "Never leave a companion in the dark." },
        {
          id: "b3",
          type: "checklist",
          title: "Rites",
          items: [
            { label: "Dawn prayer", done: true },
            { label: "Anvil blessing", done: false },
          ],
        },
        {
          id: "b4",
          type: "keyValue",
          title: "Contacts",
          entries: [
            { key: "Iskra", value: "Fence, Lowmarket" },
            { key: "Brother Aldous", value: "Chapel of the Lantern" },
          ],
        },
      ],
    },
  });
  await req(admin, "actor.quickCreate", {
    name: "Mira Vell",
    classLevel: "Warlock 3",
    hpMax: 21,
    ac: 13,
    ownerUserId: daveId,
    portraitAssetId: mage.id,
    tokenAssetId: mage.id,
  });
  await expect.poll(async () => (await hook<{ actorId: string }[]>(admin, "tokens")).length).toBe(2);
  const tokenOf = async (actorId: string) =>
    (await hook<{ id: string; actorId: string; pos: { x: number; y: number } }[]>(admin, "tokens")).find(
      (t) => t.actorId === actorId,
    ) as { id: string; pos: { x: number; y: number } };
  const thorinToken = await tokenOf(thorin);
  await req(admin, "token.create", {
    sceneId,
    name: "Goblin",
    pos: { x: thorinToken.pos.x + 12, y: thorinToken.pos.y + 4 },
    disposition: "hostile",
    stats: { hp: 7, hpMax: 7, ac: 15 },
  });
  for (const p of [admin, dave])
    await camera(p, {
      pitchDeg: 58,
      distance: 34,
      target: [thorinToken.pos.x + 4, thorinToken.pos.y],
      ms: 0,
    });

  // ── The sheet ──
  await step("01-sheet-overview", dave, async () => {
    await openDock(dave, "Sheet");
    await dave.getByLabel("Character", { exact: true }).selectOption({ label: "Thorin Emberhand" });
    await expect(dave.getByTestId("sheet")).toHaveAttribute("aria-label", "Thorin Emberhand's sheet");
    await expect(dave.getByTestId("sheet").locator("header img")).toBeVisible();
  });
  await step("02-sheet-abilities", dave, () => sheetTab(dave, "Abilities"));
  await step("03-sheet-actions", dave, () => sheetTab(dave, "Actions"));
  await step("04-sheet-spells", dave, () => sheetTab(dave, "Spells"));
  await step("05-sheet-inventory", dave, () => sheetTab(dave, "Inventory"));
  await step("06-sheet-custom", dave, () => sheetTab(dave, "Custom"));
  await step("07-token-pinned-bar", admin, async () => {
    await expect
      .poll(async () =>
        Boolean(
          (
            await hook<{ parts: Record<string, { visible: boolean }> } | null>(
              admin,
              "tokenState",
              thorinToken.id,
            )
          )?.parts["pinned:0"]?.visible,
        ),
      )
      .toBe(true);
    await camera(admin, {
      pitchDeg: 55,
      distance: 20,
      target: [thorinToken.pos.x, thorinToken.pos.y],
      ms: 0,
    });
    await admin.waitForTimeout(400);
  });
  await step("08-radial-sheet", admin, async () => {
    const s = await hook<{ sx: number; sy: number }>(
      admin,
      "project",
      thorinToken.pos.x,
      thorinToken.pos.y,
      0.15,
    );
    await admin.mouse.click(s.sx, s.sy, { button: "right" });
    await expect(admin.getByRole("menuitem", { name: /^Sheet/ })).toBeVisible();
  });
  await admin.keyboard.press("Escape");

  // ── Making and bringing characters ──
  await step("09-quick-create", dave, async () => {
    await dave.getByRole("button", { name: "New character" }).click();
    const d = dave.getByRole("dialog", { name: "Quick create" });
    await d.getByLabel("Name", { exact: true }).fill("Wren Ashdown");
    await d.getByLabel("Class and level").fill("Ranger 2");
    await d.getByLabel("Max HP").fill("18");
    await d.getByLabel("AC", { exact: true }).fill("14");
    await d.getByLabel("Darkvision (ft)").fill("0");
  });
  await closeDialogs(dave);
  const exported = (
    (await hook<{ id: string; sheet: { core: Record<string, unknown> } }[]>(dave, "sheets")).find(
      (a) => a.id === thorin,
    ) as { sheet: { core: Record<string, unknown> } }
  ).sheet;
  await step("10-import-preview", dave, async () => {
    await dave.getByTestId("sheet").getByRole("button", { name: "Sheet actions" }).click();
    await dave.getByRole("menuitem", { name: "Import JSON…" }).click();
    const edited = structuredClone(exported) as { core: Record<string, unknown> & { hp: { max: number } } };
    edited.core.hp.max = 58;
    edited.core.background = "Guild artisan";
    await dave.getByTestId("import-text").fill(JSON.stringify(edited, null, 2));
    await expect(dave.getByTestId("import-diff")).toBeVisible();
  });
  await closeDialogs(dave);
  await step("11-import-errors", dave, async () => {
    await dave.getByTestId("sheet").getByRole("button", { name: "Sheet actions" }).click();
    await dave.getByRole("menuitem", { name: "Import JSON…" }).click();
    const bad = structuredClone(exported) as {
      core: Record<string, unknown> & { abilities: Record<string, number> };
    };
    bad.core.abilities.str = 34;
    bad.core.ac = { value: -2 };
    await dave.getByTestId("import-text").fill(JSON.stringify(bad));
    await expect(dave.getByTestId("import-errors")).toBeVisible();
  });
  await closeDialogs(dave);
  await step("12-import-ai", dave, async () => {
    await dave.getByTestId("sheet").getByRole("button", { name: "Sheet actions" }).click();
    await dave.getByRole("menuitem", { name: "Import with AI…" }).click();
    await expect(dave.getByRole("dialog", { name: "Import with AI" })).toBeVisible();
  });
  await closeDialogs(dave);

  // ── Locks and proposals ──
  await req(admin, "actor.setLock", { actorId: thorin, level: "core" });
  await step("13-propose", dave, async () => {
    await sheetTab(dave, "Overview");
    const ac = dave.getByTestId("sheet").getByLabel("Armour class");
    await ac.fill("20");
    await ac.press("Enter");
    const d = dave.getByRole("dialog", { name: "Propose this change" });
    await expect(d).toBeVisible();
    await d.getByRole("textbox").fill("Plate armour from the vault — the DM said it fits.");
  });
  await dave
    .getByRole("dialog", { name: "Propose this change" })
    .getByRole("button", { name: "Propose to the DM" })
    .click()
    .catch(() => {});
  await step("14-dm-approvals", admin, async () => {
    const panel = await openDock(admin, "DM panel");
    await panel.getByRole("tab", { name: /^Approvals/ }).click();
    await expect(panel.getByTestId("proposal")).toBeVisible();
  });

  // ── Roll requests ──
  await step("15-dm-request-form", admin, async () => {
    const panel = await openDock(admin, "DM panel");
    await panel.getByRole("tab", { name: "Requests" }).click();
    const form = panel.getByTestId("new-request");
    await form.getByRole("button", { name: "All party" }).click();
    await form.getByRole("radiogroup", { name: "What to roll" }).getByRole("radio", { name: "Save" }).click();
    await form.getByLabel("Saving throw").selectOption({ label: "Wisdom" });
    await form.getByLabel("DC", { exact: true }).fill("13");
  });
  await admin
    .getByTestId("new-request")
    .getByRole("button", { name: /^Ask 2 creatures/ })
    .click()
    .catch(() => {});
  await step("16-player-request-card", dave, async () => {
    // A phone shows one card at a time ("1 more waiting").
    await expect(dave.getByTestId("request-card")).toHaveCount(viewport.width < 640 ? 1 : 2);
  });
  await dave
    .getByTestId("request-card")
    .first()
    .getByRole("button", { name: "Roll", exact: true })
    .click()
    .catch(() => {});
  await step("17-dm-request-board", admin, async () => {
    const board = admin.getByTestId("request-board");
    await expect(board.locator('[data-state="rolled"]')).toHaveCount(1);
  });

  // ── Art ──
  await closeDialogs(dave);
  await step("18-drawing-pad", dave, async () => {
    await sheetTab(dave, "Token");
    await dave.getByTestId("sheet").getByRole("button", { name: "Draw…" }).click();
    const canvas = dave.getByTestId("drawing-canvas");
    await expect(canvas).toBeVisible();
    // A small figure, a few strokes of varying pressure.
    const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number };
    const cdp = await dave.context().newCDPSession(dave);
    const at = (x: number, y: number) => ({
      x: box.x + (x / 1024) * box.width,
      y: box.y + (y / 1024) * box.height,
    });
    const stroke = async (pts: [number, number, number][]) => {
      const [f, ...rest] = pts as [[number, number, number], ...[number, number, number][]];
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...at(f[0], f[1]),
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "pen",
        force: f[2],
      });
      for (const [x, y, p] of rest)
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...at(x, y),
          button: "left",
          buttons: 1,
          pointerType: "pen",
          force: p,
        });
      const l = rest.at(-1) ?? f;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...at(l[0], l[1]),
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "pen",
        force: 0,
      });
    };
    const circle: [number, number, number][] = Array.from({ length: 33 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return [512 + Math.cos(a) * 120, 330 + Math.sin(a) * 120, 0.4 + 0.5 * Math.abs(Math.sin(a))];
    });
    await stroke(circle);
    await stroke([
      [512, 450, 0.3],
      [512, 560, 0.6],
      [512, 700, 0.9],
    ]);
    await stroke([
      [512, 520, 0.2],
      [400, 600, 0.7],
      [330, 640, 0.9],
    ]);
    await stroke([
      [512, 520, 0.2],
      [624, 600, 0.7],
      [694, 640, 0.9],
    ]);
    await stroke([
      [512, 700, 0.5],
      [440, 840, 0.9],
    ]);
    await stroke([
      [512, 700, 0.5],
      [584, 840, 0.9],
    ]);
  });
  await closeDialogs(dave);
  await step("19-paper-cutout", dave, async () => {
    await dave.getByTestId("sheet").getByRole("button", { name: "From a photo of paper…" }).click();
    const photo = await (
      sharp(
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700">
          <defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#f6f3ec"/><stop offset="1" stop-color="#e2dccf"/></linearGradient></defs>
          <rect width="900" height="700" fill="url(#p)"/>
          <path d="M360 520 Q450 170 540 520 Z" fill="#8d2b2b" stroke="#1d1a17" stroke-width="8"/>
          <circle cx="450" cy="230" r="70" fill="#f0c9a0" stroke="#1d1a17" stroke-width="8"/>
          <path d="M380 210 Q450 110 520 210" fill="#3b2a1d" stroke="#1d1a17" stroke-width="6"/>
          <circle cx="425" cy="235" r="7" fill="#1d1a17"/><circle cx="475" cy="235" r="7" fill="#1d1a17"/>
          <path d="M540 380 L640 300" stroke="#6b5b3e" stroke-width="10" stroke-linecap="round"/>
          <circle cx="648" cy="292" r="16" fill="#e8b94a" stroke="#1d1a17" stroke-width="5"/>
        </svg>`),
      ) as unknown as { png(): { toBuffer(): Promise<Buffer> } }
    )
      .png()
      .toBuffer();
    const d = dave.getByRole("dialog", { name: "From a photo of paper" });
    await d
      .locator('input[type="file"]')
      .setInputFiles({ name: "wizard.png", mimeType: "image/png", buffer: photo });
    await expect
      .poll(async () => d.getByTestId("cutout-preview").evaluate((c: HTMLCanvasElement) => c.width !== 300))
      .toBe(true);
  });
  await closeDialogs(dave);

  // ── The party ──
  await step("20-party-panel", admin, async () => {
    const party = await openDock(admin, "Party");
    await expect(party.getByTestId("party-character")).toHaveCount(2);
  });
  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
