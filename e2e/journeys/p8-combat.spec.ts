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
const SHOTS = "artifacts/screens/p8";

interface P {
  x: number;
  y: number;
}
interface CombatView {
  active: boolean;
  begun: boolean;
  round: number;
  activeIndex: number;
  entries: {
    tokenId: string | null;
    name: string;
    initiative?: number;
    unknown?: boolean;
    surprised?: boolean;
  }[];
}
const view = (p: Page) => hook<CombatView>(p, "combat");
const activeId = async (p: Page) => {
  const v = await view(p);
  return v.entries[v.activeIndex]?.tokenId ?? null;
};
const idOf = async (p: Page) => (await hook<{ userId: string }>(p, "me")).userId;

/** The screen point of a table point (the test hook), for the pointer. */
async function screen(p: Page, x: number, y: number, elevation = 0.15) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, elevation)) as {
    sx: number;
    sy: number;
  };
  return { x: s.sx, y: s.sy };
}

/** Clicks a token so it's selected — again if the first click went to a page just brought to the front. */
async function select(p: Page, at: P) {
  const selected = async () => (await hook<{ selection: string[] }>(p, "ui"))?.selection?.length ?? 0;
  for (let attempt = 0; attempt < 3 && (await selected()) !== 1; attempt++) {
    const s = await screen(p, at.x, at.y, 0.2);
    await p.mouse.click(s.x, s.y);
    await expect
      .poll(selected, { timeout: 2000 })
      .toBe(1)
      .catch(() => {});
  }
  expect(await selected()).toBe(1);
}

/** Presses on a token and drags it toward `to` in steps, without letting go (the preview shows meanwhile). */
async function dragHold(p: Page, from: P, to: P) {
  const a = await screen(p, from.x, from.y);
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) {
    const q = await screen(p, from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10, 0);
    await p.mouse.move(q.x, q.y);
    await p.waitForTimeout(40);
  }
}

