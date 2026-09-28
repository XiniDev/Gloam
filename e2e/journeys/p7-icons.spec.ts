import { mkdirSync } from "node:fs";
import { hook } from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const SHOTS = "artifacts/screens/p7";
/** Appendix G's icons (the generated source is checked against the spec by `pnpm lint`). */
const APPENDIX_G = 34;

test.describe("P7 — the icon set (DS-03)", () => {
  test.use({ viewport: { width: 1180, height: 900 } });

  test("AC-DS-03: every Appendix G icon is a React component and a cell of the WebGL atlas, drawn at 16, 20 and 24 px", async ({
    admin,
  }) => {
    mkdirSync(SHOTS, { recursive: true });
    await admin.goto("/__icons");
    const rows = admin.getByTestId("icon-row");
    await expect(rows).toHaveCount(APPENDIX_G);
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-icon-id")));
    expect(new Set(ids).size).toBe(APPENDIX_G);
    // Every icon, bare and on its badge, at each size: an SVG glyph with shapes, at exactly the size asked.
    const dom = await admin.getByTestId("icon-sheet").evaluate(() =>
      [...document.querySelectorAll('[data-kind="bare"], [data-kind="badge"]')].map((cell) => {
        const size = Number(cell.getAttribute("data-size"));
        const icon = cell.querySelector("[data-icon]") as HTMLElement;
        const r = icon.getBoundingClientRect();
        const svg = icon.querySelector("svg");
        const shapes =
          svg?.querySelectorAll("path, circle, rect, line, polyline, polygon, ellipse").length ?? 0;
        const g = svg?.getBoundingClientRect();
        return { size, w: r.width, h: r.height, shapes, glyph: g ? Math.round(g.width) : 0 };
      }),
    );
    expect(dom).toHaveLength(APPENDIX_G * 6);
    for (const d of dom) {
      expect(d.w).toBe(d.size);
      expect(d.h).toBe(d.size);
      expect(d.shapes).toBeGreaterThan(0);
      expect(d.glyph).toBeGreaterThan(0);
    }
    // The atlas: a cell for each icon, its badge filled and its glyph drawn (no blank or missing cell).
    await expect(admin.getByTestId("atlas")).toBeVisible();
    const cover = await hook<{ id: string; glyph: number; opaque: number }[]>(admin, "atlasCoverage");
    expect(cover).toHaveLength(APPENDIX_G);
    for (const c of cover) {
      expect(c.opaque, c.id).toBeGreaterThan(0.8);
      expect(c.glyph, c.id).toBeGreaterThan(0.03);
    }
    await expect(admin.locator('[data-kind="atlas"] img')).toHaveCount(APPENDIX_G * 3);
    await admin.screenshot({ path: `${SHOTS}/icons-1x.png`, fullPage: true });
  });

  test.describe("at 2× (a high-density screen)", () => {
    test.use({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
    test("AC-DS-03: the sheet at 2× for the crispness review", async ({ admin }) => {
      await admin.goto("/__icons");
      await expect(admin.getByTestId("icon-row")).toHaveCount(APPENDIX_G);
      await expect(admin.locator('[data-kind="atlas"] img')).toHaveCount(APPENDIX_G * 3);
      await admin.screenshot({ path: `${SHOTS}/icons-2x.png`, fullPage: true });
    });
  });
});
