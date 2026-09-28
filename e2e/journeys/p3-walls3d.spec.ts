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

interface Walls3D {
  stone: number;
  ghost: number;
  stoneMaterial: string | null;
  glass: number;
  curtains: number;
  fields: number;
  doors: Record<string, number>;
  cut: boolean;
}
const w3d = (p: Page) => hook<Walls3D | null>(p, "walls3d");

test.describe("P3 — walls in 3D (WAL-06)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-WAL-06: 'Walls in 3D' extrudes walls in stone; doors swing open and shut over 300 ms; windows are glass, curtains cloth; players get no geometry for hidden or invisible walls", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Keep",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    // A room: stone walls, a door, a window, a curtain, a secret door, a hidden wall and an invisible wall.
    const { wallIds } = await req<{ wallIds: string[] }>(admin, "wall.create", {
      sceneId,
      walls: [
        { a: { x: 15, y: 10 }, b: { x: 30, y: 10 }, kind: "wall" },
        { a: { x: 30, y: 10 }, b: { x: 34, y: 10 }, kind: "door" },
        { a: { x: 34, y: 10 }, b: { x: 45, y: 10 }, kind: "window" },
        { a: { x: 45, y: 10 }, b: { x: 45, y: 30 }, kind: "curtain" },
        { a: { x: 45, y: 30 }, b: { x: 15, y: 30 }, kind: "wall" },
        { a: { x: 15, y: 30 }, b: { x: 15, y: 22 }, kind: "wall" },
        { a: { x: 15, y: 22 }, b: { x: 15, y: 18 }, kind: "secret" },
        { a: { x: 15, y: 18 }, b: { x: 15, y: 10 }, kind: "wall", hidden: true },
        { a: { x: 25, y: 10 }, b: { x: 25, y: 20 }, kind: "invisible" },
      ],
    });
    const door = wallIds[1] as string;
    const secret = wallIds[6] as string;
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    await boardSettled(dave, sceneId);

    // Procedural scenes start with walls in 3D. The DM sees everything: stone (3 walls + 1 wall piece of the
    // window's 2 + the door's and secret door's lintels = 2 + window sill and header = 2 → 7), the hidden wall as a
    // ghost, the invisible wall as a field, two leaves (the door; the secret door, in stone).
    await expect
      .poll(() => w3d(admin))
      .toMatchObject({
        stone: 7,
        ghost: 1,
        stoneMaterial: "gloam-wall-stone",
        glass: 1,
        curtains: 1,
        fields: 1,
      });
    expect(Object.keys((await w3d(admin))?.doors ?? {}).sort()).toEqual([door, secret].sort());
    // Dave: the secret door is a wall (stone), the hidden wall and the invisible one aren't there at all.
    await expect
      .poll(() => w3d(dave))
      .toMatchObject({ stone: 7, ghost: 0, glass: 1, curtains: 1, fields: 0 });
    expect(Object.keys((await w3d(dave))?.doors ?? {})).toEqual([door]);

    // The door swings open over 300 ms, through the angles in between, and shuts again the same way.
    for (const p of [admin, dave]) await camera(p, { pitchDeg: 38, distance: 55, target: [30, 20], ms: 0 });
    await admin.waitForTimeout(400);
    // At this angle the walls between the camera and the room are cut down so the floor inside shows; from straight
    // above nothing is cut.
    await expect.poll(async () => (await w3d(dave))?.cut).toBe(true);
    const T = [0, 75, 150, 225, 300, 450];
    const curve = async (to: number) => {
      await expect.poll(async () => (await w3d(dave))?.doors[door]).toBe(to);
      return (await hook<{ from: number; to: number; at: number[] }>(dave, "doorSwing", door, T)) as {
        from: number;
        to: number;
        at: number[];
      };
    };
    await req(admin, "door.toggle", { wallId: door, action: "open" });
    const open = await curve(88);
    // Eased from shut to open over exactly 300 ms: halfway at 150 ms, there at 300.
    expect([open.from, open.to]).toEqual([0, 88]);
    expect(open.at[0]).toBe(0);
    expect(open.at[2]).toBeCloseTo(44, 5);
    expect(open.at[4]).toBe(88);
    expect(open.at[5]).toBe(88);
    for (let i = 1; i < T.length; i++)
      expect(open.at[i] as number).toBeGreaterThanOrEqual(open.at[i - 1] as number);
    expect(open.at[1] as number).toBeGreaterThan(0);
    expect(open.at[3] as number).toBeLessThan(88);
    await dave.screenshot({ path: "artifacts/screens/p3/walls3d-open.png" });
    await req(admin, "door.toggle", { wallId: door, action: "close" });
    const shut = await curve(0);
    expect([shut.from, shut.to]).toEqual([88, 0]);
    expect(shut.at[2]).toBeCloseTo(44, 5);
    expect(shut.at[4]).toBe(0);

    await camera(dave, { pitchDeg: 90, distance: 55, target: [30, 20], ms: 0 });
    await expect.poll(async () => (await w3d(dave))?.cut).toBe(false);
    await dave.screenshot({ path: "artifacts/screens/p3/walls3d-top.png" });
    await camera(dave, { pitchDeg: 38, distance: 55, target: [30, 20], ms: 0 });

    // The DM turns walls in 3D off from the Walls tool's bar.
    await admin.keyboard.press("w");
    await admin.getByRole("button", { name: "Walls in 3D: on" }).click();
    await expect.poll(() => w3d(dave)).toBeNull();
    await expect.poll(() => w3d(admin)).toBeNull();
    await admin.getByRole("button", { name: "Walls in 3D: off" }).click();
    await expect.poll(async () => (await w3d(dave))?.stone).toBe(7);
  });
});
