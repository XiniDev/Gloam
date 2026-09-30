import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  createScene,
  dmSection,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { freshShotsDir } from "../fixtures/shotsDir.ts";
import { expect, test } from "../fixtures/test.ts";

/** A mono 16-bit WAV: a soft 440 Hz tone (an uploaded track). */
function toneWav(sec: number, rate = 22050): Buffer {
  const n = Math.floor(sec * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return b;
}

/**
 * The key screens of phases 10 and 11 (SPEC §4 Screenshots): the History panel and the Admin's Saves page; the sound
 * board; the DM's Sound panel (now playing, presets, tracks, playlists, ambience); the emote wheel, an emote over a
 * token and a phrase under a portrait; the raised hand in the top bar and the tracker; the DM's Handouts & Notes; a
 * handout unfurling and a secret note; the Journal's log and handouts.
 */
test("P10–P11 key screens", async ({ admin, browser, gloam, guardLog }, info) => {
  test.setTimeout(1_200_000);
  const dir = join("artifacts", "screens", "p11", info.project.name);
  freshShotsDir(dir);
  const notes: string[] = [];
  const viewport = info.project.use.viewport as { width: number; height: number };
  const phone = viewport.width < 640;
  const shot = async (page: Page, name: string) => {
    await page.bringToFront();
    // The pointer off anything it could be hovering (a Revert button stayed lit — critic P11 r2 N26).
    await page.mouse.move(Math.round(viewport.width / 2), 1);
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
  const step = async (name: string, page: Page, fn: () => Promise<unknown>, capture = true) => {
    try {
      await fn();
      if (capture) await shot(page, name);
    } catch (e) {
      const lines = (e as Error).message.split("\n");
      notes.push(
        `${name}: ${lines.slice(0, 3).join(" | ")} ${lines.filter((l) => l.includes("Received")).join(" ")}`,
      );
      await page.screenshot({ path: join(dir, `_failed-${name}.png`) }).catch(() => {});
    }
  };
  // A pop at rest: fully opaque and unscaled for a moment (toBeVisible passes at opacity 0, mid-bounce; critic P11 r1 I1).
  const popSettled = async (pop: Locator) =>
    expect
      .poll(
        () =>
          pop.evaluate((el) => {
            const inner = el.firstElementChild as HTMLElement | null;
            if (!inner) return "no inner";
            const cs = getComputedStyle(inner);
            const m = new DOMMatrix(cs.transform === "none" ? undefined : cs.transform);
            const still = Math.abs(m.a - 1) < 0.01 && Math.abs(m.d - 1) < 0.01 && Math.abs(m.f) < 0.5;
            return Number(cs.opacity) > 0.99 && still ? "at rest" : `opacity ${cs.opacity}, ${cs.transform}`;
          }),
        { timeout: 3000, intervals: [50] },
      )
      .toBe("at rest");
  // No dice on the board (they're not what these shots are about).
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
  const closeDock = async (p: Page) => {
    const close = p.getByRole("button", { name: "Close panel" });
    if (await close.isVisible().catch(() => false)) await close.click();
    else {
      for (const r of ["DM panel", "Journal", "Character sheet", "Party"])
        if (
          await p
            .getByRole("region", { name: r, exact: true })
            .isVisible()
            .catch(() => false)
        )
          await p
            .getByRole("button", { name: new RegExp(`^${r === "Character sheet" ? "Sheet" : r}`) })
            .first()
            .click();
    }
  };

  const code = await adminAtTable(admin);
  await introDone(admin);
  const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport });
  const erin = await admitPlayer(admin, browser, gloam, guardLog, code, "Erin", { viewport });
  const idOf = async (p: Page) => (await hook<{ userId: string }>(p, "me")).userId;
  const [daveId, erinId] = [await idOf(dave), await idOf(erin)];
  const sceneId = await createScene(admin, {
    name: "Dark hall",
    mapKind: "procedural",
    floorStyle: "stone",
    widthFt: 60,
    heightFt: 40,
    fogMode: "dynamic",
    ambient: "dim",
  });
  await req(admin, "wall.create", { sceneId, walls: [{ a: { x: 30, y: 0 }, b: { x: 30, y: 40 } }] });
  const { tokenId: fighter } = await req<{ tokenId: string }>(admin, "token.create", {
    sceneId,
    name: "Dave's Fighter",
    pos: { x: 15, y: 20 },
    disposition: "party",
    ownerIds: [daveId],
    stats: { hp: 20, hpMax: 20, ac: 16, senses: { darkvision: 60 } },
  });
  await req(admin, "token.create", {
    sceneId,
    name: "Erin's Rogue",
    pos: { x: 45, y: 20 },
    disposition: "party",
    ownerIds: [erinId],
    stats: { hp: 14, hpMax: 14, ac: 14, senses: { darkvision: 60 } },
  });
  for (const p of [admin, dave, erin]) await boardSettled(p, sceneId);
  // A few changes for the History panel.
  await req(admin, "hp.apply", { targets: [fighter], kind: "damage", amount: 6 });
  await admin.waitForTimeout(250);
  await req(admin, "token.create", {
    sceneId,
    name: "Goblin G7",
    pos: { x: 22, y: 12 },
    stats: { hp: 7, hpMax: 7, ac: 12 },
  });

  // ── P10: the History panel, the Saves page ──
  await step("01-history", admin, async () => {
    await dmSection(admin, "History");
    await expect(admin.getByTestId("history-panel").getByTestId("history-row").first()).toBeVisible();
  });

  // ── P11: the Sound panel ──
  await hook(admin, "upload", toneWav(20).toString("base64"), "Lantern waltz.wav", "audio");
  await hook(admin, "upload", toneWav(12).toString("base64"), "Crypt drone.wav", "audio");
  await step("02-sound-panel", admin, async () => {
    await dmSection(admin, "Sound");
    const panel = admin.getByTestId("sound-panel");
    await panel.getByRole("button", { name: "Play Lantern waltz" }).click();
    await panel.getByLabel("New playlist's name").fill("The road north");
    await panel.getByRole("button", { name: "Make", exact: true }).click();
    await panel.getByRole("button", { name: "Add Lantern waltz to a playlist" }).click();
    await admin.getByRole("menuitem", { name: "The road north" }).click();
    await panel.getByRole("button", { name: "Tavern hearth", exact: true }).click();
    await expect(panel.getByTestId("now-playing")).toContainText("Lantern waltz");
    // (Picking the ambience scrolled the panel down: this shot is the player and its tracks.)
    await panel.getByTestId("now-playing").scrollIntoViewIfNeeded();
  });
  await step("03-sound-panel-ambience", admin, async () => {
    await admin
      .getByTestId("sound-panel")
      .getByRole("group", { name: "Ambience presets" })
      .scrollIntoViewIfNeeded();
  });
  await step("04-sound-preset", admin, async () => {
    const panel = admin.getByTestId("sound-panel");
    await panel.getByRole("button", { name: /^Wonder/ }).scrollIntoViewIfNeeded();
    await panel.getByRole("button", { name: /^Wonder/ }).click();
    await panel.getByTestId("now-playing").scrollIntoViewIfNeeded();
    await expect(panel.getByTestId("now-playing")).toContainText("Wonder");
  });
  await closeDock(admin);

  // ── Emotes ──
  await step("05-emote-wheel", dave, async () => {
    if (phone)
      await dave.locator(`[data-presence="${daveId}"]`).getByRole("button", { name: "Emotes" }).click();
    else {
      await dave.mouse.move(viewport.width / 2, viewport.height / 2);
      await dave.keyboard.press("e");
    }
    await expect(dave.getByTestId("emote-wheel")).toBeVisible();
  });
  // The pops as they rest: under software GL a big page draws a few frames a second and Motion advances at most 40 ms
  // a frame, so a 2.5-s pop never finishes its bounce — the watching pages take reduced motion (a quick fade in) here.
  for (const p of [admin, erin]) {
    await p.emulateMedia({ reducedMotion: "reduce" });
    await hook(p, "emoteHold", 20_000);
  }
  await step(
    "06-emote-over-token",
    admin,
    async () => {
      await dave.getByTestId("emote-wheel").getByRole("button", { name: "Party" }).click();
      const onAdmin = admin.locator(`[data-testid="emote-pop"][data-user="${daveId}"]`);
      const onErin = erin.locator(`[data-testid="emote-pop"][data-user="${daveId}"]`);
      await expect(onAdmin).toBeVisible();
      await expect(onErin).toBeVisible();
      // (A page behind gets no animation frames: each comes to the front to be watched.)
      await admin.bringToFront();
      await popSettled(onAdmin);
      await admin.screenshot({ path: join(dir, "06-emote-over-token.png") });
      await erin.bringToFront();
      await popSettled(onErin);
      await erin.screenshot({ path: join(dir, "07-emote-under-portrait.png") });
    },
    false,
  );
  await dave.waitForTimeout(1600);
  await step(
    "08-phrase",
    erin,
    async () => {
      await req(dave, "emote.send", { phrase: "I have a plan…" });
      await erin.bringToFront();
      const pop = erin.locator('[data-testid="emote-pop"]', { hasText: "I have a plan" });
      await expect(pop).toBeVisible();
      await popSettled(pop);
      await erin.screenshot({ path: join(dir, "08-phrase.png") });
    },
    false,
  );

  for (const p of [admin, erin]) {
    await p.emulateMedia({ reducedMotion: "no-preference" });
    await hook(p, "emoteHold", null);
  }

  // ── The raised hand ──
  await req(dave, "hand.toggle", { raised: true });
  await req(admin, "combat.quickStart", {});
  await step("09-hand-raised", admin, async () => {
    await expect(
      admin.locator(`[data-testid="tracker-entry"][data-token="${fighter}"]`).getByTestId("hand-badge"),
    ).toBeVisible({
      timeout: 20_000,
    });
    // The NPCs' initiative dice have faded.
    await diceClear(admin, "09-hand-raised");
  });
  await req(admin, "combat.stop", {}).catch(() => {});
  await req(dave, "hand.toggle", { raised: false });

  // ── Handouts and notes ──
  await step("10-dm-handouts", admin, async () => {
    await dmSection(admin, "Handouts");
    const panel = admin.getByTestId("handouts-panel");
    await panel.getByRole("button", { name: "New handout" }).click();
    await panel.getByLabel("Title").fill("A torn map");
    await panel
      .getByLabel("Text")
      .fill(
        "**North** of the crypt, a second stair — *under the well*.\n\n- the well\n- the gate\n- the drowned door",
      );
    await panel.getByRole("button", { name: "Save the handout" }).click();
    await expect(panel.getByTestId("dm-handout")).toHaveCount(1);
  });
  await step("11-handout-reveal", dave, async () => {
    const panel = admin.getByTestId("handouts-panel");
    await panel.getByRole("button", { name: "Show A torn map" }).click();
    await admin.getByRole("menuitem", { name: "To everyone" }).click();
    await expect(dave.getByTestId("handout-reveal")).toBeVisible();
    await dave.waitForTimeout(800);
  });
  for (const p of [dave, erin]) {
    const r = p.getByTestId("handout-reveal");
    await expect(r).toBeVisible();
    await r.getByRole("button", { name: "Keep it" }).click();
    await expect(r).toBeHidden();
  }
  await step("12-secret-note", erin, async () => {
    const panel = admin.getByTestId("handouts-panel");
    await panel.getByLabel("For").selectOption({ label: "Erin" });
    await panel.getByLabel("The note").fill("Only you notice the glyph glowing on the gate.");
    await panel.getByRole("button", { name: "Send the note" }).click();
    await expect(erin.getByTestId("handout-reveal")).toContainText("glyph");
    await erin.waitForTimeout(800);
  });
  await erin
    .getByTestId("handout-reveal")
    .getByRole("button", { name: "Keep it" })
    .click()
    .catch(() => {});
  await step("13-dm-handouts-shown", admin, async () => {
    await expect(admin.getByTestId("handouts-panel").getByTestId("dm-handout")).toHaveCount(2);
  });
  await closeDock(admin);

  // ── The Journal ──
  await req(dave, "log.add", { text: "We found the second stair.\nDave kept the key." });
  await step("14-journal-log", dave, async () => {
    await dave.getByRole("button", { name: /^Journal/ }).click();
    await dave.getByRole("tab", { name: "Log" }).click();
    await expect(dave.getByTestId("campaign-log")).toContainText("We found the second stair.");
  });
  await step("15-journal-handouts", erin, async () => {
    await erin.getByRole("button", { name: /^Journal/ }).click();
    await erin.getByRole("tab", { name: /^Handouts/ }).click();
    await expect(erin.getByTestId("handouts-list").getByTestId("handout-card")).toHaveCount(2);
  });

  // ── The sound board and the Admin's Saves page ──
  const board = await admin.context().newPage();
  await step("16-sound-board", board, async () => {
    await board.goto(`${gloam.url}/dev/sounds`);
    await board.getByRole("button", { name: "Measure all" }).click();
    await expect(board.getByTestId("sound-row").filter({ hasText: "Not allowed" }).first()).toBeVisible();
    // Every sound measured (the dice's tumble is continuous: never), and the button back.
    await expect
      .poll(
        async () =>
          (await board
            .locator('[data-testid="sound-row"]:not([data-measured]):not([data-sound="diceRumble"])')
            .count()) === 0 && (await board.getByRole("button", { name: "Measure all" }).isEnabled()),
        { timeout: 180_000 },
      )
      .toBe(true);
  });
  await step("17-saves", board, async () => {
    await board.goto(`${gloam.url}/admin/saves`);
    await board.getByLabel("Save now, as").fill("Before the crypt");
    await board.getByRole("button", { name: "Save now" }).click();
    await expect(board.getByText("Before the crypt").first()).toBeVisible();
  });
  await board.close();

  writeFileSync(join(dir, "_notes.txt"), notes.length ? notes.join("\n") : "all steps ran\n");
});