test.describe("P8 — combat (CMB)", () => {
  test.use({ viewport: VIEWPORT });
  test.setTimeout(360_000);

  test("AC-CMB-01/02/04/05/06/08/11: the start dialog (who, how, surprise, grouping), initiative cards with their hints, the tracker (order, round, whose turn, only what a player perceives), a turn's start (bell, banner, camera), the turn controls and pips, the DM's controls and drag to reorder, Stop and Quick start", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Ambush",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 70,
      heightFt: 45,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: PLAYER });
    const pia = await admitPlayer(admin, browser, gloam, guardLog, code, "Pia", { viewport: PLAYER });
    await admin.bringToFront();
    const stats = (hp: number, dex = 0) => ({ hp, hpMax: hp, ac: 13, speeds: { walk: 30 }, dexMod: dex });
    const make = async (name: string, pos: P, extra: Record<string, unknown>) =>
      (await req<{ tokenId: string }>(admin, "token.create", { sceneId, name, pos, ...extra })).tokenId;
    const wren = await make(
      "Wren",
      { x: 15, y: 20 },
      {
        ownerIds: [await idOf(dave)],
        disposition: "party",
        stats: stats(12, 3),
      },
    );
    const kell = await make(
      "Kell",
      { x: 20, y: 26 },
      {
        ownerIds: [await idOf(pia)],
        disposition: "party",
        stats: stats(14, 1),
      },
    );
    const g1 = await make("Goblin", { x: 45, y: 20 }, { disposition: "hostile", stats: stats(7, 2) });
    const g2 = await make("Goblin", { x: 50, y: 22 }, { disposition: "hostile", stats: stats(7, 2) });
    const lurker = await make("Lurker", { x: 60, y: 35 }, { disposition: "hostile", stats: stats(9) });
    await req(admin, "token.update", { tokenId: lurker, hidden: true });
    // Wren is Invisible: its initiative comes with advantage (SRD 5.2.1).
    await req(admin, "status.change", { tokenId: wren, add: [{ id: "invisible" }] });
    for (const p of [dave, pia]) await boardSettled(p, sceneId);

    // ── The start dialog (AC-CMB-01): who fights, how initiative is found, who's surprised, identical NPCs grouped. ──
    await dmSection(admin, "Combat");
    const panel = admin.getByRole("region", { name: "DM panel", exact: true });
    await panel.getByRole("button", { name: "Start combat…" }).click();
    const dialog = admin.getByTestId("start-combat");
    await expect(dialog).toBeVisible();
    const methods = admin.getByRole("radiogroup", { name: "Initiative method" });
    for (const m of ["Players roll", "Roll for all", "Fixed", "Skip rolls"])
      await expect(methods.getByRole("radio", { name: m })).toBeVisible();
    const row = (id: string) => dialog.locator(`[data-testid="combat-participant"][data-token="${id}"]`);
    // Everyone on the scene is offered; the hidden Lurker left out.
    for (const id of [wren, kell, g1, g2]) await expect(row(id)).toBeVisible();
    const lurkerRow = row(lurker);
    if (await lurkerRow.count()) {
      const box = lurkerRow.getByRole("checkbox").first();
      if (await box.isChecked()) await box.uncheck();
    }
    await row(kell).getByRole("checkbox", { name: "Surprised" }).check();
    await methods.getByRole("radio", { name: "Players roll" }).click();
    await expect(admin.getByRole("switch", { name: /Group identical NPCs/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await admin.screenshot({ path: `${SHOTS}/start-combat.png` });
    await admin.getByRole("button", { name: "Start with 4 creatures" }).click();
    await expect.poll(async () => (await view(admin)).active).toBe(true);
    const v0 = await view(admin);
    expect(v0.entries.map((e) => e.tokenId).sort()).toEqual([wren, kell, g1, g2].sort());
    // The DM rolls the NPCs: the goblins share one roll.
    await panel.getByRole("button", { name: "Roll NPCs" }).click();
    await expect
      .poll(async () => {
        const v = await view(admin);
        const a = v.entries.find((e) => e.tokenId === g1)?.initiative;
        const b = v.entries.find((e) => e.tokenId === g2)?.initiative;
        return a !== undefined && a === b;
      })
      .toBe(true);

    // ── The players' initiative cards (AC-CMB-02): Roll / Enter / Skip, the hint from their conditions. ──
    const cardOf = (p: Page) => p.getByTestId("request-group").filter({ hasText: "Initiative" });
    await expect(cardOf(dave)).toBeVisible();
    for (const b of ["Roll", "Enter physical roll", "Skip"])
      await expect(cardOf(dave).getByRole("button", { name: b, exact: true })).toBeVisible();
    await expect(cardOf(dave).getByTestId("roll-hint")).toContainText("Advantage");
    await expect(cardOf(dave).getByTestId("roll-hint")).toContainText("Invisible");
    await expect(cardOf(pia).getByTestId("roll-hint")).toContainText("Disadvantage");
    await expect(cardOf(pia).getByTestId("roll-hint")).toContainText("Surprised");
    await dave.screenshot({ path: `${SHOTS}/initiative-card.png` });
    // Dave rolls in the app; Pia enters the roll she made at the table.
    await cardOf(dave).getByRole("button", { name: "Roll", exact: true }).click();
    await cardOf(pia).getByRole("button", { name: "Enter physical roll" }).click();
    await cardOf(pia).getByLabel("Your total").fill("4");
    await cardOf(pia).getByLabel("Your total").press("Enter");
    // All in: turns begin.
    await expect.poll(async () => (await view(admin)).begun, { timeout: 20_000 }).toBe(true);

    // ── The tracker (AC-CMB-04): in order, the round, whose turn; a player sees only what they perceive. ──
    const tracker = (p: Page) => p.getByTestId("turn-tracker");
    await expect(tracker(admin)).toBeVisible();
    await expect(tracker(admin).getByTestId("combat-round")).toHaveText("1");
    await expect(tracker(admin).getByTestId("tracker-entry")).toHaveCount(4);
    await expect(tracker(admin).locator('[data-testid="tracker-entry"][data-active="1"]')).toHaveCount(1);
    const order = (await view(admin)).entries.map((e) => e.initiative ?? -99);
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    // The DM adds the hidden Lurker: in the DM's tracker; not in the players' (they can't perceive it).
    await select(admin, { x: 60, y: 35 });
    await panel.getByRole("button", { name: "Add the selected creature" }).click();
    await expect(tracker(admin).getByTestId("tracker-entry")).toHaveCount(5);
    await expect(tracker(dave).locator(`[data-token="${lurker}"]`)).toHaveCount(0);
    await expect(tracker(dave).getByText("Lurker")).toHaveCount(0);
    await admin.screenshot({ path: `${SHOTS}/tracker-dm.png` });

    // ── A turn's start (AC-CMB-05): Wren's — the bell and the banner for Dave, the camera to Wren (his setting is on
    // by default), every pip back and the whole budget. ──
    await dave.bringToFront();
    // (At least one step: if Wren went first, its turn starts again after a round — the moment is what's checked.)
    await req(admin, "combat.next", {});
    for (let i = 0; i < 8 && (await activeId(admin)) !== wren; i++) {
      await req(admin, "combat.next", {});
      await admin.waitForTimeout(150);
    }
    await expect.poll(() => activeId(dave)).toBe(wren);
    await expect(dave.getByTestId("turn-banner")).toContainText("Your turn");
    await expect(dave.getByTestId("turn-banner")).toContainText("Wren");
    await expect
      .poll(() => dave.evaluate(() => (window.__gloam?.sounds ?? []).some((s) => s.name === "yourTurn")))
      .toBe(true);
    const announced = await hook<{ tokenId: string; focused: boolean }[]>(dave, "turnsAnnounced");
    expect(announced.at(-1)).toMatchObject({ tokenId: wren, focused: true });
    await expect
      .poll(async () => {
        const c = await camera(dave);
        return Math.hypot(c.target[0] - 15, c.target[2] - 20);
      })
      .toBeLessThan(1);
    await expect(tracker(dave).locator(`[data-token="${wren}"]`)).toHaveAttribute("data-active", "1");
    await expect(tracker(dave).getByTestId("turn-ring")).toHaveCount(1);
    const controls = dave.getByTestId("turn-controls");
    await expect(controls).toBeVisible();
    await expect(controls.getByTestId("move-budget")).toContainText("30");
    for (const pip of ["action", "bonus", "reaction", "object"])
      await expect(controls.locator(`[data-pip="${pip}"]`)).toHaveAttribute("aria-pressed", "false");
    await dave.screenshot({ path: `${SHOTS}/your-turn.png` });
    await dave.waitForTimeout(1500);
    await dave.screenshot({ path: `${SHOTS}/your-turn-settled.png` });
    // Every portrait the size of its place — none left over from an earlier turn — and one swelling: the active one.
    const entries = await dave.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="tracker-entry"]')].map((el) => {
        const b = el.querySelector("button")?.getBoundingClientRect();
        const p = el.querySelector("button")?.firstElementChild?.firstElementChild?.getBoundingClientRect();
        return {
          active: el.dataset.active === "1",
          fits: Boolean(b && p && Math.abs(b.width - p.width) < 1 && Math.abs(b.height - p.height) < 1),
          swelling: Boolean(el.querySelector('[class*="turn-swell"]')),
          portraits: el.querySelectorAll("button > span").length,
        };
      }),
    );
    expect(entries.every((e) => e.fits && e.portraits === 1)).toBe(true);
    expect(entries.filter((e) => e.swelling).length).toBe(1);
    expect(entries.find((e) => e.swelling)?.active).toBe(true);

    // ── Pips by hand (AC-CMB-08): the Bonus Action marked, then back. ──
    await controls.locator('[data-pip="bonus"]').click();
    await expect(controls.locator('[data-pip="bonus"]')).toHaveAttribute("aria-pressed", "true");
    await controls.locator('[data-pip="bonus"]').click();
    await expect(controls.locator('[data-pip="bonus"]')).toHaveAttribute("aria-pressed", "false");
    // An attack from the app marks the Action.
    await req(dave, "dice.roll", { formula: "1d20 + 5", purpose: "attack", context: { tokenId: wren } });
    await expect(controls.locator('[data-pip="action"]')).toHaveAttribute("aria-pressed", "true");

    // ── End turn (AC-CMB-06) passes it on; out of turn Dave can't move Wren. ──
    await controls.getByRole("button", { name: "End turn" }).click();
    await expect.poll(() => activeId(admin)).not.toBe(wren);
    await expect(
      req(dave, "move.commit", {
        tokenId: wren,
        points: [
          { x: 15, y: 20 },
          { x: 15, y: 25 },
        ],
      }),
    ).rejects.toThrow(/turn/i);

    // ── The DM's controls (AC-CMB-06): Previous, Set initiative, Delay, drag to reorder, Remove. ──
    await admin.bringToFront();
    const before = (await view(admin)).activeIndex;
    await tracker(admin).getByRole("button", { name: "Previous turn (P)" }).click();
    await expect.poll(async () => (await view(admin)).activeIndex).not.toBe(before);
    await panel.getByLabel("Kell's initiative").fill("30");
    await panel.getByLabel("Kell's initiative").press("Enter");
    await expect.poll(async () => (await view(admin)).entries[0]?.tokenId).toBe(kell);
    await panel.getByRole("button", { name: "Delay Kell" }).click();
    await admin.getByRole("menuitem", { name: "Until after Lurker" }).click();
    await expect
      .poll(async () => {
        const e = (await view(admin)).entries.map((x) => x.tokenId);
        return e.indexOf(kell) === e.indexOf(lurker) + 1;
      })
      .toBe(true);
    // Drag to reorder: the last creature's portrait onto the first's place.
    const ids = (await view(admin)).entries.map((x) => x.tokenId as string);
    const last = ids[ids.length - 1] as string;
    const first = ids[0] as string;
    await tracker(admin)
      .locator(`[data-token="${last}"]`)
      .dragTo(tracker(admin).locator(`[data-token="${first}"]`));
    await expect.poll(async () => (await view(admin)).entries[0]?.tokenId).toBe(last);
    await panel.getByRole("button", { name: "Remove Lurker from combat" }).click();
    await expect(tracker(admin).getByTestId("tracker-entry")).toHaveCount(4);

    // ── Stop (AC-CMB-11): one click; everyone free to move again, the summary to all. ──
    await tracker(admin).getByRole("button", { name: "Stop combat" }).click();
    await expect.poll(async () => (await view(admin)).active).toBe(false);
    await expect(dave.locator("[data-toast]").filter({ hasText: "Combat ended" })).toBeVisible();
    await expect(tracker(admin)).toHaveCount(0);
    await req(dave, "move.commit", {
      tokenId: wren,
      points: [
        { x: 15, y: 20 },
        { x: 15, y: 25 },
      ],
    });

    // ── Quick start (AC-CMB-11): one click, everyone on the scene not hidden, the campaign's method. ──
    await dmSection(admin, "Combat");
    await panel.getByRole("button", { name: "Quick start" }).click();
    await expect.poll(async () => (await view(admin)).active).toBe(true);
    expect((await view(admin)).entries.map((e) => e.tokenId).sort()).toEqual([wren, kell, g1, g2].sort());
    await admin.getByRole("button", { name: "Stop combat" }).first().click();
    await expect.poll(async () => (await view(admin)).active).toBe(false);
  });

  test("AC-MOV-01/15/18: on its turn a drag shows its routed path round a wall — within the budget verdigris, beyond it ember, a hollow mark at the exact budget point — with its length and what's left; an opportunity-attack mark where it leaves a foe's reach (none once Disengaged); the DM's bonus movement in the budget label", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Corridor",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: PLAYER });
    await admin.bringToFront();
    // A wall between Wren and where Dave drags; a goblin right beside Wren.
    await req(admin, "wall.create", {
      sceneId,
      walls: [{ a: { x: 25, y: 8 }, b: { x: 25, y: 32 }, kind: "wall" }],
    });
    const start = { x: 15, y: 20 };
    const { tokenId: wren } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Wren",
      pos: start,
      ownerIds: [await idOf(dave)],
      disposition: "party",
      stats: { hp: 12, hpMax: 12, ac: 15, speeds: { walk: 30 } },
    });
    const { tokenId: goblin } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Goblin",
      pos: { x: 10, y: 20 },
      disposition: "hostile",
      stats: { hp: 7, hpMax: 7, ac: 13 },
    });
    await boardSettled(dave, sceneId);
    // Combat: Dave's initiative entered; the DM steps to Wren's turn.
    await req(admin, "combat.quickStart", {});
    const card = dave.getByTestId("request-group").filter({ hasText: "Initiative" });
    await card.getByRole("button", { name: "Enter physical roll" }).click();
    await card.getByLabel("Your total").fill("22");
    await card.getByLabel("Your total").press("Enter");
    await expect.poll(async () => (await view(admin)).begun, { timeout: 20_000 }).toBe(true);
    for (let i = 0; i < 4 && (await activeId(admin)) !== wren; i++) {
      await req(admin, "combat.next", {});
      await admin.waitForTimeout(150);
    }
    await expect.poll(() => activeId(dave)).toBe(wren);
    await dave.bringToFront();
    await camera(dave, { pitchDeg: 90, distance: 70, target: [28, 20], ms: 0 });
    await dave.waitForTimeout(400);
    await select(dave, start);

    // The DM's bonus movement: "+10 ft for this turn" — in Dave's budget label as its own part (AC-MOV-18).
    await req(admin, "token.update", { tokenId: wren, overrides: { bonusMove: { ft: 10, until: "turn" } } });
    await expect(dave.getByTestId("move-budget")).toContainText("30 + 10");
    await req(admin, "token.update", { tokenId: wren, overrides: { bonusMove: null } });
    await expect(dave.getByTestId("move-budget")).not.toContainText("+");

    // A drag past the wall: routed round its end, longer than the 30 ft left (AC-MOV-01).
    const goal = { x: 35, y: 20 };
    await dragHold(dave, start, goal);
    type Preview = { points: P[]; cost: number; ok: boolean; budget?: number; reach?: P; oa?: { at: P }[] };
    const preview = async () => (await hook<{ preview: Preview | null }>(dave, "move")).preview;
    await expect.poll(async () => (await preview())?.budget).toBe(30);
    const pv = (await preview()) as Preview;
    expect(pv.ok).toBe(true);
    expect(pv.points.length).toBeGreaterThan(2);
    expect(pv.cost).toBeGreaterThan(30);
    // The hollow mark at the exact budget point: 30 ft along the path.
    let along = 0;
    let reachAt = Number.NaN;
    for (let i = 1; i < pv.points.length; i++) {
      const a = pv.points[i - 1] as P;
      const b = pv.points[i] as P;
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      const r = pv.reach as P;
      const t = ((r.x - a.x) * (b.x - a.x) + (r.y - a.y) * (b.y - a.y)) / Math.max(1e-9, seg * seg);
      const off = Math.hypot(a.x + (b.x - a.x) * t - r.x, a.y + (b.y - a.y) * t - r.y);
      if (Number.isNaN(reachAt) && t >= -1e-6 && t <= 1 + 1e-6 && off < 0.05) reachAt = along + t * seg;
      along += seg;
    }
    expect(reachAt).toBeCloseTo(30, 1);
    // The label: its length, and how far over.
    const label = dave.getByTestId("move-label");
    await expect(label).toContainText(`${Math.round(pv.cost)} ft`);
    await expect(label).toContainText("over");
    // On the board: verdigris before the mark, ember after it.
    const rgbAt = async (q: P) => {
      const s = await screen(dave, q.x, q.y, 0.05);
      return hook<number[]>(dave, "boardRgb", s.x, s.y, 1);
    };
    const first = pv.points[1] as P;
    const early = { x: start.x + (first.x - start.x) * 0.35, y: start.y + (first.y - start.y) * 0.35 };
    const last = pv.points[pv.points.length - 1] as P;
    const prev = pv.points[pv.points.length - 2] as P;
    const late = { x: prev.x + (last.x - prev.x) * 0.7, y: prev.y + (last.y - prev.y) * 0.7 };
    await expect
      .poll(async () => {
        const [r, g] = await rgbAt(early);
        return (g as number) - (r as number);
      })
      .toBeGreaterThan(15);
    await expect
      .poll(async () => {
        const [r, g] = await rgbAt(late);
        return (r as number) - (g as number);
      })
      .toBeGreaterThan(15);
    await dave.screenshot({ path: `${SHOTS}/combat-drag.png` });
    // Leaving the goblin's reach (5 ft) on the way: an opportunity attack marked where it does (AC-MOV-15).
    expect((pv.oa ?? []).length).toBeGreaterThan(0);
    await expect(dave.getByTestId("move-oa")).toBeVisible();
    await dave.keyboard.press("Escape");
    await dave.mouse.up();
    await expect.poll(async () => (await preview()) === null).toBe(true);
    // Disengaged: no mark.
    await req(admin, "status.change", { tokenId: wren, add: [{ id: "disengaged" }] });
    await expect
      .poll(async () => (await hook<{ markers: string[] }>(dave, "token", wren))?.markers)
      .toContain("disengaged");
    await dragHold(dave, start, goal);
    await expect.poll(async () => (await preview())?.budget).toBe(30);
    expect(((await preview()) as Preview).oa ?? []).toEqual([]);
    await expect(dave.getByTestId("move-oa")).toHaveCount(0);
    await dave.keyboard.press("Escape");
    await dave.mouse.up();
    void goblin;
  });
});
