import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

interface P {
  x: number;
  y: number;
}

/**
 * The key screens of phase 9 (SPEC §4 Screenshots, §8.13, §17, §24.5): the spell browser with its filters and a card;
 * the cast dialog's slots; a Fireball aimed (its template, range ring and bar); the DM's resolution card and the
 * caster's; Magic Missile's darts being picked; the concentration question; lasting effects on the board (fog,
 * darkness, a web, Moonbeam, Spirit Guardians, a wall of fire, a flaming sphere, silence, a stinking cloud); a player's
 * view with darkness and fog in the way; an effect's chip (Call Lightning: strike again); Hold Person's card with the
 * cover hint; the homebrew builder; the import report.
 */
test("P9 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p9", info.project.name);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const phone = viewport.width < 640;
  const shot = async (page: Page, name: string) => {
    await page.bringToFront();
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
      const lines = (e as Error).message.split("\n");
      notes.push(`${name}: ${lines.slice(0, 3).join(" | ")}`);
      await page.screenshot({ path: join(dir, `_failed-${name}.png`) }).catch(() => {});
    }
  };
  const screen = async (p: Page, x: number, y: number, elevation = 0.15) => {
    const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, elevation)) as {
      sx: number;
      sy: number;
    };
    return { x: s.sx, y: s.sy };
  };
  const paced = async (p: Page, type: string, payload: unknown) => {
    await p.waitForTimeout(260);
    return req<Record<string, unknown>>(p, type, payload);
  };
  const diceClear = async (p: Page, name: string) =>
    expect
      .poll(
        async () => {
          const st = await hook<{ throws: { done: boolean }[] } | null>(p, "diceStage").catch(() => null);
          return !st || st.throws.every((t) => t.done);
        },
        { timeout: 20_000 },
      )
      .toBe(true)
      .catch(() => notes.push(`${name}: dice were still on the board`));
  const closeCards = async (p: Page) => {
    for (const c of await hook<{ id: string; status: string }[]>(p, "casts"))
      if (c.status === "open") await paced(admin, "cast.close", { castId: c.id }).catch(() => {});
  };
  const openDock = async (p: Page, name: "Sheet" | "DM panel") => {
    const region = { Sheet: "Character sheet", "DM panel": "DM panel" }[name];
    const aside = p.getByRole("region", { name: region, exact: true });
    if (!(await aside.isVisible()))
      await (name === "DM panel"
        ? p.getByRole("button", { name: /^DM panel/ })
        : p.getByRole("button", { name, exact: true })
      ).click();
    await expect(aside).toBeVisible();
    return aside;
  };
  const closeDock = async (p: Page) => {
    for (const [name, rail] of [
      ["Character sheet", "Sheet"],
      ["DM panel", /^DM panel/],
    ] as const)
      if (await p.getByRole("region", { name, exact: true }).isVisible())
        await p.getByRole("button", { name: rail, exact: typeof rail === "string" }).click();
  };
  const sheetTab = async (p: Page, name: string) => {
    const sheet = p.getByTestId("sheet");
    const tab = sheet.getByRole("tab", { name, exact: true });
    if (await tab.count()) await tab.click();
    else {
      await sheet.getByRole("button", { name: "More sections" }).click();
      await p.getByRole("menuitem", { name, exact: true }).click();
    }
    return p.getByTestId(`sheet-tab-${name.toLowerCase()}`);
  };

  const code = await adminAtTable(admin);
  await introDone(admin);
  await req(admin, "campaign.update", { name: "The Lantern Crypt" });
  const sceneId = await createScene(admin, {
    name: "Drowned Chapel",
    mapKind: "procedural",
    floorStyle: "stone",
    widthFt: 120,
    heightFt: 70,
  });
  await boardSettled(admin, sceneId);
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport });
  await boardSettled(dave, sceneId);
  const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
  const { actorId } = await req<{ actorId: string }>(dave, "actor.create", {
    ownerUserId: daveId,
    sheet: {
      core: {
        name: "Mira Vell",
        classes: [{ name: "Wizard", level: 5 }],
        abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
        hp: { max: 28, current: 28, temp: 0 },
        ac: { value: 12 },
        senses: { darkvision: 60 },
        spellcasting: {
          ability: "int",
          slots: [
            { level: 1, max: 4 },
            { level: 2, max: 3 },
            { level: 3, max: 2 },
          ],
          spells: [
            { name: "Magic Missile", level: 1, prepared: true },
            { name: "Web", level: 2, prepared: true },
            { name: "Hold Person", level: 2, prepared: true },
            { name: "Fireball", level: 3, prepared: true },
          ],
        },
      },
    },
  });
  await expect
    .poll(async () => (await hook<{ actorId: string }[]>(admin, "tokens")).some((t) => t.actorId === actorId))
    .toBe(true);
  const mira = (await hook<{ id: string; actorId: string; pos: P }[]>(admin, "tokens")).find(
    (t) => t.actorId === actorId,
  ) as { id: string; pos: P };
  await req(admin, "move.commit", { tokenId: mira.id, points: [mira.pos, { x: 14, y: 35 }] });
  const npc = async (name: string, pos: P, extra: Record<string, unknown> = {}) =>
    (
      await req<{ tokenId: string }>(admin, "token.create", {
        sceneId,
        name,
        pos,
        disposition: "hostile",
        stats: { hp: 22, hpMax: 22, ac: 13, saves: { dex: 1, wis: 0 }, ...extra },
      })
    ).tokenId;
  await npc("Drowned Acolyte", { x: 55, y: 30 });
  await npc("Drowned Acolyte", { x: 61, y: 36 });
  const g3 = await npc("Drowned Acolyte", { x: 58, y: 16 });
  const priest = await npc("Tide Priest", { x: 96, y: 34 }, { hp: 40, hpMax: 40 });
  await req(admin, "wall.create", {
    sceneId,
    walls: [
      { a: { x: 48, y: 22 }, b: { x: 70, y: 22 }, kind: "wall" },
      { a: { x: 30, y: 42 }, b: { x: 30, y: 60 }, kind: "wall" },
    ],
  });
  await boardSettled(dave, sceneId);
  for (const p of [admin, dave])
    await camera(p, { pitchDeg: 62, frame: { minX: 4, minY: 6, maxX: 110, maxY: 64 } });
  await admin.waitForTimeout(400);

  // ── The spell browser (the DM's): filters open, a card beside the list ──
  await step("01-spell-browser", admin, async () => {
    await dmSection(admin, "Spells");
    await admin.getByTestId("spells-panel").getByRole("button", { name: "Browse spells" }).click();
    const b = admin.getByTestId("spell-browser");
    await b.getByTestId("spell-search").fill("fire");
    await b.getByRole("button", { name: "Filters" }).click();
    await b
      .getByTestId("spell-filters")
      .getByRole("group", { name: "Level" })
      .getByRole("button", { name: "3" })
      .click();
    await b.getByTestId("spell-row").first().click();
    await expect(b.getByTestId(phone ? "spell-shown" : "spell-count")).toBeVisible();
  });
  await admin.keyboard.press("Escape");
  await closeDock(admin);

  // ── Dave: the cast dialog (Fireball's slots) ──
  await step("02-cast-dialog", dave, async () => {
    await openDock(dave, "Sheet");
    const tab = await sheetTab(dave, "Spells");
    await tab.getByTestId("sheet-spell").filter({ hasText: "Fireball" }).getByTestId("cast-spell").click();
    const d = dave.getByRole("dialog", { name: /Cast Fireball/ });
    await expect(d).toBeVisible();
    await d.getByRole("radio", { name: /3rd/ }).click();
  });

  // ── Fireball aimed: the sphere at the pointer, the range ring, the bar ──
  await step("03-fireball-aim", dave, async () => {
    await dave
      .getByRole("dialog", { name: /Cast Fireball/ })
      .getByRole("button", { name: "Place on the board" })
      .click();
    await expect(dave.getByTestId("targeting-bar")).toBeVisible();
    if (phone) await closeDock(dave);
    const at = await screen(dave, 58, 32, 0);
    await dave.mouse.move(at.x - 30, at.y);
    await dave.mouse.move(at.x, at.y, { steps: 4 });
    await expect(dave.getByTestId("targeting-count")).toContainText("inside");
  });
  {
    const at = await screen(dave, 58, 32, 0);
    await dave.mouse.click(at.x, at.y).catch(() => {});
  }

  // ── The DM's card: NPC saves rolled; the caster's card: damage to roll ──
  await step("04-card-dm", admin, async () => {
    const card = admin.getByTestId("resolution-card").filter({ hasText: "Fireball" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Roll NPC saves" }).click();
    await expect(card.getByTestId("save-result").first()).toBeVisible();
    await diceClear(admin, "04-card-dm");
  });
  await step("05-card-caster", dave, async () => {
    await closeDock(dave);
    await dave.mouse.move(700, 600);
    await expect(dave.getByTestId("resolution-card").filter({ hasText: "Fireball" })).toBeVisible();
    await diceClear(dave, "05-card-caster");
  });
  await closeCards(admin);

  // ── Magic Missile's darts being picked (2nd level: four) ──
  await step("06-darts", dave, async () => {
    await openDock(dave, "Sheet");
    const tab = await sheetTab(dave, "Spells");
    await tab
      .getByTestId("sheet-spell")
      .filter({ hasText: "Magic Missile" })
      .getByTestId("cast-spell")
      .click();
    const d = dave.getByRole("dialog", { name: /Cast Magic Missile/ });
    await d.getByRole("radio", { name: /2nd/ }).click();
    await d.getByRole("button", { name: "Choose targets" }).click();
    await closeDock(dave);
    for (const _ of [0, 1]) {
      const a = await screen(dave, 55, 30, 0.3);
      await dave.mouse.click(a.x, a.y);
    }
    await expect(dave.getByTestId("targeting-hint")).toContainText("2 / 4");
  });
  await dave.keyboard.press("Escape");

  // ── Web, then Hold Person: the concentration question ──
  await req(admin, "spell.cast", {
    casterTokenId: mira.id,
    spellId: "web",
    mode: "free",
    level: 2,
    placement: { origin: { x: 40, y: 20, z: 0 } },
  });
  await step("07-concentration", dave, async () => {
    await openDock(dave, "Sheet");
    const tab = await sheetTab(dave, "Spells");
    await tab.getByTestId("sheet-spell").filter({ hasText: "Hold Person" }).getByTestId("cast-spell").click();
    const d = dave.getByRole("dialog", { name: /Cast Hold Person/ });
    await d.getByRole("radio", { name: /2nd/ }).click();
    await d.getByRole("button", { name: "Choose the target" }).click();
    await closeDock(dave);
    const a = await screen(dave, 61, 36, 0.3);
    await dave.mouse.click(a.x, a.y);
    await expect(dave.getByRole("dialog", { name: "End concentration?" })).toBeVisible();
  });
  await dave
    .getByRole("dialog", { name: "End concentration?" })
    .getByRole("button", { name: /^Keep/ })
    .click()
    .catch(() => {});
  await dave.keyboard.press("Escape");

  // ── Hold Person at the acolyte past the wall's end, from the priest (the DM's card: the cover hint) ──
  await step("08-cover-card", admin, async () => {
    await paced(admin, "spell.cast", {
      casterTokenId: priest,
      spellId: "hold-person",
      mode: "free",
      level: 2,
      targets: [g3],
    });
    const card = admin.getByTestId("resolution-card").filter({ hasText: "Hold Person" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("◐");
  });
  await closeCards(admin);

  // ── Lasting effects on the board (the DM's view) ──
  // Each cast by a caster of its own (they're all concentration), standing apart round the chapel's edge; Silence
  // last, so no caster stands in it when casting a Verbal spell.
  const lasting: [string, number, P, P | null, Record<string, unknown>?][] = [
    ["fog-cloud", 1, { x: 22, y: 14 }, { x: 5, y: 4 }],
    ["darkness", 2, { x: 88, y: 14 }, { x: 66, y: 3 }],
    ["moonbeam", 2, { x: 76, y: 52 }, { x: 86, y: 67 }],
    ["spirit-guardians", 3, { x: 96, y: 34 }, null],
    ["flaming-sphere", 2, { x: 44, y: 52 }, { x: 36, y: 67 }],
    ["stinking-cloud", 3, { x: 12, y: 58 }, { x: 40, y: 43 }],
    // Face-on to the camera (running east–west): its flames as tall as the wall.
    [
      "wall-of-fire",
      4,
      { x: 62, y: 64 },
      { x: 79, y: 60 },
      {
        placement: {
          origin: { x: 50, y: 64, z: 0 },
          points: [
            { x: 50, y: 64 },
            { x: 74, y: 64 },
          ],
        },
      },
    ],
    ["silence", 2, { x: 104, y: 56 }, { x: 116, y: 67 }],
  ];
  for (const [i, [spellId, level, at, stand, extra]] of lasting.entries()) {
    const who = stand ? await npc(`Cantor ${i + 1}`, stand, {}) : priest;
    await paced(admin, "spell.cast", {
      casterTokenId: who,
      spellId,
      mode: "free",
      level,
      endConcentration: true,
      ...(extra ?? { placement: { origin: { x: at.x, y: at.y, z: 0 } } }),
    }).catch((e: Error) => notes.push(`cast ${spellId}: ${e.message}`));
  }
  await closeCards(admin);
  // The casts' bursts (a scorch lasts 5 s) and their toasts (5 s) gone: the lasting looks alone.
  await admin.waitForTimeout(6000);
  await step("09-lasting-effects", admin, async () => {
    await expect
      .poll(async () => (await hook<{ name: string }[]>(admin, "effectsDrawn")).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(lasting.length);
    await admin.mouse.move(1, 1);
    await admin.waitForTimeout(800);
  });
  // Closer: Flaming Sphere, Moonbeam and the wall of fire.
  await step("09b-effects-close", admin, async () => {
    await camera(admin, { pitchDeg: 50, frame: { minX: 36, minY: 40, maxX: 84, maxY: 68 } });
    await admin.waitForTimeout(1200);
  });
  await camera(admin, { pitchDeg: 62, frame: { minX: 4, minY: 6, maxX: 110, maxY: 64 } });

  // ── Dave's view: the darkness and the fog in the way (what his client is sent) ──
  await step("10-player-view", dave, async () => {
    await closeDock(dave);
    await dave.mouse.move(1, 1);
    await dave.waitForTimeout(1500);
  });

  // ── Call Lightning for Mira: its chip — Strike again, the bolt's ring under the cloud ──
  await step("11-effect-chip", dave, async () => {
    const r = await paced(admin, "spell.cast", {
      casterTokenId: mira.id,
      spellId: "call-lightning",
      mode: "free",
      level: 3,
      placement: { origin: { x: 20, y: 35, z: 0 } },
      endConcentration: true,
    });
    await closeCards(admin);
    type H = { id: string; sx: number; sy: number };
    await expect
      .poll(async () => (await hook<H[]>(dave, "effectHandles")).some((h) => h.id === r.effectId))
      .toBe(true);
    const h = (await hook<H[]>(dave, "effectHandles")).find((x) => x.id === r.effectId) as H;
    // Drawn and under the pointer (a handle's data comes before the frame that draws it).
    await expect
      .poll(async () =>
        (await hook<{ owner: string }[]>(dave, "pickAt", h.sx, h.sy)).some(
          (x) => x.owner === `handle:${r.effectId}`,
        ),
      )
      .toBe(true);
    await dave.mouse.click(h.sx, h.sy);
    await dave.getByTestId("effect-chip").getByRole("button", { name: "Strike again" }).click();
    const bolt = await screen(dave, 55, 30, 0);
    await dave.mouse.move(bolt.x - 20, bolt.y);
    await dave.mouse.move(bolt.x, bolt.y, { steps: 3 });
  });
  await dave.keyboard.press("Escape");

  // ── The homebrew builder (Fireball as a template) and the import report ──
  await step("12-homebrew-builder", admin, async () => {
    await dmSection(admin, "Spells");
    await admin.getByTestId("spells-panel").getByRole("button", { name: "Browse spells" }).click();
    const b = admin.getByTestId("spell-browser");
    await b.getByTestId("spell-search").fill("fireball");
    await b.locator('[data-testid="spell-row"][data-spell="fireball"]').click();
    await b.getByRole("button", { name: "Duplicate as homebrew" }).click();
    const builder = admin.getByTestId("homebrew-builder");
    await builder.getByLabel("Name", { exact: true }).fill("Poison Ball");
    await builder.getByLabel("Id", { exact: true }).fill("poison-ball");
    await builder.getByTestId("damage-row").first().getByLabel("Type").selectOption("poison");
    await expect(builder.getByTestId("spell-card")).toContainText("Poison Ball");
  });
  await admin.keyboard.press("Escape");
  await step("13-import-report", admin, async () => {
    await dmSection(admin, "Spells");
    await admin.getByTestId("spells-panel").getByRole("button", { name: "Import…" }).click();
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
    await admin
      .getByTestId("import-spells")
      .getByLabel("Spells as JSON")
      .fill(
        JSON.stringify([
          { ...base, id: "star-shard", name: "Star Shard" },
          { ...base, id: "broken", name: "Broken", level: 12 },
          { ...base, id: "fireball", name: "Fireball (ours)" },
        ]),
      );
    await admin.getByRole("button", { name: "Dry run" }).click();
    await expect(admin.getByTestId("import-report")).toContainText("of 3 valid");
  });

  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
