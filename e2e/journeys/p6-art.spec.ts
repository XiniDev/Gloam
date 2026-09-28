import type { Locator, Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  createScene,
  hook,
  introDone,
  req,
  sharp,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const VIEWPORT = { width: 1280, height: 800 };
const SHOTS = "artifacts/screens/p6";

interface Actor {
  id: string;
  sheet: { core: { name: string; portraitAssetId?: string; tokenAssetId?: string } };
}
interface Token {
  id: string;
  actorId: string;
  assetId: string;
  mode: string;
}
const actorNamed = async (p: Page, name: string) =>
  (await hook<Actor[]>(p, "sheets")).find((a) => a.sheet.core.name === name);

/** A column of the drawing's pixels: how many rows around `y` (± `span`) are drawn on (alpha > 0). */
async function drawnRows(canvas: Locator, x: number, y: number, span: number): Promise<number> {
  return canvas.evaluate(
    (c: HTMLCanvasElement, [x, y, span]) => {
      const d = (c.getContext("2d") as CanvasRenderingContext2D).getImageData(x, y - span, 1, 2 * span).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if ((d[i] as number) > 0) n++;
      return n;
    },
    [x, y, span] as const,
  );
}

/** A canvas's picture: its size, how much is opaque, how much of that is the sticker's white outline. */
async function picture(canvas: Locator) {
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const d = (c.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if ((d[i + 3] as number) < 250) continue;
      opaque++;
      if ((d[i] as number) > 245 && (d[i + 1] as number) > 245 && (d[i + 2] as number) > 245) white++;
    }
    const corner = d[3] as number;
    return { width: c.width, height: c.height, opaque, white, corner };
  });
}

/** The DM approves the one upload waiting in Approvals. */
async function approveUpload(admin: Page) {
  const panel = admin.getByRole("region", { name: "DM panel", exact: true });
  if (!(await panel.isVisible())) await admin.getByRole("button", { name: /^DM panel/ }).click();
  await panel.getByRole("tab", { name: /^Approvals/ }).click();
  const item = panel.locator("[data-pending]");
  await expect(item).toHaveCount(1);
  await item.getByRole("button", { name: "Approve" }).click();
  await expect(item).toHaveCount(0);
}

