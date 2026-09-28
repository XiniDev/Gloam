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

interface P {
  x: number;
  y: number;
}
interface ZoneHook {
  id: string;
  kind: string;
  label: string;
  color: string;
  shapeJson: string;
  dmHidden?: boolean;
  dmJson?: string;
}
interface ZoneToolHook {
  mode: string;
  points: P[];
  selected: string | null;
  preview: unknown;
}
const zones = (p: Page) => hook<ZoneHook[]>(p, "zones");
const zoneTool = (p: Page) => hook<ZoneToolHook>(p, "zoneTool");
const shapeOf = (z: ZoneHook) =>
  JSON.parse(z.shapeJson) as {
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    r: number;
    points: P[];
  };

async function screen(p: Page, x: number, y: number) {
  const s = (await hook<{ sx: number; sy: number }>(p, "project", x, y, 0)) as { sx: number; sy: number };
  return { x: s.sx, y: s.sy };
}
async function moveTo(p: Page, x: number, y: number) {
  const s = await screen(p, x, y);
  await p.mouse.move(s.x, s.y);
}
async function clickAt(p: Page, x: number, y: number) {
  await moveTo(p, x, y);
  await p.mouse.down();
  await p.mouse.up();
}
async function dragOn(p: Page, a: P, b: P, steps = 8) {
  await moveTo(p, a.x, a.y);
  await p.mouse.down();
  for (let i = 1; i <= steps; i++)
    await moveTo(p, a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await p.mouse.up();
}
/** The newest zone once the store holds n of them. */
async function newest(p: Page, n: number): Promise<ZoneHook> {
  await expect.poll(async () => (await zones(p)).length).toBe(n);
  const sel = (await zoneTool(p)).selected;
  const z = (await zones(p)).find((x) => x.id === sel);
  if (!z) throw new Error("the new zone isn't selected");
  return z;
}
async function setLabel(p: Page, text: string) {
  const input = p.getByTestId("zone-editor").getByLabel("Label");
  await input.fill(text);
  await input.press("Enter");
}

test.describe("P3 — the Zones tool (WAL-05)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-WAL-05: the DM draws every kind of zone — rectangles, circles, polygons — labels, colours, hides, moves and reshapes them; a hazard's trigger prompts the DM when a creature walks in", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Marsh",
      mapKind: "procedural",
      floorStyle: "grass",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const daveId = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
    await boardSettled(dave, sceneId);
    await camera(admin, { pitchDeg: 90, distance: 58, target: [30, 18], ms: 0 });
    await admin.waitForTimeout(300);

    // Z: the Zones tool.
    await admin.keyboard.press("z");
    await expect(admin.getByTestId("zones-panel")).toBeVisible();

    // Difficult terrain, a dragged rectangle; it's selected at once and labelled in the zone panel.
    await admin.getByRole("radio", { name: "Rectangle" }).click();
    await admin.getByRole("radio", { name: /Difficult/ }).click();
    await dragOn(admin, { x: 10, y: 5 }, { x: 20, y: 15 });
    const mud = await newest(admin, 1);
    expect(mud.kind).toBe("difficult");
    const ms = shapeOf(mud);
    expect([ms.kind, Math.round(ms.w), Math.round(ms.h)]).toEqual(["rect", 10, 10]);
    await expect(admin.getByTestId("zone-editor")).toBeVisible();
    await setLabel(admin, "Mud");
    await expect.poll(async () => (await zones(admin)).find((z) => z.id === mud.id)?.label).toBe("Mud");

    // Water, a circle dragged from its centre.
    await admin.getByRole("radio", { name: "Circle" }).click();
    await admin.getByRole("radio", { name: /Water/ }).click();
    await dragOn(admin, { x: 38, y: 10 }, { x: 43, y: 10 });
    const pool = await newest(admin, 2);
    const ps = shapeOf(pool);
    expect([pool.kind, ps.kind]).toEqual(["water", "circle"]);
    expect(ps.r).toBeGreaterThan(4.5);
    expect(ps.r).toBeLessThan(5.5);

    // A hazard: a clicked polygon, closed on its first corner; a trigger with a save and damage.
    await admin.getByRole("radio", { name: "Polygon" }).click();
    await admin.getByRole("radio", { name: /Hazard/ }).click();
    await clickAt(admin, 22, 22);
    await clickAt(admin, 32, 22);
    await clickAt(admin, 27, 32);
    expect((await zoneTool(admin)).points).toHaveLength(3);
    await clickAt(admin, 22.3, 22.2);
    const fire = await newest(admin, 3);
    expect([fire.kind, shapeOf(fire).kind, shapeOf(fire).points.length]).toEqual(["hazard", "polygon", 3]);
    await setLabel(admin, "Burning floor");
    const editor = admin.getByTestId("zone-editor");
    await editor.getByRole("button", { name: "Add trigger" }).click();
    await expect(editor.getByTestId("zone-trigger")).toHaveCount(1);
    const formula = editor.getByLabel("Damage formula");
    await formula.fill("1d4");
    await formula.press("Tab");
    await expect
      .poll(
        async () => JSON.parse((await zones(admin)).find((z) => z.id === fire.id)?.dmJson ?? "{}").triggers,
      )
      .toEqual([
        {
          when: "enter",
          label: "Burning floor",
          save: { ability: "dex", dc: 12, onSuccess: "half" },
          damage: { formula: "1d4", type: "fire" },
        },
      ]);

    // Impassable ground and a named area (Label), both rectangles; the label's colour changed.
    await admin.getByRole("radio", { name: "Rectangle" }).click();
    await admin.getByRole("radio", { name: /Impassable/ }).click();
    await dragOn(admin, { x: 45, y: 24 }, { x: 55, y: 34 });
    const rock = await newest(admin, 4);
    expect(rock.kind).toBe("impassable");
    await admin.getByRole("radio", { name: /Label/ }).click();
    await dragOn(admin, { x: 2, y: 26 }, { x: 14, y: 36 });
    const altar = await newest(admin, 5);
    expect(altar.kind).toBe("label");
    await setLabel(admin, "Altar");
    await editor.getByRole("radio", { name: "Verdigris" }).click();
    await expect
      .poll(async () => (await zones(admin)).find((z) => z.id === altar.id)?.color.toLowerCase())
      .toBe("#5fbf9a");

    // Select mode: click the pool, hide it from players.
    await admin.getByRole("radio", { name: "Select zones" }).click();
    await clickAt(admin, 38, 10);
    await expect.poll(async () => (await zoneTool(admin)).selected).toBe(pool.id);
    await editor.getByRole("switch").first().click(); // "Players see it"
    await expect.poll(async () => (await zones(admin)).find((z) => z.id === pool.id)?.dmHidden).toBe(true);
    // Dave sees every zone but the hidden pool, and the labels.
    await expect
      .poll(async () => (await zones(dave)).map((z) => z.label || z.kind).sort())
      .toEqual(["Altar", "Burning floor", "Mud", "impassable"].sort());

    // Move the altar by dragging it; reshape the mud by its corner.
    await clickAt(admin, 8, 31);
    await expect.poll(async () => (await zoneTool(admin)).selected).toBe(altar.id);
    const a0 = shapeOf((await zones(admin)).find((z) => z.id === altar.id) as ZoneHook);
    await dragOn(admin, { x: 8, y: 31 }, { x: 10, y: 29 });
    await expect
      .poll(async () => {
        const s = shapeOf((await zones(admin)).find((z) => z.id === altar.id) as ZoneHook);
        return [Math.round(s.x - a0.x), Math.round(s.y - a0.y), Math.round(s.w - a0.w)];
      })
      .toEqual([2, -2, 0]);
    await clickAt(admin, 15, 10);
    await expect.poll(async () => (await zoneTool(admin)).selected).toBe(mud.id);
    const m0 = shapeOf((await zones(admin)).find((z) => z.id === mud.id) as ZoneHook);
    await dragOn(admin, { x: m0.x + m0.w, y: m0.y + m0.h }, { x: m0.x + m0.w + 4, y: m0.y + m0.h + 2 });
    await expect
      .poll(async () => {
        const s = shapeOf((await zones(admin)).find((z) => z.id === mud.id) as ZoneHook);
        return [Math.round(s.x), Math.round(s.y), Math.round(s.w), Math.round(s.h)];
      })
      .toEqual([Math.round(m0.x), Math.round(m0.y), Math.round(m0.w + 4), Math.round(m0.h + 2)]);

    // The hazard in play: Dave's token walks into the burning floor and the DM is prompted.
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Dave's Rogue",
      pos: { x: 27, y: 15 },
      ownerIds: [daveId],
      disposition: "party",
    });
    await expect.poll(() => hook(dave, "token", tokenId)).not.toBeNull();
    await req(dave, "move.commit", {
      tokenId,
      points: [
        { x: 27, y: 15 },
        { x: 27, y: 27 },
      ],
    });
    await expect(admin.getByText("Burning floor: Dave's Rogue entered")).toBeVisible();
    await expect(
      admin.getByText(/Burning floor — DC 12 DEX save \(half on a success\) — 1d4 fire/),
    ).toBeVisible();
    await expect(dave.getByText(/Burning floor/)).toHaveCount(0);

    // Delete (Del) and undo.
    await admin.keyboard.press("Escape"); // clear the hazard toast's focus, if any
    await clickAt(admin, 8, 29);
    await expect.poll(async () => (await zoneTool(admin)).selected).toBe(altar.id);
    await admin.keyboard.press("Delete");
    await expect.poll(async () => (await zones(admin)).length).toBe(4);
    await admin.keyboard.press("Control+z");
    await expect.poll(async () => (await zones(admin)).length).toBe(5);
  });
});
