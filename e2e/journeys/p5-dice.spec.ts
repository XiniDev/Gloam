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
const SHOTS = "artifacts/screens/p5";

interface Skin {
  body: string;
  number: string;
  material: string;
}
interface Throw {
  id: string;
  masked: boolean;
  dice: { kind: string; percentile?: string; shown: number | null }[];
  settled: boolean;
  skin: Skin;
  clacks: { step: number; die: number; other: "tray" | "die"; gain: number }[];
}
interface Roll {
  id: string;
  userId: string;
  total?: number;
  masked?: true;
  text?: string;
  manual: boolean;
  tumble: { kind: string; face?: number; percentile?: string }[];
}
const throwOf = async (p: Page, id: string) =>
  (await hook<Throw[]>(p, "diceThrows")).find((t) => t.id === id);
const feed = (p: Page) => hook<Roll[]>(p, "rollFeed");
const card = (p: Page, id: string) => p.locator(`[data-testid="roll-card"][data-roll="${id}"]`);

async function openTray(p: Page) {
  if (!(await p.getByTestId("dice-tray").isVisible())) await p.getByTestId("dice-button").click();
  const tray = p.getByTestId("dice-tray");
  await expect(tray).toBeVisible();
  return tray;
}

test.describe("P5 — dice (DICE)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-DICE-01 / AC-DICE-03 / AC-DICE-08: the tray checks a formula as it's typed; every die from d4 to d100 lands on the server's number, alike for everyone; each clack is a simulated contact, as loud as its hit", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Dice hall",
      mapKind: "procedural",
      floorStyle: "wood",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    await boardSettled(dave, sceneId);

    // AC-DICE-01: an invalid formula shows its error where it is, and nothing is sent.
    await dave.keyboard.press("d");
    const tray = await openTray(dave);
    const formula = dave.getByTestId("dice-formula");
    const roll = tray.getByRole("button", { name: "Roll", exact: true });
    await formula.fill("2d20 ++ 3");
    await expect(dave.getByTestId("dice-formula-error")).toContainText(/Unexpected/);
    await expect(roll).toBeDisabled();
    await formula.press("Enter");
    await formula.fill("1d1001");
    await expect(dave.getByTestId("dice-formula-error")).toContainText(/1 to 1000 sides/);
    await dave.waitForTimeout(300);
    expect(await feed(dave)).toEqual([]);

    // AC-DICE-03: every kind of die at once, a d100 as its two d10s.
    await formula.fill("1d4 + 1d6 + 1d8 + 1d10 + 1d12 + 1d20 + 1d100");
    await expect(dave.getByTestId("dice-formula-error")).toHaveCount(0);
    // Enter rolls and puts the tray away (the dice get the board); the card waits for the dice — its chips empty
    // until they settle, so they never tell the result first.
    await formula.press("Enter");
    await expect.poll(async () => (await feed(dave)).length, { intervals: [50] }).toBe(1);
    const r = (await feed(dave))[0] as Roll;
    await expect(card(dave, r.id)).toHaveAttribute("data-settled", "0");
    await expect(card(dave, r.id).getByTestId("roll-pending")).toBeVisible();
    await expect(card(dave, r.id).locator('[data-testid="die-chip"]:not([data-empty])')).toHaveCount(0);
    await expect(dave.getByTestId("dice-tray")).toHaveCount(0);
    await dave.screenshot({ path: `${SHOTS}/dice-tumbling.png` });
    expect(r.tumble.map((d) => d.kind)).toEqual(["d4", "d6", "d8", "d10", "d12", "d20", "d10", "d10"]);
    for (const [p, name] of [
      [dave, "dice-settled"],
      [admin, "dice-settled-dm"],
    ] as const) {
      await expect
        .poll(async () => (await throwOf(p, r.id))?.settled, { timeout: 20_000, intervals: [100] })
        .toBe(true);
      // (At rest for 2.5 s before they fade.)
      await p.screenshot({ path: `${SHOTS}/${name}.png` });
    }
    // Resting on exactly the server's faces — for the roller (thrown from the bottom) and the DM (from the top).
    for (const p of [dave, admin])
      expect(((await throwOf(p, r.id)) as Throw).dice.map((d) => d.shown)).toEqual(
        r.tumble.map((d) => d.face),
      );
    await expect(card(dave, r.id)).toHaveAttribute("data-settled", "1");
    await expect(card(dave, r.id).getByTestId("roll-total")).toHaveText(String(r.total));

    // AC-DICE-08: the clacks are the simulation's contacts — tray or another die — each as loud as its impulse.
    const t = (await throwOf(dave, r.id)) as Throw;
    expect(t.clacks.length).toBeGreaterThan(4);
    const heard = (await dave.evaluate(() =>
      (window.__gloam?.sounds ?? []).filter((s) => /^dice(Tray|Die)/.test(s.name)),
    )) as { name: string; gain?: number }[];
    expect(heard.map((s) => s.name)).toEqual(
      t.clacks.map((c) => (c.other === "die" ? "diceDieResin" : "diceTrayResin")),
    );
    expect(heard.map((s) => s.gain)).toEqual(t.clacks.map((c) => c.gain));
    const gains = t.clacks.map((c) => c.gain);
    expect(Math.max(...gains)).toBeLessThanOrEqual(1);
    expect(Math.min(...gains)).toBeGreaterThan(0);
    expect(new Set(gains.map((g) => g.toFixed(3))).size).toBeGreaterThan(3);
    // A settle tick per die.
    const ticks = await dave.evaluate(
      () => (window.__gloam?.sounds ?? []).filter((s) => s.name === "diceSettle").length,
    );
    expect(ticks).toBe(r.tumble.length);
  });

  test("AC-DICE-04 / AC-DICE-05 / AC-DICE-07: public rolls reach everyone within 300 ms; private, self and the DM's own rolls show as §18.3 says; a physical roll carries a hand for everyone; a player's dice look the same to everyone", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Dice hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const erin = await admitPlayer(admin, browser, gloam, guardLog, code, "Erin", { viewport: VIEWPORT });
    for (const p of [dave, erin]) await boardSettled(p, sceneId);
    const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;

    // AC-DICE-07: Dave picks his dice in Settings; everyone sees his next roll in them.
    await dave.getByRole("button", { name: "Settings" }).click();
    const picker = dave.getByTestId("dice-skin");
    await picker.getByRole("radio", { name: "Oxblood" }).click();
    await picker.getByRole("radio", { name: "Metal" }).click();
    await picker.getByRole("radio", { name: "Gold" }).click();
    await dave.screenshot({ path: `${SHOTS}/dice-skin-settings.png` });
    await dave.keyboard.press("Escape");
    const skin = { body: "#6E1E24", number: "#E6C98B", material: "metal" };
    await expect
      .poll(async () =>
        JSON.parse(
          ((await hook<{ userId: string; diceSkin: string }[]>(erin, "presenceList")) ?? []).find(
            (p) => p.userId === daveId,
          )?.diceSkin ?? "{}",
        ),
      )
      .toEqual(skin);
    const { id: pub } = await req<{ id: string }>(dave, "dice.roll", { formula: "3d6" });
    for (const p of [admin, erin, dave])
      await expect.poll(async () => (await throwOf(p, pub))?.skin, { timeout: 20_000 }).toEqual(skin);
    await erin.screenshot({ path: `${SHOTS}/dice-skin-seen-by-erin.png` });
    // AC-DICE-04 (public): at everyone's within 300 ms of the server's decision.
    for (const p of [admin, erin]) {
      const a = (await hook<{ id: string; lagMs: number }[]>(p, "rollArrivals")).find((x) => x.id === pub);
      expect(a?.lagMs, "public roll arrival").toBeLessThan(300);
    }

    // Private to DM, from the tray: Dave and the DM see it; Erin a card saying so, with "?" dice.
    let tray = await openTray(dave);
    await tray.getByRole("radio", { name: "Private to DM" }).click();
    // Blind isn't the tray's to choose (it comes with the DM's roll requests).
    await expect(tray.getByRole("radio", { name: /Blind/ })).toHaveCount(0);
    await dave.getByTestId("dice-formula").fill("1d20+4");
    await tray.getByRole("button", { name: "Roll", exact: true }).click();
    await expect.poll(async () => (await feed(erin)).length).toBe(2);
    const priv = (await feed(erin))[0] as Roll;
    expect(priv).toMatchObject({ masked: true, text: "Dave rolled privately" });
    expect(priv).not.toHaveProperty("total");
    await expect(card(erin, priv.id)).toContainText("Dave rolled privately");
    for (const p of [admin, dave])
      await expect.poll(async () => (await feed(p)).find((x) => x.id === priv.id)?.total).toBeGreaterThan(4);
    // Masked dice still tumble — with "?" faces.
    await expect.poll(async () => (await throwOf(erin, priv.id))?.masked, { timeout: 20_000 }).toBe(true);

    // Self: Dave alone; the DM is told; Erin gets nothing. (The tray closed on rolling and opens as it was left.)
    tray = await openTray(dave);
    await expect(dave.getByTestId("dice-formula")).toHaveValue("1d20+4");
    await expect(tray.getByRole("radio", { name: "Private to DM" })).toHaveAttribute("aria-checked", "true");
    await tray.getByRole("radio", { name: "Self" }).click();
    await dave.getByTestId("dice-formula").fill("1d8");
    await dave.waitForTimeout(250);
    await tray.getByRole("button", { name: "Roll", exact: true }).click();
    await expect.poll(async () => (await feed(dave)).length).toBe(3);
    const self = (await feed(dave))[0] as Roll;
    await expect
      .poll(async () => (await feed(admin)).find((x) => x.id === self.id))
      .toMatchObject({ masked: true, text: "Dave rolled for themselves" });
    await erin.waitForTimeout(500);
    expect((await feed(erin)).some((x) => x.id === self.id)).toBe(false);
    await dave.keyboard.press("Escape");

    // The DM's private roll: players see "The DM rolls…" under the seal — not the DM's label, which is information
    // too (§18.3 "no values"). The DM's own card says it was private.
    tray = await openTray(admin);
    await tray.getByRole("radio", { name: "Private" }).click();
    await admin.getByTestId("dice-formula").fill("1d20");
    await tray.getByLabel("Label").fill("Ambush");
    await tray.getByRole("button", { name: "Roll", exact: true }).click();
    await expect.poll(async () => (await feed(admin)).length).toBe(4);
    const dmRoll = (await feed(admin))[0] as Roll;
    for (const p of [dave, erin]) {
      await expect
        .poll(async () => (await feed(p)).find((x) => x.id === dmRoll.id))
        .toMatchObject({ masked: true, text: "The DM rolls…" });
      expect(JSON.stringify((await feed(p)).find((x) => x.id === dmRoll.id))).not.toContain("Ambush");
      await expect(card(p, dmRoll.id)).toContainText("The DM");
      await expect(card(p, dmRoll.id)).not.toContainText("Ambush");
      await expect(card(p, dmRoll.id).getByRole("img", { name: "DM" })).toBeVisible();
    }
    await expect(card(admin, dmRoll.id)).toContainText("Ambush");
    await expect(card(admin, dmRoll.id).getByTestId("roll-private")).toHaveText("Private");
    await admin.keyboard.press("Escape");

    // AC-DICE-05: Erin rolled real dice: entered by hand, recorded with a hand, seen by everyone like any roll.
    tray = await openTray(erin);
    await erin.getByTestId("dice-formula").fill("2d6+1");
    await tray.getByRole("button", { name: "I rolled physically…" }).click();
    await erin.getByLabel("Die 1 (d6)").fill("4");
    await erin.getByLabel("Die 2 (d6)").fill("6");
    await erin.getByRole("button", { name: "Record roll" }).click();
    await expect.poll(async () => (await feed(erin))[0]?.manual).toBe(true);
    const man = (await feed(erin))[0] as Roll;
    expect(man.total).toBe(11);
    for (const p of [admin, dave, erin]) {
      await expect(card(p, man.id).getByLabel("Rolled by hand")).toBeVisible();
      await expect(card(p, man.id).getByTestId("roll-total")).toHaveText("11");
    }
    await dave.screenshot({ path: `${SHOTS}/dice-feed-player.png` });
    await admin.screenshot({ path: `${SHOTS}/dice-feed-dm.png` });
  });

  test("dice come to rest where they're seen — clear of the feed, the action bar and a tray kept open, one throw at a time — and read large on a phone, whose dice button the feed never covers", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    interface Stage {
      easing: boolean;
      throws: {
        id: string;
        done: boolean;
        dice: { visible: boolean; screen: [number, number]; sizePx: number }[];
      }[];
    }
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 30,
    });
    await boardSettled(admin, sceneId);
    const rested = (p: Page, id: string) =>
      expect
        .poll(async () => (await throwOf(p, id))?.settled, { timeout: 20_000, intervals: [100] })
        .toBe(true);
    /** Every die of a throw on screen and clear of the named HUD pieces (each die as the square round it). */
    const clearOf = async (p: Page, id: string, pieces: string[]) => {
      // Where they finally show: the dice camera done easing in on them.
      await expect
        .poll(async () => (await hook<Stage>(p, "diceStage")).easing, { timeout: 5_000 })
        .toBe(false);
      const t = (await hook<Stage>(p, "diceStage")).throws.find((x) => x.id === id);
      expect(t, "the throw is on the stage").toBeTruthy();
      const vp = p.viewportSize() as { width: number; height: number };
      const boxes: { name: string; x: number; y: number; width: number; height: number }[] = [];
      for (const name of pieces) {
        const b = await p.getByTestId(name).first().boundingBox();
        if (b) boxes.push({ name, ...b });
      }
      for (const d of t?.dice ?? []) {
        const [x, y] = d.screen;
        const r = d.sizePx / 2;
        expect(x - r, "on screen").toBeGreaterThanOrEqual(0);
        expect(y - r, "on screen").toBeGreaterThanOrEqual(0);
        expect(x + r, "on screen").toBeLessThanOrEqual(vp.width);
        expect(y + r, "on screen").toBeLessThanOrEqual(vp.height);
        for (const b of boxes)
          expect(
            x + r > b.x && x - r < b.x + b.width && y + r > b.y && y - r < b.y + b.height,
            `a die at ${Math.round(x)},${Math.round(y)} under the ${b.name}`,
          ).toBe(false);
      }
      return t?.dice ?? [];
    };

    // The DM's feed fills (three cards along the bottom-left); the dice stay at rest while they're checked.
    await hook(admin, "diceHold", 60_000);
    for (const formula of ["1d20", "2d6", "1d8"]) {
      const { id } = await req<{ id: string }>(admin, "dice.roll", { formula });
      await rested(admin, id);
    }
    // Seven dice from the tray: it closes as they're thrown; they land clear of the feed and the action bar.
    let tray = await openTray(admin);
    await admin.getByTestId("dice-formula").fill("1d20 + 1d12 + 1d10 + 1d8 + 2d6 + 1d4");
    await admin.getByTestId("dice-formula").press("Enter");
    await expect(admin.getByTestId("dice-tray")).toHaveCount(0);
    await expect.poll(async () => (await feed(admin)).length).toBe(4);
    const seven = ((await feed(admin))[0] as Roll).id;
    await rested(admin, seven);
    await clearOf(admin, seven, ["roll-feed", "action-bar"]);

    // Kept open for a run of rolls: the dice come to rest clear of the tray too — and the last throw's dice made way.
    tray = await openTray(admin);
    await tray.getByRole("button", { name: "Keep the tray open after rolling" }).click();
    await admin.getByTestId("dice-formula").fill("1d20 + 1d12 + 1d10 + 2d6");
    await admin.getByTestId("dice-formula").press("Enter");
    await expect.poll(async () => (await feed(admin)).length).toBe(5);
    await expect(tray).toBeVisible();
    const kept = ((await feed(admin))[0] as Roll).id;
    await rested(admin, kept);
    await clearOf(admin, kept, ["roll-feed", "action-bar", "dice-tray"]);
    await expect
      .poll(
        async () => (await hook<Stage>(admin, "diceStage")).throws.find((x) => x.id === seven)?.done ?? true,
      )
      .toBe(true);
    await admin.screenshot({ path: `${SHOTS}/dice-beside-tray.png` });
    await tray.getByRole("button", { name: "Close the tray after rolling" }).click();
    await admin.keyboard.press("Escape");

    // A phone: the tray is a bottom sheet at 60 %; rolling closes it; a pair of dice lands large (≥ 48 px) and in
    // view, clear of the feed — which sits above the action bar, the dice button uncovered.
    const pia = await admitPlayer(admin, browser, gloam, guardLog, code, "Pia", {
      viewport: { width: 390, height: 844 },
    });
    await boardSettled(pia, sceneId);
    await hook(pia, "diceHold", 60_000);
    await pia.getByTestId("dice-button").click();
    await expect(pia.getByTestId("dice-tray")).toHaveAttribute("data-snap", "0.6");
    await pia.getByTestId("dice-formula").fill("2d20");
    await pia.getByTestId("dice-formula").press("Enter");
    await expect(pia.getByTestId("dice-tray")).toHaveCount(0);
    await expect.poll(async () => (await feed(pia)).length).toBeGreaterThan(0);
    const pair = ((await feed(pia))[0] as Roll).id;
    await rested(pia, pair);
    const dice = await clearOf(pia, pair, ["roll-feed", "action-bar"]);
    expect(dice.length).toBe(2);
    for (const d of dice) expect(d.sizePx, "a phone die's size (px)").toBeGreaterThanOrEqual(48);
    const button = (await pia.getByTestId("dice-button").boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const onTop = await pia.evaluate(
      ([x, y]) =>
        document
          .elementFromPoint(x as number, y as number)
          ?.closest("[data-testid]")
          ?.getAttribute("data-testid"),
      [button.x + button.width / 2, button.y + button.height / 2],
    );
    expect(onTop, "what's on top of the dice button").toBe("dice-button");
    await pia.screenshot({ path: `${SHOTS}/dice-phone-pair.png` });
  });
});
