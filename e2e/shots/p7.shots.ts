import { writeFileSync } from "node:fs";
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
  uploadVia,
} from "../fixtures/board.ts";
import { freshShotsDir } from "../fixtures/shotsDir.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The key screens of phase 7 (SPEC §4 Screenshots, §8.11): the damage dialog with its preview and what follows; the
 * floating numbers; the condition picker (and a custom marker); tokens with their status icons, down and lying; the
 * hover card; the DM's decision cards; a player's cards — a condition's hint, a concentration save, a death save, a Hit
 * Die; the DM panel's Health; the long-rest preview; temporary HP's choice; the sheet's conditions and exhaustion.
 */
test("P7 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  const dir = join("artifacts", "screens", "p7", info.project.name);
  freshShotsDir(dir);
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
  const radial = async (p: Page, id: string, ...path: string[]) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = await tokenOf(p, id);
      if (!t) throw new Error(`no token ${id}`);
      const s = await hook<{ sx: number; sy: number }>(p, "project", t.pos.x, t.pos.y, 0.15);
      await p.mouse.click(s.sx, s.sy, { button: "right" });
      try {
        await p.getByRole("menu").getByRole("menuitem").first().waitFor({ state: "visible", timeout: 4000 });
        break;
      } catch {
        await p.keyboard.press("Escape");
      }
    }
    for (const name of path) await p.getByRole("menuitem", { name, exact: true }).click();
  };
  const closeDialogs = async (p: Page) => {
    for (let i = 0; i < 3 && (await p.getByRole("dialog").count()); i++) await p.keyboard.press("Escape");
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
    name: "Ossuary",
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
  await req(admin, "actor.change", {
    actorId: thorin,
    changes: [
      { path: ["core", "hitDice"], after: [{ die: "d10", total: 5, used: 2 }] },
      { path: ["core", "abilities", "con"], after: 16 },
      {
        path: ["core", "features"],
        after: [
          { name: "Second Wind", uses: { max: 1, used: 1, recharge: "short" } },
          { name: "Action Surge", uses: { max: 1, used: 1, recharge: "short" } },
          { name: "Indomitable", uses: { max: 1, used: 1, recharge: "long" } },
        ],
      },
    ],
  });
  await expect.poll(async () => (await hook<{ actorId: string }[]>(admin, "tokens")).length).toBe(2);
  const all = await hook<{ id: string; actorId: string; pos: { x: number; y: number } }[]>(admin, "tokens");
  const hero = all.find((t) => t.actorId === thorin) as { id: string; pos: { x: number; y: number } };
  const mage2 = all.find((t) => t.actorId === mira) as { id: string; pos: { x: number; y: number } };
  const { tokenId: goblin } = await req<{ tokenId: string }>(admin, "token.create", {
    sceneId,
    name: "Goblin",
    pos: { x: hero.pos.x + 10, y: hero.pos.y + 2 },
    disposition: "hostile",
    stats: { hp: 7, hpMax: 7, ac: 15 },
  });
  const { tokenId: ogre } = await req<{ tokenId: string }>(admin, "token.create", {
    sceneId,
    name: "Fire-scarred Ogre",
    pos: { x: hero.pos.x + 16, y: hero.pos.y - 6 },
    size: "large",
    disposition: "hostile",
    stats: { hp: 59, hpMax: 59, ac: 11, resist: ["fire"] },
  });
  for (const p of [admin, dave])
    await camera(p, {
      pitchDeg: 58,
      distance: phone ? 66 : 34,
      target: [hero.pos.x + 8, hero.pos.y - 1],
      ms: 0,
    });
  await admin.waitForTimeout(400);

  // ── Damage: typed parts, the preview, what follows (the goblin to 0) ──
  await step("01-damage-dialog", admin, async () => {
    await radial(admin, goblin, "HP", "Damage…");
    const d = admin.getByTestId("hp-dialog");
    await d.getByLabel("Amount 1").fill("6");
    await d.getByLabel("Type 1").selectOption("slashing");
    await d.getByRole("button", { name: "Another type" }).click();
    await d.getByLabel("Amount 2").fill("4");
    await d.getByLabel("Type 2").selectOption("fire");
    await expect(d.getByTestId("hp-preview-hp")).toContainText("7 → 0");
    await d.getByTestId("hp-follows").getByRole("radio", { name: "Unconscious" }).click();
  });
  await admin
    .getByRole("dialog")
    .getByRole("button", { name: "Apply damage" })
    .click()
    .catch(() => {});
  // The numbers float for a moment: taken as soon as they show (mid-rise), no settling.
  await step(
    "02-floating-numbers",
    dave,
    () =>
      expect
        .poll(
          () =>
            dave.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>('[data-testid="hp-number"]')].some(
                (e) => Number(e.style.opacity) > 0.9,
              ),
            ),
          { intervals: [30], timeout: 5000 },
        )
        .toBe(true),
    false,
  );
  await step("03-ogre-resisted-preview", admin, async () => {
    await admin.waitForTimeout(600);
    await radial(admin, ogre, "HP", "Damage…");
    const d = admin.getByTestId("hp-dialog");
    await d.getByLabel("Amount 1").fill("12");
    await d.getByLabel("Type 1").selectOption("slashing");
    await d.getByRole("button", { name: "Another type" }).click();
    await d.getByLabel("Amount 2").fill("9");
    await d.getByLabel("Type 2").selectOption("fire");
    await d.getByText("Half (a successful save)").click();
    await expect(d.getByTestId("hp-preview-row")).toContainText("resisted");
  });
  await closeDialogs(admin);

  // ── Conditions ──
  await step("04-condition-picker", admin, async () => {
    await radial(admin, hero.id, "Conditions");
    const pk = admin.getByTestId("status-picker");
    await pk.getByRole("button", { name: "Poisoned", exact: true }).click();
    await pk.getByRole("button", { name: "Blessed", exact: true }).click();
    await expect(pk.getByRole("button", { name: "Blessed", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await pk.getByRole("button", { name: "Frightened", exact: true }).focus();
  });
  await step("05-custom-marker", admin, async () => {
    const pk = admin.getByTestId("status-picker");
    await pk.getByText("A custom marker…").click();
    await pk.getByPlaceholder("Hexed").fill("Hexed");
    await pk.getByRole("radio", { name: "Orchid" }).click();
    await pk.getByRole("radio", { name: "Frightened", exact: true }).click();
    await pk.getByRole("button", { name: "Add the marker" }).click();
    await expect(pk.getByRole("button", { name: "Hexed" })).toBeVisible();
    await pk.getByText("A custom marker…").scrollIntoViewIfNeeded();
  });
  await closeDialogs(admin);
  await req(admin, "status.change", { tokenId: hero.id, exhaustion: 2 });
  await step("06-token-states", admin, async () => {
    await expect.poll(async () => (await tokenOf(admin, goblin)) !== null).toBe(true);
    await admin.waitForTimeout(700);
  });
  // Hover cards are for a pointer (not on touch: HoverCard.tsx).
  if (!phone)
    await step(
      "07-hover-card",
      admin,
      async () => {
        const t = (await tokenOf(admin, hero.id)) as { pos: { x: number; y: number } };
        const s = await hook<{ sx: number; sy: number }>(admin, "project", t.pos.x, t.pos.y, 0.15);
        await admin.bringToFront();
        await admin.mouse.move(s.sx, s.sy);
        await expect(admin.getByTestId("hover-card")).toBeVisible();
        await expect
          .poll(() => admin.getByTestId("hover-card").evaluate((e) => getComputedStyle(e).opacity))
          .toBe("1");
      },
      // Taken with the pointer still on the token.
      false,
    );

  // ── The DM's decisions: a player's damage to check ──
  await step("08-dm-prompt-player-damage", admin, async () => {
    await radial(dave, ogre, "HP", "Damage…");
    await dave.getByTestId("hp-dialog").getByLabel("Amount 1").fill("8");
    await dave.getByRole("dialog").getByRole("button", { name: "Send to the DM" }).click();
    await expect(admin.getByTestId("dm-prompt")).toContainText("Dave's damage to Fire-scarred Ogre");
    await expect(admin.getByTestId("dm-prompt").getByTestId("hp-preview-hp")).toContainText("→");
  });
  await admin
    .getByTestId("dm-prompt")
    .getByRole("button", { name: "Apply" })
    .click()
    .catch(() => {});

  // ── A player's cards ──
  await step("09-roll-hint-card", dave, async () => {
    await req(admin, "request.create", { targets: [hero.id], type: "check", skill: "perception" });
    await expect(dave.getByTestId("roll-hint")).toContainText("Poisoned");
  });
  await dave
    .getByTestId("request-card")
    .getByRole("button", { name: "Roll", exact: true })
    .click()
    .catch(() => {});
  await step("10-concentration-card", dave, async () => {
    await req(admin, "status.change", { tokenId: hero.id, concentration: "Bless", remove: ["poisoned"] });
    await req(admin, "hp.apply", { targets: [hero.id], kind: "damage", amount: 14 });
    await expect(dave.getByTestId("request-group").filter({ hasText: "Concentration" })).toBeVisible();
  });
  const conc = dave.getByTestId("request-group").filter({ hasText: "Concentration" });
  await conc
    .getByRole("button", { name: "Enter physical roll" })
    .click()
    .catch(() => {});
  await conc
    .getByLabel("Your total")
    .fill("6")
    .catch(() => {});
  await conc
    .getByRole("button", { name: "Send" })
    .click()
    .catch(() => {});
  await step("11-dm-prompt-concentration", admin, async () => {
    await expect(admin.getByTestId("dm-prompt")).toContainText("Concentration ends");
  });
  await admin
    .getByTestId("dm-prompt")
    .getByRole("button", { name: "Apply" })
    .click()
    .catch(() => {});
  await step("12-death-save-card", dave, async () => {
    await req(admin, "hp.apply", {
      targets: [mage2.id],
      kind: "damage",
      amount: 30,
      decide: { [mage2.id]: { keep: ["down"] } },
    });
    await req(admin, "death.request", { targets: [mage2.id] });
    await expect(dave.getByTestId("death-save-pips")).toBeVisible();
  });
  await step("13-down-on-the-board", admin, async () => {
    await closeDock(admin);
    await admin.waitForTimeout(900);
  });

  // ── The DM panel, rests, temp HP ──
  await step("14-dm-health", admin, async () => {
    const panel = await openDock(admin, "DM panel");
    await panel.getByRole("tab", { name: "Health" }).click();
    await expect(panel.getByTestId("dm-health")).toBeVisible();
  });
  await step("15-long-rest-preview", admin, async () => {
    await admin.getByTestId("dm-health").getByRole("button", { name: "Long rest…" }).click();
    await expect(admin.getByTestId("rest-dialog")).toBeVisible();
    await admin
      .getByTestId("rest-dialog")
      .locator(`[data-actor="${thorin}"]`)
      .getByRole("checkbox", { name: /Uses back/ })
      .uncheck();
  });
  await closeDialogs(admin);
  await step("16-hit-die-card", dave, async () => {
    await req(admin, "rest.apply", { kind: "short", actors: { [thorin]: ["hitDiceCards", "features"] } });
    // A phone shows one card at a time: paged to the new one. A narrower screen, two, then "Show n more".
    await dave.waitForTimeout(500);
    const hitDie = dave.getByTestId("request-group").filter({ hasText: "Spend a Hit Die" });
    const next = dave.getByRole("button", { name: "Next card" });
    for (let i = 0; i < 4 && !(await hitDie.isVisible()) && (await next.isEnabled().catch(() => false)); i++)
      await next.click();
    const more = dave.getByRole("button", { name: /^Show \d+ more/ });
    if (!(await hitDie.isVisible()) && (await more.isVisible())) await more.click();
    await expect(hitDie).toBeVisible();
  });
  await step("17-temp-hp-choice", admin, async () => {
    await closeDock(admin);
    await req(admin, "hp.apply", { targets: [hero.id], kind: "temp", amount: 5 });
    await radial(admin, hero.id, "HP", "Temporary HP…");
    await admin.getByTestId("hp-dialog").getByLabel("Temporary HP").fill("8");
    await expect(admin.getByTestId("hp-dialog").getByRole("radio", { name: "Take 8" })).toBeVisible();
  });
  await closeDialogs(admin);
  await step("18-sheet-conditions", dave, async () => {
    const sheet = await openDock(dave, "Sheet");
    await sheet
      .getByRole("combobox", { name: "Character", exact: true })
      .selectOption({ label: "Thorin Emberhand" });
    const conditions = sheet.getByTestId("sheet-conditions");
    await expect(conditions).toContainText("Exhaustion 2");
    await expect(conditions).toContainText("Blessed");
    await expect(conditions).toContainText("Hexed");
  });
  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
