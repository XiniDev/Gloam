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

interface P {
  x: number;
  y: number;
}
interface MoveHook {
  tokenId: string | null;
  dragging: boolean;
  mode: string;
  waypoints: P[];
  preview: { points: P[]; cost: number; difficultFt: number; ok: boolean } | null;
}
const moveState = (p: Page) => hook<MoveHook>(p, "move");
const tokenPos = async (p: Page, id: string) =>
  ((await hook<{ pos: P }>(p, "token", id)) as { pos: P } | null)?.pos ?? null;
/** The token's drawn position on the table (x, z of its root), which moves while it glides. */
const drawnAt = async (p: Page, id: string) => {
  const s = (await hook<{ position: number[] }>(p, "tokenState", id)) as { position: number[] } | null;
  return s ? { x: s.position[0] as number, y: s.position[2] as number } : null;
};
async function screen(p: Page, x: number, y: number, elevation = 0.15) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, elevation)) as {
    sx: number;
    sy: number;
  };
  return { x: s.sx, y: s.sy };
}
/** Press on the token, drag to (x, y) on the table in steps, and (optionally) let go. */
async function dragToken(
  p: Page,
  from: P,
  to: P,
  opts: { alt?: boolean; release?: boolean; via?: P[] } = {},
) {
  const a = await screen(p, from.x, from.y);
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  // The press must land on the token (a press on the table would pan instead).
  await expect
    .poll(async () => (await hook<{ selection: string[] }>(p, "ui"))?.selection?.length ?? 0)
    .toBe(1);
  if (opts.alt) await p.keyboard.down("Alt");
  const stops = [...(opts.via ?? []), to];
  let cur = from;
  for (const s of stops) {
    for (let i = 1; i <= 8; i++) {
      const q = { x: cur.x + ((s.x - cur.x) * i) / 8, y: cur.y + ((s.y - cur.y) * i) / 8 };
      const sp = await screen(p, q.x, q.y, 0);
      await p.mouse.move(sp.x, sp.y);
      await p.waitForTimeout(40);
    }
    cur = s;
  }
  if (opts.release !== false) {
    await p.mouse.up();
    if (opts.alt) await p.keyboard.up("Alt");
  }
}
/** Distance from p to segment ab. */
function segDist(p: P, a: P, b: P) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

