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
  dmSection,
  hook,
  introDone,
  req,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The key screens of phase 8 (SPEC §4 Screenshots, §8.6, §8.12): the Start combat dialog; a player's initiative card
 * with its hint; the tracker with the DM's controls and the Combat panel; a turn's start for its player (the banner,
 * the tracker's ring, the turn controls); a drag in combat (the path round a wall, verdigris then ember, the reach
 * mark, an opportunity attack, the label); the movement range overlay; bonus movement and the Dash confirmation; the
 * DM's Delay menu; Settings' camera; the combat's end.
 */
test("P8 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p8", info.project.name);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const phone = viewport.width < 640;
  const shot = async (page: Page, name: string, settle = true) => {
    // In front (a page behind draws no frames: its entrances would wait), the pointer off anything that hovers.
    await page.bringToFront();
    if (settle) {
      await page.mouse.move(1, 1);
      await page.evaluate(() =>
        Promise.race([
          Promise.all(
            document
              .getAnimations()
              .filter((a) =>
                Number.isFinite(a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY),
              )
              .map((a) => a.finished.catch(() => undefined)),
          ),
          new Promise((r) => setTimeout(r, 2000)),
        ]),
      );
      await page
        .waitForFunction(
          () => {
            const o = (
              window as unknown as {
                __gloam?: { overlays?: () => { fade?: { a: number; target: number } }[] };
              }
            ).__gloam?.overlays?.();
            return !o || o.every((x) => !x.fade || Math.abs(x.fade.a - x.fade.target) < 0.01);
          },
          null,
          { timeout: 3000 },
        )
        .catch(() => notes.push(`${name}: a plate was still fading`));
    }
    await page.screenshot({ path: join(dir, `${name}.png`) });
  };
  const step = async (name: string, page: Page, fn: () => Promise<unknown>, settle = true) => {
    try {
      await fn();
      await shot(page, name, settle);
    } catch (e) {
      const lines = (e as Error).message.split("\n");
      const what = lines
        .filter((l) => /waiting for|Locator:|intercepts|not stable|not visible/.test(l))
        .slice(0, 4);
      notes.push(`${name}: ${[lines[0], ...what].join(" | ")}`);
      await page.screenshot({ path: join(dir, `_failed-${name}.png`) }).catch(() => {});
    }
  };
  const tokenOf = (p: Page, id: string) =>
    hook<{ id: string; actorId: string; pos: { x: number; y: number }; elevation: number } | null>(
      p,
      "token",
      id,
    );
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
  const closeDock = async (p: Page) => {
    const close = p.getByRole("button", { name: "Close panel" });
    if (await close.isVisible()) await close.click();
    else
      for (const name of ["Character sheet", "Party", "DM panel"]) {
        if (await p.getByRole("region", { name, exact: true }).isVisible()) {
          const rail = name === "DM panel" ? /^DM panel/ : name === "Character sheet" ? "Sheet" : "Party";
          await p.getByRole("button", { name: rail, exact: typeof rail === "string" }).click();
        }
      }
  };

  const fx = await assetFixtures();
  const code = await adminAtTable(admin);
  await introDone(admin);
  await req(admin, "campaign.update", { name: "The Lantern Crypt" });
  const sceneId = await createScene(admin, {
    name: "Collapsed Nave",
    mapKind: "procedural",
    floorStyle: "stone",
    widthFt: 60,
    heightFt: 40,
  });
  await boardSettled(admin, sceneId);
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport });
  await boardSettled(dave, sceneId);
  const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
  const knight = await uploadVia(admin, await fx.portraitPng("knight", { size: 512 }), "Thorin", "portrait");
  const mage = await uploadVia(admin, await fx.portraitPng("mage", { size: 512 }), "Mira", "portrait");
  const { actorId: thorin } = await req<{ actorId: string }>(admin, "actor.quickCreate", {
    name: "Thorin Emberhand",
    classLevel: "Fighter 5",
    hpMax: 44,
    ac: 18,
    ownerUserId: daveId,
    portraitAssetId: knight.id,
    tokenAssetId: knight.id,
  });
  const { actorId: mira } = await req<{ actorId: string }>(admin, "actor.quickCreate", {
    name: "Mira Vell",
    classLevel: "Warlock 3",
    hpMax: 21,
    ac: 13,
    ownerUserId: daveId,
    portraitAssetId: mage.id,
    tokenAssetId: mage.id,
  });
  await expect.poll(async () => (await hook<{ actorId: string }[]>(admin, "tokens")).length).toBe(2);
  const all = await hook<{ id: string; actorId: string; pos: { x: number; y: number } }[]>(admin, "tokens");
  const hero = all.find((t) => t.actorId === thorin) as { id: string; pos: { x: number; y: number } };
  const mage2 = all.find((t) => t.actorId === mira) as { id: string; pos: { x: number; y: number } };
  // Where they stand: Thorin west of a broken wall, Mira behind him; two goblins and an ogre east of it.
  const heroAt = { x: 16, y: 22 };
  await req(admin, "move.commit", { tokenId: hero.id, points: [hero.pos, heroAt] });
  await req(admin, "move.commit", { tokenId: mage2.id, points: [mage2.pos, { x: 9, y: 15 }] });
  await req(admin, "wall.create", {
    sceneId,
    walls: [{ a: { x: 27, y: 8 }, b: { x: 27, y: 30 }, kind: "wall" }],
  });
  for (const pos of [
    { x: 38, y: 16 },
    { x: 42, y: 22 },
  ])
    await req(admin, "token.create", {
      sceneId,
      name: "Goblin",
      pos,
      disposition: "hostile",
      stats: { hp: 7, hpMax: 7, ac: 15, dexMod: 2 },
    });
  await req(admin, "token.create", {
    sceneId,
    name: "Fire-scarred Ogre",
    pos: { x: 48, y: 14 },
    size: "large",
    disposition: "hostile",
    stats: { hp: 59, hpMax: 59, ac: 11 },
  });
  // A goblin crept up beside Thorin: an opportunity attack if he walks off.
  const { tokenId: sneak } = await req<{ tokenId: string }>(admin, "token.create", {
    sceneId,
    name: "Goblin Sneak",
    pos: { x: 16, y: 27 },
    disposition: "hostile",
    stats: { hp: 7, hpMax: 7, ac: 15, dexMod: 2 },
  });
  // Mira is Invisible: advantage on her initiative.
  await req(admin, "status.change", { tokenId: mage2.id, add: [{ id: "invisible" }] });
  for (const p of [admin, dave])
    await camera(p, { pitchDeg: 62, distance: phone ? 80 : 46, target: [30, 21], ms: 0 });
  await admin.waitForTimeout(400);
  const screen = async (p: Page, x: number, y: number, elevation = 0.15) => {
    const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, elevation)) as {
      sx: number;
      sy: number;
    };
    return { x: s.sx, y: s.sy };
  };
  const activeId = async () => {
    const v = await hook<{ activeIndex: number; entries: { tokenId: string | null }[] }>(admin, "combat");
    return v.entries[v.activeIndex]?.tokenId ?? null;
  };

  // ── Start combat: who, how, who's surprised ──
  await step("01-start-combat", admin, async () => {
    const panel = await openDock(admin, "DM panel");
    await dmSection(admin, "Combat");
    await panel.getByRole("button", { name: "Start combat…" }).click();
    const dialog = admin.getByTestId("start-combat");
    await expect(dialog).toBeVisible();
    await dialog
      .locator(`[data-testid="combat-participant"][data-token="${sneak}"]`)
      .getByRole("checkbox", { name: "Surprised" })
      .check();
  });
  await admin.getByRole("button", { name: /^Start with \d+ creatures$/ }).click();
  await closeDock(admin);

  // ── Initiative: Dave's card, Mira's advantage from Invisible ──
  await step("02-initiative-card", dave, async () => {
    await expect(dave.getByTestId("request-group").filter({ hasText: "Initiative" }).first()).toBeVisible();
    await expect(dave.getByTestId("roll-hint").first()).toBeVisible();
  });
  // Dave enters Thorin's and Mira's rolls; the DM rolls the NPCs.
  for (let i = 0; i < 4; i++) {
    const enter = dave.getByRole("button", { name: "Enter physical roll" }).first();
    if (!(await enter.isVisible().catch(() => false))) break;
    await enter.click();
    const total = dave.getByLabel("Your total").first();
    await total.fill(i === 0 ? "19" : "14");
    await total.press("Enter");
    await dave.waitForTimeout(300);
  }
  await req(admin, "combat.rollRemaining", { players: false });
  const begun = async () => (await hook<{ begun: boolean }>(admin, "combat")).begun;
  await expect
    .poll(begun, { timeout: 5000 })
    .toBe(true)
    .catch(async () => {
      // (A card left unanswered: the DM rolls the rest.)
      await req(admin, "combat.rollRemaining", { players: true });
    });
  await expect.poll(begun, { timeout: 20_000 }).toBe(true);

  // ── The tracker and the DM's Combat panel ──
  // (A phone's open panel takes the screen, and the tracker steps back: there, the tracker with the panel closed.)
  await step("03-tracker-dm", admin, async () => {
    if (phone) await closeDock(admin);
    else {
      await openDock(admin, "DM panel");
      await dmSection(admin, "Combat");
    }
    await expect(admin.getByTestId("turn-tracker")).toBeVisible();
  });

  // ── Thorin's turn, for Dave: the banner, the ring, the turn controls ──
  await req(admin, "combat.next", {});
  for (let i = 0; i < 8 && (await activeId()) !== hero.id; i++) {
    await req(admin, "combat.next", {});
    await admin.waitForTimeout(150);
  }
  await step(
    "04-your-turn",
    dave,
    async () => {
      await expect(dave.getByTestId("turn-banner")).toBeVisible();
      await dave.waitForTimeout(700);
    },
    false,
  );

  // ── A drag in combat: round the wall's end, past the budget, off the sneak's reach ──
  await step(
    "05-combat-drag",
    dave,
    async () => {
      await dave.bringToFront();
      // The whole way in view (the turn's start brought the camera close to Thorin).
      await camera(dave, { pitchDeg: 62, distance: phone ? 84 : 52, target: [30, 27], ms: 0 });
      await dave.waitForTimeout(400);
      const to = { x: 44, y: 34 };
      const a = await screen(dave, heroAt.x, heroAt.y);
      await dave.mouse.move(a.x, a.y);
      await dave.mouse.down();
      for (let i = 1; i <= 10; i++) {
        const q = await screen(
          dave,
          heroAt.x + ((to.x - heroAt.x) * i) / 10,
          heroAt.y + ((to.y - heroAt.y) * i) / 10,
          0,
        );
        await dave.mouse.move(q.x, q.y);
        await dave.waitForTimeout(40);
      }
      await expect(dave.getByTestId("move-label")).toContainText("over");
    },
    false,
  );
  await dave.keyboard.press("Escape");
  await dave.mouse.up();

  // ── The movement range overlay (G): what's left of Thorin's turn ──
  await step("06-range-overlay", dave, async () => {
    await dave.bringToFront();
    const at = await screen(dave, heroAt.x, heroAt.y, 0.2);
    await dave.mouse.click(at.x, at.y);
    await dave.keyboard.press("g");
    await expect
      .poll(async () => (await hook<{ budget: number } | null>(dave, "rangeOverlay"))?.budget)
      .toBe(30);
  });
  await dave.keyboard.press("g");

  // ── Bonus movement from the DM, and Dash after the Action is used ──
  await step("07-bonus-and-dash", dave, async () => {
    await req(admin, "token.update", {
      tokenId: hero.id,
      overrides: { bonusMove: { ft: 10, until: "turn" } },
    });
    await expect(dave.getByTestId("move-budget")).toContainText("30 + 10");
    await req(dave, "dice.roll", { formula: "1d20 + 7", purpose: "attack", context: { tokenId: hero.id } });
    await expect(dave.getByTestId("turn-controls").locator('[data-pip="action"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    if (phone) {
      await dave.getByRole("button", { name: "Turn actions" }).click();
      await dave.getByRole("menuitem", { name: "Dash" }).click();
    } else await dave.getByTestId("turn-controls").getByRole("button", { name: "Dash", exact: true }).click();
    await expect(dave.getByRole("alertdialog", { name: "Action already used" })).toBeVisible();
  });
  const cancelDash = dave
    .getByRole("alertdialog", { name: "Action already used" })
    .getByRole("button", { name: "Cancel" });
  if (await cancelDash.isVisible().catch(() => false)) await cancelDash.click();

  // ── The DM's Delay ──
  await step("08-dm-delay", admin, async () => {
    const panel = await openDock(admin, "DM panel");
    await dmSection(admin, "Combat");
    await panel.getByRole("button", { name: /^Delay Goblin Sneak/ }).click();
    await expect(admin.getByRole("menuitem").first()).toBeVisible();
  });
  await admin.keyboard.press("Escape");

  // ── Settings: the camera ──
  await step("09-settings-camera", dave, async () => {
    await dave.getByRole("button", { name: "Settings" }).first().click();
    await expect(dave.getByRole("switch", { name: /Focus camera on my turn/ })).toBeVisible();
  });
  await dave.keyboard.press("Escape");

  // ── The combat's end: its summary ──
  await step("10-combat-ended", dave, async () => {
    await req(admin, "hp.apply", {
      targets: [sneak],
      kind: "damage",
      amount: 9,
      decide: { [sneak]: { keep: ["npcAtZero"], choices: { npcAtZero: "dead" } } },
    });
    await req(admin, "combat.stop", {});
    await expect(dave.locator("[data-toast]").filter({ hasText: "Combat ended" })).toBeVisible();
  });
  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
