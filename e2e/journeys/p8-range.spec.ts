import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  camera,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };
const SHOTS = "artifacts/screens/p8";

interface P {
  x: number;
  y: number;
}
type Range = { tokenId: string; budget: number; h: number; ms: number; limit: P[] } | null;
const range = (p: Page) => hook<Range>(p, "rangeOverlay");
const costAt = (p: Page, x: number, y: number) => hook<number | null>(p, "rangeCostAt", x, y);
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The true geodesic from `o` to `q` round a wall's end for a creature of clearance `rc` (the wall inflated by rc is a
 * stadium; round its end the shortest way is straight to the end's circle, along it, and straight on) — the arc on
 * the side away from the wall (`along`: the wall's direction from that end), never through it.
 */
function roundEnd(o: P, end: P, along: P, q: P, rc: number): number {
  const a = dist(o, end);
  const b = dist(q, end);
  const t1 = Math.sqrt(a * a - rc * rc);
  const t2 = Math.sqrt(b * b - rc * rc);
  const ang = (p: P) => Math.atan2(p.y - end.y, p.x - end.x);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // The arc from o's direction to q's that doesn't sweep past the wall's direction.
  const from = ang(o);
  const sweep = norm(ang(q) - from);
  const wall = norm(Math.atan2(along.y, along.x) - from);
  const between = wall < sweep ? 2 * Math.PI - sweep : sweep;
  const wrap = between - Math.acos(rc / a) - Math.acos(rc / b);
  return t1 + t2 + rc * Math.max(0, wrap);
}

/**
 * Clicks a token on the board (its screen point from the test hook), so it's selected — again after a moment if the
 * first click went to a page just brought back to the front.
 */
async function select(p: Page, at: P) {
  const selected = async () => (await hook<{ selection: string[] }>(p, "ui"))?.selection?.length ?? 0;
  for (let attempt = 0; attempt < 3 && (await selected()) !== 1; attempt++) {
    const s = (await hook<{ sx: number; sy: number }>(p, "project", at.x, at.y, 0.2)) as {
      sx: number;
      sy: number;
    };
    await p.mouse.click(s.sx, s.sy);
    await expect
      .poll(selected, { timeout: 2000 })
      .toBe(1)
      .catch(() => {});
  }
  expect(await selected()).toBe(1);
}

/** The board's brightest pixel within `r` px of a screen point (luminance 0–255), from its drawing buffer. */
const brightestNear = (p: Page, x: number, y: number, r = 4) => hook<number>(p, "boardPixels", x, y, r);

test.describe("P8 — the movement range overlay (MOV-10)", () => {
  test.use({ viewport: VIEWPORT });
  test.setTimeout(240_000);

  test("AC-MOV-10: with G, the selected creature's reachable floor round walls and through difficult ground, its limit within 1 ft of the true geodesic — one move at its speed outside combat, what's left of its turn in it", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Range",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 100,
      heightFt: 80,
    });
    await boardSettled(admin, sceneId);
    // Dave joins first (a page opened behind another doesn't animate: its intro would wait for the front).
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    await admin.bringToFront();
    // A wall east of the scout, and difficult ground south of it.
    const top = { x: 52, y: 28 };
    const bottom = { x: 52, y: 52 };
    await req(admin, "wall.create", { sceneId, walls: [{ a: top, b: bottom, kind: "wall" }] });
    await req(admin, "zone.create", {
      sceneId,
      kind: "difficult",
      label: "Rubble",
      shape: { kind: "rect", x: 30, y: 50, w: 20, h: 30 },
    });
    const origin = { x: 40, y: 40 };
    const { tokenId: scout } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Scout",
      pos: origin,
      stats: { hp: 11, hpMax: 11, ac: 13, speeds: { walk: 30 } },
    });
    await camera(admin, { pitchDeg: 90, distance: 95, target: [40, 40], ms: 0 });
    await admin.waitForTimeout(400);
    await select(admin, origin);

    // G: its field — one move at its speed (30 ft; 0.5-ft cells at that budget), from the worker.
    await admin.keyboard.press("g");
    await expect.poll(() => range(admin), { timeout: 10_000 }).not.toBeNull();
    const field = (await range(admin)) as NonNullable<Range>;
    expect(field.tokenId).toBe(scout);
    expect(field.budget).toBe(30);
    expect(field.h).toBe(0.5);
    test
      .info()
      .annotations.push({ type: "range field", description: `${field.ms.toFixed(1)} ms in the worker` });
    // Open ground (west): the limit 30 ft out, within 1 ft.
    const west = field.limit.filter((p) => p.x < 25 && Math.abs(p.y - 40) < 8);
    expect(west.length).toBeGreaterThan(4);
    for (const p of west) expect(Math.abs(dist(p, origin) - 30), JSON.stringify(p)).toBeLessThanOrEqual(1);
    // Behind the wall: round its end, as far as the true geodesic says (a medium creature keeps 2 ft off it).
    const rc = 2;
    // (Points within its reach — the field runs two cells past the budget, no further — and round the wall's top end,
    // clear of the rubble, which the way round its bottom end would cross.)
    for (const q of [
      { x: 56, y: 34 },
      { x: 58, y: 28 },
      { x: 60, y: 32 },
    ]) {
      const truth = Math.min(
        roundEnd(origin, top, { x: 0, y: 1 }, q, rc),
        roundEnd(origin, bottom, { x: 0, y: -1 }, q, rc),
      );
      const got = (await costAt(admin, q.x, q.y)) as number;
      expect(got, `behind the wall at ${JSON.stringify(q)}`).not.toBeNull();
      expect(
        Math.abs(got - truth),
        `behind the wall at ${JSON.stringify(q)}: ${got} vs ${truth}`,
      ).toBeLessThanOrEqual(1);
    }
    // Through the rubble (double cost): 10 ft to it, then 10 ft in it — its limit is 20 ft out straight south.
    expect(Math.abs(((await costAt(admin, 40, 60)) as number) - 30)).toBeLessThanOrEqual(1);
    const south = field.limit.filter((p) => Math.abs(p.x - 40) < 1.5 && p.y > 45);
    expect(south.length).toBeGreaterThan(0);
    for (const p of south) expect(Math.abs(p.y - 60), JSON.stringify(p)).toBeLessThanOrEqual(1);

    // On screen: the bright limit line where the field says (west), soft floor inside it.
    const at = (await hook<{ sx: number; sy: number }>(admin, "project", 10, 40, 0.05)) as {
      sx: number;
      sy: number;
    };
    await admin.bringToFront();
    const why = async () =>
      JSON.stringify({
        visible: await admin.evaluate(() => document.visibilityState),
        frames: (await hook<{ frames: number }>(admin, "stats")).frames,
        overlay: (await range(admin)) !== null,
      });
    await expect
      .poll(() => brightestNear(admin, at.sx, at.sy), { timeout: 10_000, message: await why() })
      .toBeGreaterThan(200);
    await admin.screenshot({ path: `${SHOTS}/range-overlay.png` });
    // G again: gone.
    await admin.keyboard.press("g");
    await expect.poll(() => range(admin)).toBeNull();

    // ── In combat: what's left of its turn. ──
    await dave.bringToFront();
    const start = { x: 30, y: 20 };
    const { tokenId: wren } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Wren",
      pos: start,
      ownerIds: [daveId],
      disposition: "party",
      stats: { hp: 12, hpMax: 12, ac: 15, speeds: { walk: 30 } },
    });
    await boardSettled(dave, sceneId);
    await req(admin, "combat.quickStart", {});
    // Dave's initiative card: he enters what he rolled at the table.
    const card = dave.getByTestId("request-group").filter({ hasText: "Initiative" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Enter physical roll" }).click();
    await card.getByRole("textbox").fill("25");
    await card.getByRole("textbox").press("Enter");
    type CombatView = {
      active: boolean;
      begun: boolean;
      activeIndex: number;
      entries: { tokenId: string }[];
    };
    await expect.poll(async () => (await hook<CombatView>(dave, "combat")).begun).toBe(true);
    for (let i = 0; i < 4; i++) {
      const v = await hook<CombatView>(dave, "combat");
      if (v.entries[v.activeIndex]?.tokenId === wren) break;
      await req(admin, "combat.next", {});
      await dave.waitForTimeout(150);
    }
    await expect
      .poll(async () => {
        const v = await hook<CombatView>(dave, "combat");
        return v.entries[v.activeIndex]?.tokenId;
      })
      .toBe(wren);
    await camera(dave, { pitchDeg: 90, distance: 95, target: [30, 30], ms: 0 });
    await dave.waitForTimeout(400);
    await select(dave, start);
    await dave.keyboard.press("g");
    await expect.poll(async () => (await range(dave))?.budget).toBe(30);
    // 10 ft moved: 20 left, and the limit draws in round where it stands now.
    await req(dave, "move.commit", { tokenId: wren, points: [start, { x: 20, y: 20 }] });
    await expect.poll(async () => (await range(dave))?.budget).toBe(20);
    const now = (await range(dave)) as NonNullable<Range>;
    const open = now.limit.filter((p) => p.y > 25 && p.x < 20);
    expect(open.length).toBeGreaterThan(2);
    for (const p of open)
      expect(Math.abs(dist(p, { x: 20, y: 20 }) - 20), JSON.stringify(p)).toBeLessThanOrEqual(1);
    await dave.screenshot({ path: `${SHOTS}/range-overlay-combat.png` });
  });
});