test.describe("P3 — moving tokens (MOV, WAL)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-MOV-08 / AC-MOV-13 / AC-MOV-14 / AC-MOV-17: routed drags go round walls and everyone watches them; freehand stops at walls; waypoints route in order; a hidden wall stops you with a toast", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
    // A wall down the middle with a way round at the south end, and a hidden wall Dave can't know about.
    const wall = { a: { x: 30, y: 0 }, b: { x: 30, y: 28 } };
    await req(admin, "wall.create", {
      sceneId,
      walls: [
        { ...wall, kind: "wall" },
        { a: { x: 12, y: 30 }, b: { x: 12, y: 40 }, kind: "wall", hidden: true },
      ],
    });
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Dave's Rogue",
      pos: { x: 20, y: 10 },
      disposition: "party",
      ownerIds: [daveId],
    });
    await boardSettled(dave, sceneId);
    await expect.poll(() => tokenPos(dave, tokenId)).not.toBeNull();
    for (const p of [dave, admin]) await camera(p, { pitchDeg: 90, distance: 62, target: [30, 20], ms: 0 });
    await dave.waitForTimeout(600);

    // AC-MOV-08: dragging routes round the wall; the pill shows the distance.
    await dragToken(dave, { x: 20, y: 10 }, { x: 40, y: 10 }, { release: false });
    await expect.poll(async () => (await moveState(dave)).preview?.ok).toBe(true);
    const planned = (await moveState(dave)).preview as NonNullable<MoveHook["preview"]>;
    expect(planned.points.length).toBeGreaterThan(2); // it bends round the wall's end
    expect(planned.cost).toBeGreaterThan(Math.hypot(10, 20) * 2 - 1);
    for (let i = 1; i < planned.points.length; i++)
      for (let k = 0; k <= 10; k++) {
        const a = planned.points[i - 1] as P;
        const b = planned.points[i] as P;
        const q = { x: a.x + ((b.x - a.x) * k) / 10, y: a.y + ((b.y - a.y) * k) / 10 };
        expect(segDist(q, wall.a, wall.b)).toBeGreaterThan(1.9);
      }
    await expect(dave.getByTestId("move-label")).toHaveText(/^\d+(\.5)? ft$/);
    // AC-MOV-13: the DM sees the drag as it happens, at most 15 updates a second.
    await expect.poll(async () => (await hook<{ tokenId: string }[]>(admin, "remoteMoves")).length).toBe(1);
    const log = (
      await hook<{ tokenId: string; at: number; points: number }[]>(admin, "remoteMoveLog")
    ).filter((l) => l.tokenId === tokenId && l.points > 0);
    expect(log.length).toBeGreaterThan(1);
    const span = (log[log.length - 1] as { at: number }).at - (log[0] as { at: number }).at;
    expect(log.length - 1).toBeLessThanOrEqual(Math.ceil((span / 1000) * 15) + 1);
    await dave.mouse.up();
    // Committed: the server has it where the preview ended, and on screen it glided along the path — never
    // through the wall.
    const samples: P[] = [];
    await expect
      .poll(
        async () => {
          const d = await drawnAt(admin, tokenId);
          if (d) samples.push(d);
          const pos = await tokenPos(admin, tokenId);
          return (
            pos && Math.hypot(pos.x - 40, pos.y - 10) < 0.01 && d && Math.hypot(d.x - 40, d.y - 10) < 0.05
          );
        },
        { timeout: 15_000, intervals: [60] },
      )
      .toBe(true);
    expect(samples.length).toBeGreaterThan(3);
    for (const s of samples) expect(segDist(s, wall.a, wall.b)).toBeGreaterThan(1.5);
    await expect.poll(async () => (await hook<unknown[]>(admin, "remoteMoves")).length).toBe(0);

    // AC-MOV-14: holding Alt, the path follows the pointer — and stops at the wall (Dave knows it).
    await dragToken(dave, { x: 40, y: 10 }, { x: 20, y: 10 }, { alt: true, release: false });
    await expect.poll(async () => (await moveState(dave)).mode).toBe("freehand");
    const free = (await moveState(dave)).preview as NonNullable<MoveHook["preview"]>;
    const freeEnd = free.points[free.points.length - 1] as P;
    expect(freeEnd.x).toBeGreaterThan(31.5);
    await dave.mouse.up();
    await dave.keyboard.up("Alt");
    await expect.poll(async () => (await tokenPos(dave, tokenId))?.x ?? 0).toBeGreaterThan(31.5);
    await expect.poll(async () => (await tokenPos(dave, tokenId))?.x ?? 0).toBeLessThan(33.5);

    // AC-MOV-03: difficult terrain doubles the part of the path inside it, and the pill says how much was difficult.
    const { zoneId: mud } = await req<{ zoneId: string }>(admin, "zone.create", {
      sceneId,
      kind: "difficult",
      label: "Mud",
      shape: { kind: "rect", x: 40, y: 0, w: 10, h: 40 },
    });
    await expect.poll(async () => (await hook<unknown[]>(dave, "zones")).length).toBe(1);
    const here = (await tokenPos(dave, tokenId)) as P;
    await dragToken(dave, here, { x: 55, y: here.y }, { release: false });
    await expect.poll(async () => (await moveState(dave)).preview?.difficultFt ?? 0).toBeGreaterThan(9.9);
    const through = (await moveState(dave)).preview as NonNullable<MoveHook["preview"]>;
    expect(through.cost).toBeCloseTo(55 - here.x + 10, 1);
    await expect(dave.getByTestId("move-label")).toHaveText(/^\d+(\.5)? ft \(10 ft difficult\)$/);
    await dave.keyboard.press("Escape");
    await dave.mouse.up();
    await req(admin, "zone.delete", { zoneIds: [mud] });

    // AC-MOV-17: click-to-move with Ctrl+click waypoints, through each in order; a plain click goes.
    const start = (await tokenPos(dave, tokenId)) as P;
    const t0 = await screen(dave, start.x, start.y);
    await dave.mouse.click(t0.x, t0.y); // select it
    const w1 = { x: 40, y: 35 };
    const w2 = { x: 50, y: 35 };
    const goal = { x: 50, y: 10 };
    for (const w of [w1, w2]) {
      const s = await screen(dave, w.x, w.y, 0);
      await dave.mouse.move(s.x, s.y);
      await dave.keyboard.down("Control");
      await dave.mouse.click(s.x, s.y);
      await dave.keyboard.up("Control");
    }
    await expect.poll(async () => (await moveState(dave)).waypoints.length).toBe(2);
    const g = await screen(dave, goal.x, goal.y, 0);
    await dave.mouse.move(g.x, g.y);
    await expect.poll(async () => (await moveState(dave)).preview?.ok).toBe(true);
    const via = (await moveState(dave)).preview as NonNullable<MoveHook["preview"]>;
    const legs =
      Math.hypot(w1.x - start.x, w1.y - start.y) +
      Math.hypot(w2.x - w1.x, w2.y - w1.y) +
      Math.hypot(goal.x - w2.x, goal.y - w2.y);
    expect(via.cost).toBeCloseTo(legs, 1);
    for (const w of [w1, w2])
      expect(via.points.some((p) => Math.hypot(p.x - w.x, p.y - w.y) < 1e-6)).toBe(true);
    await expect(dave.getByTestId("move-label")).toContainText("2 waypoints");
    await dave.mouse.click(g.x, g.y);
    await expect
      .poll(async () => {
        const p = await tokenPos(admin, tokenId);
        return p ? Math.hypot(p.x - goal.x, p.y - goal.y) : 99;
      })
      .toBeLessThan(0.01);

    // AC-MOV-08: a wall Dave couldn't see stops him at the point of contact, with the toast.
    await req(admin, "move.commit", { tokenId, points: [goal, { x: 5, y: 35 }] });
    // …and wait for it to finish gliding there before pressing on it.
    await expect
      .poll(async () => {
        const d = await drawnAt(dave, tokenId);
        return d ? Math.hypot(d.x - 5, d.y - 35) : 99;
      })
      .toBeLessThan(0.05);
    await dragToken(dave, { x: 5, y: 35 }, { x: 20, y: 35 });
    await expect(dave.getByText("You bump into something unseen.")).toBeVisible();
    await expect.poll(async () => (await tokenPos(dave, tokenId))?.x ?? 0).toBeLessThan(12 - 1.9);
  });

  test("AC-WAL-03 / AC-WAL-04: door handles — a player opens and shuts a door within reach; a locked one refuses and rattles; the DM locks it from anywhere; a secret door has no handle until the DM opens it", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Cellar",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
    const { wallIds } = await req<{ wallIds: string[] }>(admin, "wall.create", {
      sceneId,
      walls: [
        { a: { x: 30, y: 0 }, b: { x: 30, y: 18 }, kind: "wall" },
        { a: { x: 30, y: 18 }, b: { x: 30, y: 22 }, kind: "door" },
        { a: { x: 30, y: 22 }, b: { x: 30, y: 40 }, kind: "wall" },
      ],
    });
    const door = wallIds[1] as string;
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Dave's Rogue",
      pos: { x: 26, y: 20 },
      disposition: "party",
      ownerIds: [daveId],
    });
    await boardSettled(dave, sceneId);
    await expect.poll(() => tokenPos(dave, tokenId)).not.toBeNull();
    for (const p of [dave, admin]) await camera(p, { pitchDeg: 90, distance: 50, target: [30, 20], ms: 0 });
    await dave.waitForTimeout(600);
    const wall = async (p: Page) => (await hook<{ door: string } | null>(p, "wall", door))?.door;
    const handle = await screen(dave, 30, 20, 0.9);
    // Dave plans a move through the shut door (click-to-move): no way there.
    const me = await screen(dave, 26, 20, 0.15);
    await dave.mouse.click(me.x, me.y);
    const beyond = await screen(dave, 34, 20, 0);
    await dave.mouse.move(beyond.x, beyond.y);
    await expect.poll(async () => (await moveState(dave)).preview?.ok).toBe(false);
    await expect(dave.getByTestId("move-label")).toHaveText("No path");
    // He opens it: within 200 ms of the door opening on his screen, the plan goes straight through (AC-WAL-03).
    // Timed on Dave's clock from the moment the toggle is sent: server, patch, store and re-route included.
    const sent = await dave.evaluate(() => performance.now());
    await req(dave, "door.toggle", { wallId: door });
    await expect
      .poll(async () => {
        const d = await hook<{ worldAt: number; resultAt: number; resultOk: boolean }>(dave, "moveDiag");
        return d.worldAt > sent && d.resultAt >= d.worldAt && d.resultOk;
      })
      .toBe(true);
    const d = await hook<{ worldAt: number; resultAt: number }>(dave, "moveDiag");
    const lag = d.resultAt - sent;
    test.info().annotations.push({
      type: "door → path",
      description: `${lag.toFixed(1)} ms (route ${(d.resultAt - d.worldAt).toFixed(1)} ms)`,
    });
    expect(lag).toBeLessThan(200);
    expect((await moveState(dave)).preview?.cost).toBeCloseTo(8, 0);
    await expect.poll(() => wall(admin)).toBe("open");
    await dave.keyboard.press("Escape"); // drop the plan
    await dave.keyboard.press("Escape"); // and the selection
    // Handles: a click shuts it again.
    await dave.mouse.click(handle.x, handle.y);
    await expect.poll(() => wall(dave)).toBe("closed");
    await dave.mouse.click(handle.x, handle.y);
    await expect.poll(() => wall(dave)).toBe("open");
    await dave.mouse.click(handle.x, handle.y);
    await expect.poll(() => wall(dave)).toBe("closed");
    // The DM locks it with Shift+click on its handle (anywhere); Dave's click is refused and the door stays locked.
    const dmHandle = await screen(admin, 30, 20, 0.9);
    await admin.keyboard.down("Shift");
    await admin.mouse.click(dmHandle.x, dmHandle.y);
    await admin.keyboard.up("Shift");
    await expect.poll(() => wall(dave)).toBe("locked");
    await dave.mouse.click(handle.x, handle.y);
    await dave.waitForTimeout(500);
    expect(await wall(dave)).toBe("locked");
    await expect(dave.getByText("Can't reach that door")).toHaveCount(0);

    // AC-WAL-04: a secret door. The DM sees it (and its handle); to Dave it is a wall — same kind, no door state,
    // no handle.
    const handles = async (p: Page) =>
      (await hook<{ wallId: string; doorState: string }[]>(p, "doorHandles")).map((h) => h.wallId).sort();
    const {
      wallIds: [secret],
    } = await req<{ wallIds: string[] }>(admin, "wall.create", {
      sceneId,
      walls: [{ a: { x: 45, y: 10 }, b: { x: 45, y: 14 }, kind: "secret" }],
    });
    const plain = wallIds[0] as string;
    await expect.poll(() => handles(admin)).toContain(secret);
    await expect.poll(() => hook(dave, "wall", secret)).not.toBeNull();
    const asSeen = async (id: string) => {
      const w = (await hook<Record<string, unknown>>(dave, "wall", id)) as Record<string, unknown>;
      return [w.kind, w.door, w.dmKind, w.dmDoor];
    };
    expect(await asSeen(secret as string)).toEqual(await asSeen(plain));
    expect(await handles(dave)).toEqual([door]);
    // The DM opens it: the gap is real, so Dave now sees an open door (and its handle); shut, it is a wall again.
    await req(admin, "door.toggle", { wallId: secret, action: "open" });
    await expect.poll(() => handles(dave)).toEqual([door, secret].sort());
    expect(await asSeen(secret as string)).toEqual(["door", "open", undefined, undefined]);
    await req(admin, "door.toggle", { wallId: secret, action: "close" });
    await expect.poll(() => handles(dave)).toEqual([door]);
    expect(await asSeen(secret as string)).toEqual(await asSeen(plain));
  });
});
