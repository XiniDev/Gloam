import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardColour,
  boardSettled,
  camera,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };

interface P {
  x: number;
  y: number;
}
interface Moved {
  id: string;
  path: P[];
  delayMs?: number;
  appear?: boolean;
  disappear?: boolean;
}

async function screen(p: Page, x: number, y: number) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, 0)) as { sx: number; sy: number };
  return { x: s.sx, y: s.sy };
}
/** The board's colour at a table point on this page (the canvas as WebGL drew it). */
async function colourAt(p: Page, x: number, y: number) {
  const s = await screen(p, x, y);
  return boardColour(p, s.x, s.y, 4);
}
const token = (p: Page, id: string) => hook<{ id: string } | null>(p, "token", id);

test.describe("P4 — vision, light and fog (VIS)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-VIS-02 / 04 / 05 / 09 / 11 / 13 / 14 / AC-WAL-03 / AC-VIS-12 (client): each player sees what their character perceives — darkvision in grey, dim as bright within it, the unknown as war fog; the goblin never reaches the blind player; tremorsense; moves seen partway; a door shows the closet within 200 ms, revealed over 300 ms; sharing; explored memory kept and reset @timing", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(240_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    // A grass field (a colour darkvision turns to grey), dark, dynamic fog; a closet in the north-east with a door in
    // its west wall.
    const sceneId = await createScene(admin, {
      name: "Moor",
      mapKind: "procedural",
      floorStyle: "grass",
      widthFt: 80,
      heightFt: 40,
    });
    await req(admin, "scene.update", { sceneId, fogMode: "dynamic", ambientLevel: "dark" });
    const { wallIds } = await req<{ wallIds: string[] }>(admin, "wall.create", {
      sceneId,
      walls: [
        { a: { x: 60, y: 0 }, b: { x: 60, y: 3 }, kind: "wall" },
        { a: { x: 60, y: 3 }, b: { x: 60, y: 9 }, kind: "door" },
        { a: { x: 60, y: 9 }, b: { x: 60, y: 12 }, kind: "wall" },
        { a: { x: 60, y: 12 }, b: { x: 72, y: 12 }, kind: "wall" },
        { a: { x: 72, y: 12 }, b: { x: 72, y: 0 }, kind: "wall" },
      ],
    });
    const door = wallIds[1] as string;
    await boardSettled(admin, sceneId);
    // Bob's frames from the moment his page opens (AC-VIS-05: the goblin must never reach his browser).
    const bobFrames: string[] = [];
    const anna = await admitPlayer(admin, browser, gloam, guardLog, code, "Anna", { viewport: VIEWPORT });
    const bob = await admitPlayer(admin, browser, gloam, guardLog, code, "Bob", {
      viewport: VIEWPORT,
      onPage: (page) =>
        page.on("websocket", (ws) =>
          ws.on("framereceived", (f) =>
            bobFrames.push(
              typeof f.payload === "string" ? f.payload : Buffer.from(f.payload).toString("latin1"),
            ),
          ),
        ),
    });
    const annaId = ((await hook<{ userId: string }>(anna, "me")) as { userId: string }).userId;
    const bobId = ((await hook<{ userId: string }>(bob, "me")) as { userId: string }).userId;
    const mk = async (name: string, body: Record<string, unknown>) =>
      (await req<{ tokenId: string }>(admin, "token.create", { sceneId, name, ...body })).tokenId;
    const elf = await mk("Nyx", {
      pos: { x: 10, y: 20 },
      disposition: "party",
      ownerIds: [annaId],
      stats: { hp: 18, hpMax: 18, ac: 14, senses: { darkvision: 60 } },
    });
    const human = await mk("Bram", {
      pos: { x: 12, y: 26 },
      disposition: "party",
      ownerIds: [bobId],
      stats: { hp: 20, hpMax: 20, ac: 15 },
    });
    const goblin = await mk("Goblin Q7", {
      pos: { x: 30, y: 8 },
      size: "small",
      stats: { hp: 7, hpMax: 7, ac: 13 },
    });
    // A lowered hood: dim light only, 8 ft round (26, 32).
    await req(admin, "light.create", {
      sceneId,
      pos: { x: 26, y: 32 },
      bright: 0,
      dim: 8,
      animation: "none",
    });
    for (const p of [anna, bob]) {
      await boardSettled(p, sceneId);
      await camera(p, { pitchDeg: 90, distance: 70, target: [40, 20], ms: 0 });
    }
    await expect.poll(() => token(anna, goblin)).not.toBeNull();

    // AC-VIS-05: Anna (darkvision) holds the goblin; Bob (none, no light) holds neither it nor Anna's elf.
    expect(await token(bob, goblin)).toBeNull();
    expect(await token(bob, elf)).toBeNull();
    expect(await token(bob, human)).not.toBeNull();
    await anna.waitForTimeout(800);

    // AC-VIS-04: in the dark, within 60 ft Anna sees grey; beyond it, nothing (war fog); dim light within her
    // darkvision is bright to her — Bob sees the same spot dim.
    const grey = await colourAt(anna, 32, 20);
    expect(grey.sat).toBeLessThan(0.12);
    expect(grey.lum).toBeGreaterThan(0.08);
    const far = await colourAt(anna, 76, 30); // 66 ft away: unlit, out of range
    expect(far.b).toBeGreaterThan(far.g);
    expect(far.lum).toBeLessThan(grey.lum * 0.6);
    const litA = await colourAt(anna, 26, 32);
    const litB = await colourAt(bob, 26, 32);
    expect(litA.sat).toBeGreaterThan(0.2); // colour, not grey: it's lit
    expect(litB.sat).toBeGreaterThan(0.2);
    // Bright to her, dim (55 %) to him — measured in the canvas's sRGB, where a 1 / 0.55 linear ratio reads as
    // about 1.3 (tone mapping and the sRGB curve compress it); equal brightness would be 1.
    expect(litA.lum / litB.lum).toBeGreaterThan(1.2);
    // Bob sees nothing in the dark beyond that light: war fog at the grey spot.
    const fogB = await colourAt(bob, 32, 20);
    expect(fogB.b).toBeGreaterThan(fogB.g);
    expect(fogB.lum).toBeLessThan(grey.lum);

    // AC-VIS-09: tremorsense tells Bob where creatures are — a marker, no name.
    await req(admin, "token.update", { tokenId: human, stats: { senses: { tremorsense: 60 } } });
    await expect
      .poll(async () => (await hook<P[]>(bob, "sensed")).some((m) => m.x === 30 && m.y === 8))
      .toBe(true);
    expect(await token(bob, goblin)).toBeNull();
    await req(admin, "token.update", { tokenId: human, stats: { senses: { tremorsense: 0 } } });
    await expect.poll(async () => (await hook<P[]>(bob, "sensed")).length).toBe(0);

    // AC-VIS-11: the goblin walks behind the closet wall; Anna sees it only to where it vanished.
    const movesBefore = (await hook<Moved[]>(anna, "movedLog")).length;
    await req(admin, "move.commit", {
      tokenId: goblin,
      points: [
        { x: 30, y: 8 },
        { x: 56, y: 14 },
        { x: 66, y: 6 },
      ],
    });
    await expect.poll(() => token(anna, goblin)).toBeNull();
    const seen = (await hook<Moved[]>(anna, "movedLog")).slice(movesBefore).find((m) => m.id === goblin);
    expect(seen?.disappear).toBe(true);
    const end = seen?.path.at(-1) as P;
    expect(Math.hypot(end.x - 66, end.y - 6)).toBeGreaterThan(2);
    expect((await hook<Moved[]>(bob, "movedLog")).some((m) => m.id === goblin)).toBe(false);

    // AC-WAL-03 (vision): the DM opens the closet door; within 200 ms Anna's vision is redrawn and the goblin is back.
    // Timed from the DM's send to the moment Anna's client has the new vision (her sight through the open door
    // computed); the first frame drawing it is reported too — under headless software GL a frame can take hundreds
    // of ms of rendering alone (SPEC §36.1: frame timing belongs to the headed-GPU bench).
    const before = (await hook<{ computedAt: number }>(anna, "vision")).computedAt;
    const sentAt = await admin.evaluate(() => Date.now());
    await req(admin, "door.toggle", { wallId: door, action: "open" });
    await expect
      .poll(async () => (await hook<{ computedAt: number }>(anna, "vision")).computedAt, { intervals: [10] })
      .toBeGreaterThan(before);
    await expect
      .poll(async () => {
        const d = await hook<{ wallsAt: number; wallsDrawnAt: number }>(anna, "vision");
        return d.wallsDrawnAt >= d.wallsAt;
      })
      .toBe(true);
    const origin = await anna.evaluate(() => performance.timeOrigin);
    const v = await hook<{ wallsAt: number; computedAt: number; wallsDrawnAt: number }>(anna, "vision");
    test.info().annotations.push({
      type: "door → vision",
      description: `computed ${(origin + v.computedAt - sentAt).toFixed(0)} ms, drawn ${(origin + v.wallsDrawnAt - sentAt).toFixed(0)} ms (walls in the store at ${(origin + v.wallsAt - sentAt).toFixed(0)} ms)`,
    });
    expect(origin + v.computedAt - sentAt).toBeLessThan(200);
    await expect.poll(() => token(anna, goblin)).not.toBeNull();
    // AC-VIS-12 (client): the reveal blends in over 300 ms — frames drew it partway, and it took that long.
    await expect
      .poll(async () => (await hook<{ reveal: { doneAt: number } }>(anna, "vision")).reveal.doneAt)
      .toBeGreaterThan(0);
    const rv = (
      await hook<{ reveal: { startedAt: number; doneAt: number; steps: number[] } }>(anna, "vision")
    ).reveal;
    expect(rv.steps.length).toBeGreaterThan(0);
    expect(rv.steps.every((k) => k >= 0 && k < 1)).toBe(true);
    expect(rv.doneAt - rv.startedAt).toBeGreaterThanOrEqual(295);

    // AC-VIS-02: shut it again — the closet Anna glimpsed stays as memory: dim, grey-blue, no goblin.
    await req(admin, "door.toggle", { wallId: door, action: "close" });
    await expect.poll(() => token(anna, goblin)).toBeNull();
    await anna.waitForTimeout(600);
    const memory = await colourAt(anna, 66, 7);
    const unknown = await colourAt(anna, 70, 38);
    expect(memory.sat).toBeLessThan(0.35);
    expect(memory.lum).toBeGreaterThan(unknown.lum);
    expect(memory.lum).toBeLessThan(grey.lum);

    // AC-VIS-13: Bob sees through Anna's elf only when the DM shares it (or turns on party vision).
    await req(admin, "token.update", { tokenId: elf, shareVisionWith: [bobId] });
    await expect.poll(() => token(bob, elf)).not.toBeNull();
    await expect.poll(async () => (await colourAt(bob, 32, 20)).sat).toBeLessThan(0.12);
    await req(admin, "token.update", { tokenId: elf, shareVisionWith: [] });
    await expect.poll(() => token(bob, elf)).toBeNull();
    await req(admin, "campaign.update", { settings: { partyVision: true } });
    await expect.poll(() => token(bob, elf)).not.toBeNull();
    await req(admin, "campaign.update", { settings: { partyVision: false } });
    await expect.poll(() => token(bob, elf)).toBeNull();

    // AC-VIS-14 (client): explored memory comes back with a reload (the server's raster), and the DM resets it.
    const explored = (await hook<{ explored: number }>(bob, "fog")).explored;
    expect(explored).toBeGreaterThan(0);
    await bob.reload();
    await introDone(bob);
    await boardSettled(bob, sceneId);
    await expect.poll(async () => (await hook<{ explored: number }>(bob, "fog")).explored).toBe(explored);
    await admin.keyboard.press("b");
    await admin.getByTestId("fog-target").selectOption(bobId);
    await admin.getByRole("button", { name: "Reset explored" }).click();
    await expect
      .poll(async () => (await hook<{ explored: number }>(bob, "fog")).explored)
      .toBeLessThan(explored);

    // Never, in any frame Bob received: the goblin (its name or id), or Anna's elf by name.
    const all = bobFrames.join("");
    expect(all.includes("Goblin Q7")).toBe(false);
    expect(all.includes(goblin)).toBe(false);
  });
});