test.describe("P6 — character art (SHEET-10/11)", () => {
  test.use({ viewport: VIEWPORT });
  test.setTimeout(240_000);

  test("AC-SHEET-10 / AC-SHEET-11: the drawing pad makes a transparent PNG from pressure-sensitive pen strokes with undo and redo, used as portrait and standee; a photo of a drawing on paper becomes a clean sticker with adjustable tolerance and outline — a player's art going on the character once the DM approves it", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Workshop",
      mapKind: "procedural",
      floorStyle: "wood",
      widthFt: 40,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    await boardSettled(dave, sceneId);
    const { actorId } = await req<{ actorId: string }>(dave, "actor.quickCreate", {
      name: "Pip Thistle",
      classLevel: "Bard 1",
      hpMax: 9,
      ac: 13,
    });
    await expect
      .poll(async () => (await hook<Token[]>(admin, "tokens")).some((t) => t.actorId === actorId))
      .toBe(true);
    /** An uploaded picture as the server keeps it: its size, and whether its largest variant has transparency. */
    const stored = async (assetId: string) => {
      const item = (
        await req<{ id: string; width: number; height: number; variants: { name: string }[] }[]>(
          admin,
          "asset.list",
          {},
        )
      ).find((a) => a.id === assetId);
      const variant = item?.variants[0]?.name as string;
      const bytes = await (await admin.request.get(`${gloam.url}/assets/${assetId}/${variant}`)).body();
      const meta = await (
        sharp(bytes) as unknown as { metadata(): Promise<{ hasAlpha: boolean }> }
      ).metadata();
      return { width: item?.width, height: item?.height, hasAlpha: meta.hasAlpha };
    };
    await dave.getByRole("button", { name: "Sheet", exact: true }).click();
    const sheet = dave.getByTestId("sheet");
    await expect(sheet).toHaveAttribute("aria-label", "Pip Thistle's sheet");
    await sheet.getByRole("button", { name: "More sections" }).click();
    await dave.getByRole("menuitem", { name: "Token", exact: true }).click();

    // ── AC-SHEET-10: the drawing pad. ──
    await sheet.getByRole("button", { name: "Draw…" }).click();
    const pad = dave.getByRole("dialog", { name: "Drawing pad" });
    await expect(pad).toBeVisible();
    const canvas = pad.getByTestId("drawing-canvas");
    const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number };
    const at = (cx: number, cy: number) => ({
      x: box.x + (cx / 1024) * box.width,
      y: box.y + (cy / 1024) * box.height,
    });
    // A real pen (Chromium's input, pointerType "pen" with pressure): a light stroke, then a heavy one.
    const cdp = await dave.context().newCDPSession(dave);
    const stroke = async (cy: number, force: number) => {
      const a = at(160, cy);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...a,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "pen",
        force,
      });
      for (let cx = 180; cx <= 860; cx += 20)
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...at(cx, cy),
          button: "left",
          buttons: 1,
          pointerType: "pen",
          force,
        });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...at(860, cy),
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "pen",
        force: 0,
      });
    };
    await stroke(300, 0.15);
    await stroke(700, 0.95);
    const light = await drawnRows(canvas, 512, 300, 40);
    const heavy = await drawnRows(canvas, 512, 700, 40);
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light * 2);
    // Transparent where nothing is drawn.
    expect(await drawnRows(canvas, 40, 512, 500)).toBe(0);
    await dave.screenshot({ path: `${SHOTS}/drawing-pad.png` });
    // Undo takes the last stroke away, redo brings it back (the keys, and the buttons).
    await dave.keyboard.press("Control+z");
    await expect.poll(() => drawnRows(canvas, 512, 700, 40)).toBe(0);
    expect(await drawnRows(canvas, 512, 300, 40)).toBe(light);
    await dave.keyboard.press("Control+Shift+z");
    await expect.poll(() => drawnRows(canvas, 512, 700, 40)).toBe(heavy);
    await pad.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => drawnRows(canvas, 512, 700, 40)).toBe(0);
    await pad.getByRole("button", { name: "Redo" }).click();
    await expect.poll(() => drawnRows(canvas, 512, 700, 40)).toBe(heavy);
    // The pad's Ctrl+Z is the pad's: the table's undo (which would take back making the character) never saw it.
    expect(await actorNamed(dave, "Pip Thistle")).toBeTruthy();
    await expect(dave.getByText(/^Undone:/)).toHaveCount(0);

    // Used as the portrait: a player's drawing waits for the DM, then goes on the character by itself.
    await pad.getByRole("button", { name: "Use as portrait" }).click();
    await expect(pad).toHaveCount(0);
    await expect(dave.getByText("Sent to the DM")).toBeVisible();
    await approveUpload(admin);
    await expect
      .poll(async () => (await actorNamed(dave, "Pip Thistle"))?.sheet.core.portraitAssetId)
      .toMatch(/.+/);
    await expect(dave.getByText("The DM approved your portrait")).toBeVisible();
    const portrait = (await actorNamed(dave, "Pip Thistle"))?.sheet.core.portraitAssetId as string;
    // Stored as an image with its transparency, 1024 px square.
    expect(await stored(portrait)).toEqual({ width: 1024, height: 1024, hasAlpha: true });
    // And as a standee: the token art, drawn standing up.
    await sheet.getByRole("button", { name: "Draw…" }).click();
    await pad.getByRole("button", { name: "Use as standee" }).click();
    await approveUpload(admin);
    await expect
      .poll(async () => {
        const tokenArt = (await actorNamed(dave, "Pip Thistle"))?.sheet.core.tokenAssetId;
        const t = (await hook<Token[]>(admin, "tokens")).find((x) => x.actorId === actorId);
        return Boolean(tokenArt) && t?.assetId === tokenArt && t?.mode === "standee";
      })
      .toBe(true);

    // ── AC-SHEET-11: a photo of a drawing on paper becomes a sticker. ──
    const photo = await (
      sharp(
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700">
          <defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#f6f3ec"/><stop offset="1" stop-color="#e2dccf"/></linearGradient></defs>
          <rect width="900" height="700" fill="url(#p)"/>
          <circle cx="450" cy="250" r="80" fill="none" stroke="#1d1a17" stroke-width="10"/>
          <circle cx="420" cy="235" r="9" fill="#1d1a17"/><circle cx="480" cy="235" r="9" fill="#1d1a17"/>
          <path d="M450 330 V540 M450 400 L350 460 M450 400 L550 460 M450 540 L380 640 M450 540 L520 640"
            stroke="#1d1a17" stroke-width="12" fill="none" stroke-linecap="round"/>
          <circle cx="110" cy="90" r="2" fill="#4a4540"/><circle cx="820" cy="630" r="1.5" fill="#55504a"/>
          <ellipse cx="150" cy="600" rx="45" ry="28" fill="#cdc7bc"/>
        </svg>`),
      ) as unknown as { png(): { toBuffer(): Promise<Buffer> } }
    )
      .png()
      .toBuffer();
    await sheet.getByRole("button", { name: "From a photo of paper…" }).click();
    const cut = dave.getByRole("dialog", { name: "From a photo of paper" });
    await cut
      .locator('input[type="file"]')
      .setInputFiles({ name: "drawing.png", mimeType: "image/png", buffer: photo });
    const preview = cut.getByTestId("cutout-preview");
    await expect(preview).toBeVisible();
    // Painted: no longer a blank canvas's 300 × 150.
    await expect
      .poll(
        async () => {
          const p = await picture(preview);
          return p.width !== 300 || p.height !== 150;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    // The paper is gone and the stray specks with it: the sticker is trimmed to the figure (≈ 230 × 480 px of the
    // 900 × 700 photo, plus its outline and shadow; a speck kept would have stretched it across the photo), clear at its corners, with a white outline round the ink.
    await expect.poll(async () => (await picture(preview)).width, { timeout: 15_000 }).toBeLessThan(320);
    const sticker = await picture(preview);
    expect(sticker.height).toBeLessThan(560);
    expect(sticker.corner).toBe(0);
    expect(sticker.white).toBeGreaterThan(2000);
    await dave.screenshot({ path: `${SHOTS}/paper-cutout.png` });
    // Outline: none at 0.
    const outline = cut.getByRole("slider", { name: "Outline" });
    await outline.focus();
    await outline.press("Home");
    await expect
      .poll(async () => (await picture(preview)).white, { timeout: 10_000 })
      .toBeLessThan(sticker.white / 10);
    await outline.press("End");
    await expect
      .poll(async () => (await picture(preview)).white, { timeout: 10_000 })
      .toBeGreaterThan(sticker.white);
    // Tolerance: too tight, and the pale pencil smudge on the paper (bottom left) stays with the drawing.
    const tolerance = cut.getByRole("slider", { name: "Paper tolerance" });
    await tolerance.focus();
    await tolerance.press("Home");
    await expect.poll(async () => (await picture(preview)).width, { timeout: 10_000 }).toBeGreaterThan(420);
    for (let i = 0; i < 14; i++) await tolerance.press("ArrowRight");
    await expect.poll(async () => (await picture(preview)).width, { timeout: 10_000 }).toBeLessThan(360);
    await cut.getByRole("button", { name: "Use as portrait" }).click();
    // (Saving renders the sticker at 2048 px and uploads it: seconds under software GL with other journeys running.)
    await expect(cut).toHaveCount(0, { timeout: 30_000 });
    await approveUpload(admin);
    await expect
      .poll(async () => (await actorNamed(dave, "Pip Thistle"))?.sheet.core.portraitAssetId)
      .not.toBe(portrait);
    const stickerId = (await actorNamed(dave, "Pip Thistle"))?.sheet.core.portraitAssetId as string;
    expect((await stored(stickerId)).hasAlpha).toBe(true);
  });
});
