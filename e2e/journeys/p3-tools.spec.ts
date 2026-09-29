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

const VIEWPORT = { width: 960, height: 640 };

interface MeasureHook {
  points: { x: number; y: number; z: number }[];
  done: boolean;
  shape: string | null;
  ft: number | null;
  shared: { shape: string; by: string; name: string; ft: number }[];
}
const measure = (p: Page) => hook<MeasureHook>(p, "measure");
async function screen(p: Page, x: number, y: number, elevation = 0) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, elevation)) as {
    sx: number;
    sy: number;
  };
  return { x: s.sx, y: s.sy };
}
async function clickAt(p: Page, x: number, y: number) {
  const s = await screen(p, x, y);
  await p.mouse.click(s.x, s.y);
}
async function dragOn(p: Page, a: { x: number; y: number }, b: { x: number; y: number }) {
  const s = await screen(p, a.x, a.y);
  await p.mouse.move(s.x, s.y);
  await p.mouse.down();
  for (let i = 1; i <= 6; i++) {
    const q = await screen(p, a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6);
    await p.mouse.move(q.x, q.y);
  }
  await p.mouse.up();
}

test.describe("P3 — measuring, elevation and pings (MOV-11/12, TOK-07, FUN-02)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-MOV-11 / AC-MOV-12 / AC-TOK-07 / AC-FUN-02: ruler, radius, cone, line and cube in the campaign's units, shared for 3 s; heights in 5-ft steps count in distances; pings in the sender's colour and the Spotlight", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Field",
      mapKind: "procedural",
      floorStyle: "grass",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
    await boardSettled(dave, sceneId);
    for (const p of [dave, admin]) await camera(p, { pitchDeg: 90, distance: 62, target: [30, 20], ms: 0 });
    await dave.waitForTimeout(500);

    // AC-MOV-11: the ruler — click points, double-click to finish; each segment and the total.
    await dave.keyboard.press("m");
    await expect(dave.getByTestId("measure-panel")).toBeVisible();
    await clickAt(dave, 10, 10);
    await clickAt(dave, 20, 10);
    const end = await screen(dave, 20, 20);
    await dave.mouse.move(end.x, end.y);
    await expect(dave.getByTestId("measure-label")).toHaveText("20 ft");
    await dave.mouse.dblclick(end.x, end.y);
    await expect.poll(async () => (await measure(dave)).done).toBe(true);
    expect((await measure(dave)).ft).toBeCloseTo(20, 0);
    // …shown to the DM for 3 s, then gone.
    await expect
      .poll(async () => (await measure(admin)).shared.map((s) => [s.shape, s.name]))
      .toEqual([["ruler", "Dave"]]);
    await expect(admin.getByTestId("measure-shared-label")).toContainText("20 ft");
    await expect.poll(async () => (await measure(admin)).shared.length, { timeout: 6000 }).toBe(0);
    await dave.keyboard.press("Escape");
    expect((await measure(dave)).points).toEqual([]);

    // Radius, cone (53.13°), line and cube: drag out from the origin.
    const shapes: [string, string, { x: number; y: number }, { x: number; y: number }, number][] = [
      ["Radius", "radius", { x: 30, y: 20 }, { x: 30, y: 30 }, 10],
      ["Cone", "cone", { x: 30, y: 20 }, { x: 45, y: 20 }, 15],
      ["Line", "line", { x: 10, y: 30 }, { x: 30, y: 30 }, 20],
      ["Cube", "cube", { x: 40, y: 5 }, { x: 50, y: 15 }, 10],
    ];
    for (const [label, shape, a, b, ft] of shapes) {
      await dave.getByRole("radio", { name: label }).click();
      await dragOn(dave, a, b);
      await expect
        .poll(async () => [(await measure(dave)).shape, (await measure(dave)).done])
        .toEqual([shape, true]);
      expect((await measure(dave)).ft).toBeCloseTo(ft, 0);
      await expect(dave.getByTestId("measure-label")).toHaveText(`${ft} ft`);
      await expect.poll(async () => (await measure(admin)).shared.map((s) => s.shape)).toContain(shape);
    }

    // AC-MOV-12: metres at 5 ft = 1.5 m, to 0.1 m; feet to the nearest 0.5.
    await req(admin, "campaign.update", { units: "m" });
    await expect(dave.getByTestId("measure-label")).toHaveText("3 m"); // the 10-ft cube
    await dave.getByRole("radio", { name: "Ruler" }).click();
    await clickAt(dave, 10, 10);
    const odd = await screen(dave, 22.3, 10);
    await dave.mouse.move(odd.x, odd.y);
    await expect.poll(async () => (await measure(dave)).ft ?? 0).toBeGreaterThan(12);
    const f = (await measure(dave)).ft as number;
    await expect(dave.getByTestId("measure-label")).toHaveText(
      `${(Math.round(f * 0.3 * 10) / 10).toString()} m`,
    );
    await req(admin, "campaign.update", { units: "ft" });
    await expect(dave.getByTestId("measure-label")).toHaveText(`${Math.round(f * 2) / 2} ft`);
    await dave.keyboard.press("Escape");
    await dave.keyboard.press("Escape"); // leaves the tool

    // AC-TOK-07: a flyer rises in 5-ft steps (stepper, Alt+wheel) with a stem, ring and label; distances to it are 3-D.
    const { tokenId: bird } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Dave's Owl",
      pos: { x: 15, y: 20 },
      size: "small",
      ownerIds: [daveId],
      disposition: "party",
      stats: { hp: 5, hpMax: 5, ac: 12, speeds: { walk: 5, fly: 60 } },
    });
    const { tokenId: rock } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Boulder",
      pos: { x: 30, y: 20 },
      hpDisplay: "hidden",
    });
    await expect.poll(() => hook(dave, "token", bird)).not.toBeNull();
    await dave.waitForTimeout(400);
    await clickAt(dave, 15, 20);
    await expect(dave.getByTestId("elevation-stepper")).toBeVisible();
    for (let i = 0; i < 3; i++) await dave.getByRole("button", { name: /Raise 5 ft/ }).click();
    await expect
      .poll(
        async () =>
          ((await hook<{ elevation: number }>(dave, "token", bird)) as { elevation: number }).elevation,
      )
      .toBe(15);
    // Alt+wheel over it: one more step up.
    const over = await screen(dave, 15, 20, 15);
    await dave.mouse.move(over.x, over.y);
    await dave.keyboard.down("Alt");
    await dave.mouse.wheel(0, -120);
    await dave.keyboard.up("Alt");
    await expect
      .poll(
        async () =>
          ((await hook<{ elevation: number }>(dave, "token", bird)) as { elevation: number }).elevation,
      )
      .toBe(20);
    await expect(dave.getByTestId("elevation-value")).toHaveText("+20 ft");
    // The stem, ground ring and label are drawn.
    const state = (await hook<{ parts: Record<string, { visible: boolean }> }>(dave, "tokenState", bird)) as {
      parts: Record<string, { visible: boolean }>;
    };
    for (const part of ["elevationStem", "elevationRing", "elevationLabel"])
      expect(state.parts[part]?.visible, part).toBe(true);
    // Measuring from the flyer to the boulder: hypot(15, 20) = 25 ft.
    await dave.keyboard.press("m");
    await dave.getByRole("radio", { name: "Ruler" }).click();
    // On the owl where it's drawn (20 ft up), then on the boulder: points snap to tokens, at their heights.
    const owl = await screen(dave, 15, 20, 20);
    await dave.mouse.click(owl.x, owl.y);
    const boulder = await screen(dave, 30, 20);
    await dave.mouse.move(boulder.x, boulder.y);
    await dave.mouse.dblclick(boulder.x, boulder.y);
    await expect.poll(async () => (await measure(dave)).ft ?? 0).toBeCloseTo(25, 0);
    void rock;
    await dave.keyboard.press("Escape");
    await dave.keyboard.press("Escape");

    // AC-FUN-02: Alt+click pings for everyone in the sender's colour; the DM's Alt+Shift+click also moves cameras.
    const me = (await hook<{ color: string }>(dave, "me")) as { color: string };
    const at = await screen(dave, 40, 30);
    await dave.keyboard.down("Alt");
    await dave.mouse.click(at.x, at.y);
    await dave.keyboard.up("Alt");
    // The sender sees their own ping at once (pings last 1.6 s: look before it fades), and so does the DM — checked by
    // what each screen showed as it arrived, so a busy machine's slow poll can't miss the DM's.
    await expect.poll(async () => (await hook<unknown[]>(dave, "pings")).length).toBeGreaterThan(0);
    await expect
      .poll(async () =>
        (await hook<{ color: string; spotlight: boolean }[]>(admin, "pingsSeen")).map((p) => [
          p.color.toLowerCase(),
          p.spotlight,
        ]),
      )
      .toContainEqual([me.color.toLowerCase(), false]);
    const before = (await camera(dave)).target;
    const spot = await screen(admin, 50, 8);
    await admin.keyboard.down("Alt");
    await admin.keyboard.down("Shift");
    await admin.mouse.click(spot.x, spot.y);
    await admin.keyboard.up("Shift");
    await admin.keyboard.up("Alt");
    await expect
      .poll(async () => (await hook<{ spotlight: boolean }[]>(dave, "pingsSeen")).some((p) => p.spotlight))
      .toBe(true);
    await expect
      .poll(async () => {
        const t = (await camera(dave)).target;
        return Math.hypot(t[0] - 50, t[2] - 8);
      })
      .toBeLessThan(1);
    expect(Math.hypot(before[0] - 50, before[2] - 8)).toBeGreaterThan(5);
  });

  test("SPEC §8.4 O: an orthographic top-down view for precise measuring — tilts to 90° first, keeps the view, measures true, and any tilt leaves it", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    await camera(admin, { pitchDeg: 55, distance: 60, target: [30, 20], ms: 0 });
    await admin.waitForTimeout(400);
    // O: tilts to top-down over 400 ms, then switches to orthographic with the same target.
    await admin.keyboard.press("o");
    await expect.poll(async () => (await camera(admin)).ortho, { timeout: 5000 }).toBe(true);
    const o = await camera(admin);
    // The new camera is in place the moment it exists: what's drawn and what a click picks is the view reported.
    expect(o.inSync).toBe(true);
    expect(o.pitchDeg).toBeGreaterThan(89.5);
    expect(Math.hypot(o.target[0] - 30, o.target[2] - 20)).toBeLessThan(0.05);
    // Measuring is true everywhere on screen: a 20-ft ruler from the middle to near the edge reads 20 ft.
    await admin.keyboard.press("m");
    await clickAt(admin, 20, 20);
    const end = await screen(admin, 40, 20);
    await admin.mouse.move(end.x, end.y);
    await admin.mouse.dblclick(end.x, end.y);
    await expect.poll(async () => (await measure(admin)).ft ?? 0).toBeCloseTo(20, 0);
    await expect(admin.getByTestId("measure-label")).toHaveText("20 ft");
    await admin.keyboard.press("Escape");
    await admin.keyboard.press("Escape");
    // The wheel zooms (it doesn't dolly): the zoom changes, the view stays top-down and orthographic.
    const z0 = (await camera(admin)).zoom;
    const mid = await screen(admin, 30, 20);
    await admin.mouse.move(mid.x, mid.y);
    await admin.mouse.wheel(0, -300);
    await expect.poll(async () => (await camera(admin)).zoom).toBeGreaterThan(z0 * 1.05);
    expect((await camera(admin)).ortho).toBe(true);
    // O again: back to perspective, top-down, over the same point.
    await admin.keyboard.press("o");
    await expect.poll(async () => (await camera(admin)).ortho).toBe(false);
    const p = await camera(admin);
    expect(p.inSync).toBe(true);
    expect(p.pitchDeg).toBeGreaterThan(89.5);
    expect(Math.hypot(p.target[0] - 30, p.target[2] - 20)).toBeLessThan(1);
    // And a tilt preset leaves orthographic by itself.
    await admin.keyboard.press("o");
    await expect.poll(async () => (await camera(admin)).ortho).toBe(true);
    await admin.keyboard.press("Shift+Digit2");
    await expect.poll(async () => (await camera(admin)).ortho).toBe(false);
    await expect.poll(async () => Math.round((await camera(admin)).pitchDeg)).toBe(55);
    // Back in perspective the camera answers as before: a view set outright is where it lands, and stays.
    await camera(admin, { pitchDeg: 40, distance: 26, target: [32, 8], ms: 0 });
    // At once — no frame needed first: what's projected next goes through this view.
    const back = await camera(admin);
    expect(back.inSync).toBe(true);
    expect(Math.round(back.pitchDeg)).toBe(40);
    expect(back.distance).toBeCloseTo(26, 0);
    expect(Math.hypot(back.target[0] - 32, back.target[2] - 8)).toBeLessThan(0.05);
    // And what's drawn is that view: the table point under the screen's centre is the target.
    const c = await screen(admin, 32, 8);
    const vp = admin.viewportSize() as { width: number; height: number };
    expect(Math.abs(c.x - vp.width / 2)).toBeLessThan(2);
    // A scene update landing while a camera move is still to be drawn doesn't undo the move.
    for (const [i, target] of [
      [0, [20, 20]],
      [1, [40, 12]],
      [2, [28, 30]],
    ] as const) {
      await Promise.all([
        camera(admin, { pitchDeg: 50, distance: 40, target: [target[0], target[1]], ms: 0 }),
        req(admin, "scene.update", { sceneId, walls3d: i % 2 === 0 }),
      ]);
      await admin.waitForTimeout(400);
      const now = await camera(admin);
      expect(Math.hypot(now.target[0] - target[0], now.target[2] - target[1]), `move ${i}`).toBeLessThan(
        0.05,
      );
    }
  });
});
