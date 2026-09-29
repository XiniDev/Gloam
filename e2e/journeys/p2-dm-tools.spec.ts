import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  assetFixtures,
  boardSettled,
  checkerPng,
  createScene,
  dmSection,
  hook,
  introDone,
  req,
  stats,
  uploadVia,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };

async function dmPanel(page: Page, tab: "Scenes" | "Library" | "Approvals"): Promise<void> {
  await dmSection(page, tab);
}

/** Screen point of an image pixel inside the calibration editor. */
async function imagePoint(page: Page, px: number, py: number, imageW: number, imageH: number) {
  const r = (await page.getByTestId("calibration-image").boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  return { x: r.x + (px / imageW) * r.width, y: r.y + (py / imageH) * r.height };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test.describe("P2 — DM tools: calibration, 3D maps, the Library (SCN-01, SCN-04, AST-06)", () => {
  test.use({ viewport: VIEWPORT });

  test("AC-SCN-01: a new image scene opens calibration with three methods; after calibrating, a 5-ft feature measures 5 ft ± 0.1 on the ruler", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    // A 1000 × 800 map whose printed grid is 100 px per 5 ft (10 × 8 squares).
    const W = 1000;
    const H = 1000;
    await dmPanel(admin, "Scenes");
    await admin.getByRole("button", { name: "New scene" }).first().click();
    await admin.getByRole("button", { name: /Upload a map image/ }).click();
    await admin
      .getByRole("dialog", { name: "Upload a map image" })
      .locator('input[type="file"]')
      .setInputFiles({ name: "Chapel.png", mimeType: "image/png", buffer: await checkerPng(W, 10) });
    const dlg = admin.getByRole("dialog", { name: "Calibrate the map" });
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    // The three methods.
    const methods = dlg.getByRole("radiogroup", { name: "Calibration method" });
    for (const m of ["Presets", "Known distance", "Map width"])
      await expect(methods.getByRole("radio", { name: m })).toBeVisible();
    const summary = dlg.getByTestId("calibration-summary");
    // Presets: 100 px per 5 ft.
    await dlg.getByRole("button", { name: "100", exact: true }).click();
    await expect(summary).toContainText("100.0 px");
    // Map width: 50 ft across 1000 px is the same scale; 40 ft is not.
    await methods.getByRole("radio", { name: "Map width" }).click();
    await dlg.getByLabel("The whole map is this wide (ft)").fill("40");
    await expect(summary).toContainText("125.0 px");
    await dlg.getByLabel("The whole map is this wide (ft)").fill("50");
    await expect(summary).toContainText("100.0 px");
    // Known distance: drag over one printed square (100 px) and call it 5 ft.
    await methods.getByRole("radio", { name: "Presets" }).click();
    await dlg.getByRole("button", { name: "70", exact: true }).click();
    await expect(summary).toContainText("70.0 px");
    await methods.getByRole("radio", { name: "Known distance" }).click();
    await drag(admin, await imagePoint(admin, 200, 450, W, H), await imagePoint(admin, 300, 450, W, H));
    await dlg.getByLabel("Its length (ft)").fill("5");
    await dlg.getByLabel("Its length (ft)").press("Tab");
    await expect(summary).toContainText(/(99|100|101)\.\d px/);
    // The ruler over another 5-ft feature (a square elsewhere on the map) reads 5 ft ± 0.1.
    const handles = dlg.locator("circle[data-handle]");
    const a = (await handles.nth(0).boundingBox()) as { x: number; y: number; width: number; height: number };
    await drag(
      admin,
      { x: a.x + a.width / 2, y: a.y + a.height / 2 },
      await imagePoint(admin, 600, 750, W, H),
    );
    const b = (await handles.nth(1).boundingBox()) as { x: number; y: number; width: number; height: number };
    await drag(
      admin,
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      await imagePoint(admin, 700, 750, W, H),
    );
    const ruler = Number((await dlg.getByTestId("ruler-length").innerText()).match(/[\d.]+/)?.[0]);
    test.info().annotations.push({ type: "ruler", description: `${ruler} ft over one printed square` });
    expect(Math.abs(ruler - 5)).toBeLessThanOrEqual(0.1);
    // And the scene is built at that scale: 1000 px → 50 ft (±2 %: the drag is by hand).
    await dlg.getByRole("button", { name: "Next" }).click();
    const name = admin.getByRole("dialog", { name: "Name the scene" });
    await name.getByLabel("Scene name").fill("The Chapel");
    await name.getByRole("button", { name: "Create scene" }).click();
    await expect(admin.getByTestId("prep-banner")).toContainText("The Chapel");
    await expect
      .poll(async () => (await stats(admin)).map?.worldW ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(49);
    expect((await stats(admin)).map?.worldW).toBeLessThan(51);
  });

  test("AC-SCN-04: a 3D map is positioned, rotated and scaled; Generate walls makes editable, merged, simplified walls that undo as one", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const { roomGlb } = await assetFixtures();
    const map = await uploadVia(admin, await roomGlb(), "Crypt.glb", "map");
    const sceneId = await createScene(admin, { name: "The Crypt", mapKind: "model", mapAssetId: map.id });
    await boardSettled(admin, sceneId);
    await dmPanel(admin, "Scenes");
    await admin.getByRole("button", { name: "More for The Crypt" }).click();
    await admin.getByRole("menuitem", { name: "Align 3D map" }).click();
    const tools = admin.getByTestId("map-tools");
    await expect(tools).toBeVisible();
    // Gizmo modes from the keyboard.
    const gizmo = tools.getByRole("radiogroup", { name: "Gizmo" });
    for (const [key, label] of [
      ["KeyE", "Rotate about Y (E)"],
      ["KeyR", "Uniform scale (R)"],
      ["KeyW", "Move (W)"],
    ] as const) {
      await admin.locator("body").press(key);
      await expect(gizmo.getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true");
    }
    // Exact placement: move 10 ft east and 5 ft south, turn 90°.
    const calib = async () =>
      JSON.parse(((await hook<{ calibJson: string }>(admin, "scene")) as { calibJson: string }).calibJson);
    for (const [label, v] of [
      ["X", "10"],
      ["Z", "5"],
      ["Turn", "90"],
    ] as const) {
      await tools.getByLabel(label, { exact: true }).fill(v);
      await tools.getByLabel(label, { exact: true }).press("Enter");
    }
    await expect.poll(calib).toMatchObject({ position: { x: 10, y: 0, z: 5 }, rotationYDeg: 90, scale: 1 });

    // Generate walls at 5 ft: the room's inner and outer rings, 8 merged walls, turned and moved with the map.
    await tools.getByRole("button", { name: "Generate walls" }).click();
    await expect(admin.getByText(/Generated 8 walls/)).toBeVisible({ timeout: 30_000 });
    type Wall = { id: string; ax: number; ay: number; bx: number; by: number; kind: string };
    const walls = () => hook<Wall[]>(admin, "walls");
    await expect.poll(async () => (await walls()).length).toBe(8);
    const w = await walls();
    const len = (x: Wall) => Math.hypot(x.bx - x.ax, x.by - x.ay);
    expect(
      w
        .map(len)
        .sort((p, q) => p - q)
        .map((n) => Math.round(n * 10) / 10),
    ).toEqual([20, 20, 22, 22, 30, 30, 32, 32]);
    // Outer box x ∈ [−1, 21], z ∈ [−1, 31] turned 90° (x, z) → (z, −x), then moved (+10, +5).
    const xs = w.flatMap((x) => [x.ax, x.bx]);
    const zs = w.flatMap((x) => [x.ay, x.by]);
    expect(Math.min(...xs)).toBeCloseTo(9, 1);
    expect(Math.max(...xs)).toBeCloseTo(41, 1);
    expect(Math.min(...zs)).toBeCloseTo(-16, 1);
    expect(Math.max(...zs)).toBeCloseTo(6, 1);
    expect(new Set(w.map((x) => x.kind))).toEqual(new Set(["wall"]));
    // Editable: they're ordinary walls (delete one), and one Ctrl+Z each undoes the edit, then the whole set.
    await req(admin, "wall.delete", { wallIds: [(w[0] as Wall).id] });
    await expect.poll(async () => (await walls()).length).toBe(7);
    await admin.locator("body").press("Control+z");
    await expect.poll(async () => (await walls()).length).toBe(8);
    await admin.locator("body").press("Control+z");
    await expect.poll(async () => (await walls()).length).toBe(0);
    await admin.locator("body").press("Control+Shift+z");
    await expect.poll(async () => (await walls()).length).toBe(8);
    // Scaled ×2 and generated again, replacing the old set: every wall doubles.
    await tools.getByLabel("Scale", { exact: true }).fill("2");
    await tools.getByLabel("Scale", { exact: true }).press("Enter");
    await expect.poll(async () => (await calib()).scale).toBe(2);
    await tools.getByRole("button", { name: "Generate walls" }).click();
    await admin.getByRole("button", { name: "Replace them" }).click();
    await expect
      .poll(
        async () =>
          (await walls())
            .map(len)
            .sort((p, q) => p - q)
            .map((n) => Math.round(n)),
        { timeout: 30_000 },
      )
      .toEqual([40, 40, 44, 44, 60, 60, 64, 64]);
    await admin.screenshot({ path: "artifacts/screens/p2-map-tools.png" });
  });

  test("AC-AST-06: the Library searches, filters, tags, renames, drags onto the board and soft-deletes with undo and a trash", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const { portraitPng, dungeonPng } = await assetFixtures();
    const sceneId = await createScene(admin, {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "wood",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    // Three different images (the same bytes twice would be one Library item, by design).
    for (const [n, kind, hue] of [
      ["Goblin archer", "goblin", 0],
      ["Goblin shaman", "goblin", 70],
      ["Owlbear", "owl", 30],
    ] as const)
      await uploadVia(admin, await portraitPng(kind, { size: 128, hue }), `${n}.png`, "token");
    await uploadVia(admin, await dungeonPng({ cols: 14, rows: 9 }), "Crypt map.png", "map");
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    await uploadVia(dave, await portraitPng("owl", { size: 96 }), "Dave's familiar.png", "token");

    await dmPanel(admin, "Library");
    const cards = admin.getByRole("list", { name: "Library items" }).locator("[data-asset]");
    const names = async () =>
      (await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-asset")))).sort();
    await expect.poll(names).toEqual(["Dave's familiar", "Goblin archer", "Goblin shaman", "Owlbear"]);
    // Search.
    const search = admin.getByLabel("Search the Library");
    await search.fill("shaman");
    await expect.poll(names).toEqual(["Goblin shaman"]);
    // Tag it, then filter by the tag.
    await admin.getByRole("button", { name: "More for Goblin shaman" }).click();
    await admin.getByRole("menuitem", { name: "Add a tag" }).click();
    await admin.getByLabel("New tag").fill("Boss");
    await admin.getByLabel("New tag").press("Enter");
    await expect(admin.locator('[data-asset="Goblin shaman"]')).toContainText("boss");
    await search.fill("");
    await admin.getByLabel("Tag", { exact: true }).selectOption("boss");
    await expect.poll(names).toEqual(["Goblin shaman"]);
    await admin.getByLabel("Tag", { exact: true }).selectOption("");
    // Uploader and status filters: Dave's upload waits for approval.
    const daveUser = ((await hook<{ userId: string }>(dave, "me")) as { userId: string }).userId;
    await admin.getByLabel("Uploaded by").selectOption(daveUser);
    await expect.poll(names).toEqual(["Dave's familiar"]);
    await admin.getByLabel("Uploaded by").selectOption("");
    await admin.getByLabel("Status").selectOption("pending");
    await expect.poll(names).toEqual(["Dave's familiar"]);
    await admin.getByLabel("Status").selectOption("");
    // Rename.
    await admin.getByRole("button", { name: "More for Goblin archer" }).click();
    await admin.getByRole("menuitem", { name: "Rename" }).click();
    await admin.locator('[data-asset="Goblin archer"]').getByLabel("Name").fill("Goblin archer (elite)");
    await admin.locator('[data-asset="Goblin archer"]').getByLabel("Name").press("Enter");
    await expect.poll(names).toContain("Goblin archer (elite)");
    // A card's menu in the scrolling list follows its button as the list scrolls, and closes once the button has
    // scrolled out of the list's view — never left adrift, never closed by the scroll that brought it into view.
    const items = admin.getByRole("list", { name: "Library items" });
    // A short list (held to 180 px here, as on a small screen) scrolled to its foot: the last card's menu.
    await items.evaluate((el) => {
      el.style.maxHeight = "180px";
      el.scrollTop = el.scrollHeight;
    });
    const lastMore = (await items.evaluate((el) => {
      const all = el.querySelectorAll('[aria-label^="More for "]');
      return (all[all.length - 1] as HTMLElement).getAttribute("aria-label");
    })) as string;
    await admin.getByRole("button", { name: lastMore, exact: true }).click();
    const cardMenu = admin.getByRole("menu", { name: lastMore });
    await expect(cardMenu).toBeVisible();
    const menuY = async () => ((await cardMenu.boundingBox()) as { y: number }).y;
    const y0 = await menuY();
    await items.evaluate((el) => el.scrollBy(0, -20));
    await expect.poll(menuY).toBeGreaterThan(y0 + 15);
    await expect(cardMenu).toBeVisible();
    const room = await items.evaluate((el, label) => {
      const b = el.querySelector(`[aria-label="${label}"]`) as HTMLElement;
      return { up: el.scrollTop, gap: el.getBoundingClientRect().bottom - b.getBoundingClientRect().top };
    }, lastMore);
    expect(room.up, "the list scrolls far enough to take the button out of view").toBeGreaterThan(room.gap);
    await items.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(cardMenu).toBeHidden();
    await items.evaluate((el) => {
      el.style.maxHeight = "";
    });

    // Drag onto the board: a token where it lands.
    const board = (await admin.getByTestId("board").boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const drop = { x: board.x + board.width * 0.35, y: board.y + board.height * 0.55 };
    const ground = (await hook<{ x: number; y: number }>(admin, "groundAt", drop.x, drop.y)) as {
      x: number;
      y: number;
    };
    const before = await hook<string[]>(admin, "visibleTokenIds");
    await admin.locator('[data-asset="Owlbear"]').dragTo(admin.getByTestId("board"), {
      targetPosition: { x: drop.x - board.x, y: drop.y - board.y },
    });
    await expect
      .poll(async () => (await hook<string[]>(admin, "visibleTokenIds")).length)
      .toBe(before.length + 1);
    const id = (await hook<string[]>(admin, "visibleTokenIds")).find((x) => !before.includes(x)) as string;
    const t = (await hook<{ name: string; assetId: string; pos: { x: number; y: number } }>(
      admin,
      "token",
      id,
    )) as {
      name: string;
      assetId: string;
      pos: { x: number; y: number };
    };
    expect(t.name).toBe("Owlbear");
    expect(t.assetId).toBeTruthy();
    expect(Math.hypot(t.pos.x - ground.x, t.pos.y - ground.y)).toBeLessThan(1);
    // …and a map starts a new scene with it.
    await admin
      .getByRole("radiogroup", { name: "Library section" })
      .getByRole("radio", { name: "Maps" })
      .click();
    await admin.locator('[data-asset="Crypt map"]').dragTo(admin.getByTestId("board"), {
      targetPosition: { x: board.width * 0.4, y: board.height * 0.5 },
    });
    await expect(admin.getByRole("dialog", { name: "Calibrate the map" })).toBeVisible();
    await admin.keyboard.press("Escape");
    await admin
      .getByRole("radiogroup", { name: "Library section" })
      .getByRole("radio", { name: "Tokens" })
      .click();

    // Soft delete with Undo, and the trash.
    const del = async (n: string) => {
      await admin.getByRole("button", { name: `More for ${n}` }).click();
      await admin.getByRole("menuitem", { name: "Delete" }).click();
    };
    await del("Owlbear");
    await expect.poll(names).not.toContain("Owlbear");
    await admin
      .getByRole("status")
      .filter({ hasText: "Deleted Owlbear" })
      .getByRole("button", { name: "Undo" })
      .click({ timeout: 10_000 });
    await expect.poll(names).toContain("Owlbear");
    await del("Owlbear");
    await expect.poll(names).not.toContain("Owlbear");
    await admin.getByLabel("Show deleted items").check();
    await expect.poll(names).toEqual(["Owlbear"]);
    await admin.getByRole("button", { name: "More for Owlbear" }).click();
    await admin.getByRole("menuitem", { name: "Restore" }).click();
    await expect.poll(names).toEqual([]);
    await admin.getByLabel("Show deleted items").uncheck();
    await expect.poll(names).toContain("Owlbear");
  });
});
