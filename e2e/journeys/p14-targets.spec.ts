import type { Page } from "@playwright/test";
import {
  adminAtTable,
  boardSettled,
  createScene,
  dmSection,
  hook,
  introDone,
  openPanel,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const PHONE = { width: 390, height: 844 };

/**
 * Everything on screen a finger presses that's under 44 × 44 px, and every piece of text under 12 px — named, so a
 * failure says what (AC-RSP-03). The board's canvas isn't DOM; what's drawn in it has its own rules (§24.4).
 */
async function audit(p: Page, where: string): Promise<string[]> {
  return p.evaluate((where) => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
      // On screen, and not under a dialog's scrim or a sheet (what's uppermost at its middle is it, or inside it).
      const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
      const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
      if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth)
        return false;
      const top = document.elementFromPoint(x, y);
      return !!top && (top === el || el.contains(top) || top.contains(el));
    };
    const name = (el: Element) =>
      (el.getAttribute("aria-label") || el.textContent || el.tagName)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
    for (const el of document.querySelectorAll(
      "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=radio], [role=menuitem], [role=checkbox], summary",
    )) {
      if (!visible(el) || (el as HTMLButtonElement).disabled) continue;
      // A native checkbox or radio stands in a label that is the target.
      const target =
        (el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio"
          ? (el.closest("label") ?? el)
          : el;
      const r = target.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5)
        out.push(`${where}: target "${name(el)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !(n.textContent ?? "").trim()) continue;
      seen.add(el);
      if (el.closest("[aria-hidden=true], canvas, svg, .sr-only") || !visible(el)) continue;
      const px = Number.parseFloat(getComputedStyle(el).fontSize);
      if (px < 11.95) out.push(`${where}: text "${name(el)}" at ${px}px`);
    }
    return out;
  }, where);
}

/**
 * A phone's HUD, finger-sized and legible (SPEC §28, §27.3; AC-RSP-03): the table idle and with a creature chosen, the
 * tools, the tab bar and every sheet it opens — dice, rolls, the character sheet, Party, Journal and the DM panel's
 * sections — each audited for targets under 44 × 44 px and text under 12 px.
 */
test.describe("P14 — touch targets and text (RSP)", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("AC-RSP-03: every control at least 44 × 44 px and all HUD text at least 12 px on a phone", async ({
    admin,
  }) => {
    test.setTimeout(300_000);
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 60,
    });
    await boardSettled(admin, sceneId);
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Scout",
      pos: { x: 17.5, y: 27.5 },
    });
    await expect.poll(() => hook(admin, "token", tokenId)).not.toBeNull();
    const problems: string[] = [];
    const check = async (where: string) => {
      await admin.waitForTimeout(350);
      problems.push(...(await audit(admin, where)));
    };

    await check("table");
    // A tap on it chooses it.
    const t = await hook<{ pos: { x: number; y: number } }>(admin, "token", tokenId);
    const at = await hook<{ sx: number; sy: number }>(admin, "project", t.pos.x, t.pos.y, 0.15);
    await admin.touchscreen.tap(at.sx, at.sy);
    await expect
      .poll(async () => (await hook<{ selection: string[] }>(admin, "ui")).selection)
      .toEqual([tokenId]);
    await check("a creature chosen");
    await admin.getByRole("button", { name: /^Tools: / }).click();
    await check("the tools");
    await admin.getByRole("button", { name: "Close tools" }).click();

    await admin.getByTestId("dice-button").click();
    await expect(admin.getByTestId("dice-tray")).toBeVisible();
    await check("the dice tray");
    await admin.getByRole("button", { name: "Close the tray" }).click();

    await admin.getByTestId("rolls-tab").click();
    await expect(admin.getByTestId("roll-feed")).toBeVisible();
    await check("the rolls");
    await admin.getByRole("button", { name: "Close the rolls" }).click();

    for (const panel of ["Sheet", "Party", "Journal"] as const) {
      await openPanel(admin, panel);
      await expect(admin.getByTestId("dock-sheet")).toBeVisible();
      await check(panel);
      await admin.getByRole("button", { name: "Close panel" }).click();
    }
    for (const section of [
      "Scenes",
      "Tokens & Units",
      "Vision & Fog",
      "Walls & Zones",
      "Lights",
      "House rules",
    ]) {
      await dmSection(admin, section);
      await check(`DM panel: ${section}`);
    }
    await admin.getByRole("button", { name: "Close panel" }).click();
    await admin.getByRole("button", { name: "Settings" }).click();
    await check("settings");
    expect(problems).toEqual([]);
  });
});
