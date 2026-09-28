import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  createScene,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const PHONE = { width: 390, height: 844 };

/** Every control in the page region that's smaller than a finger (AC-RSP-03: 44 × 44 px), by its name. */
async function smallTargets(p: Page, testId: string): Promise<string[]> {
  return p.getByTestId(testId).evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="tab"], [role="radio"], [role="switch"], input[type="checkbox"], select',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || el.closest("[hidden]")) continue;
      // A checkbox counts with the label round it.
      const hit = el.matches('input[type="checkbox"]')
        ? (el.closest("label")?.getBoundingClientRect() ?? r)
        : r;
      if (hit.width < 43.5 || hit.height < 43.5)
        out.push(
          `${el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || `${el.tagName}[${el.getAttribute("role") ?? ""}].${el.className.toString().slice(0, 40)}`} ${Math.round(hit.width)}×${Math.round(hit.height)}`,
        );
    }
    return out;
  });
}

/** Whether anything inside can be scrolled sideways (content cut at the page's edge). */
async function sideways(p: Page, testId: string): Promise<string[]> {
  return p.getByTestId(testId).evaluate((root) => {
    const out: string[] = [];
    for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")] as HTMLElement[]) {
      const cs = getComputedStyle(el);
      const scrolls = cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowX === "hidden";
      // (A tab row scrolls on purpose; an ellipsis is a deliberate cut, not content slid out of sight.)
      if (!scrolls || el.getAttribute("role") === "tablist" || cs.textOverflow === "ellipsis") continue;
      // A box of no size or an invisible one shows nothing to cut (the tab widths' ruler).
      if (el.clientWidth === 0 || cs.visibility === "hidden") continue;
      if (el.scrollLeft !== 0 || el.scrollWidth > el.clientWidth + 1)
        out.push(`${el.tagName}.${el.className.toString().slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`);
    }
    return out;
  });
}

test.describe("P6 — the sheet on a phone (§8.10: a full-screen page)", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });
  test.setTimeout(180_000);

  test("the sheet is a page of the whole width, nothing in it scrolls sideways or cuts off, and every control is finger-sized", async ({
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
      widthFt: 40,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: PHONE });
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    await req(admin, "actor.create", {
      kind: "character",
      ownerUserId: daveId,
      sheet: {
        core: {
          name: "Thorin Emberhand of the Deep Anvil",
          classes: [{ name: "Fighter", level: 5, subclass: "Battle Master" }],
          hp: { max: 52, current: 37, temp: 5 },
          senses: { darkvision: 60 },
          conditions: ["poisoned", "prone"],
          attacks: [{ name: "Warhammer", attack: "1d20 + @str + @prof", damage: "1d8 + @str [bludgeoning]" }],
          spellcasting: {
            ability: "wis",
            slots: [{ level: 1, max: 2, used: 1 }],
            spells: [{ name: "Bless", level: 1 }],
          },
          inventory: [{ name: "Chain mail", qty: 1, weight: 55, equipped: true }],
          features: [
            { name: "Second Wind", text: "Regain HP.", uses: { max: 1, used: 0, recharge: "short" } },
          ],
        },
        custom: [
          { id: "b1", type: "counter", title: "Sanity", value: 8, max: 10, pinToToken: true },
          { id: "b2", type: "checklist", title: "Rites", items: [{ label: "Dawn prayer", done: true }] },
        ],
      },
    });
    await dave.getByRole("button", { name: "Sheet", exact: true }).click();
    const page = dave.getByRole("region", { name: "Character sheet", exact: true });
    await expect(page).toBeVisible();
    await expect(dave.getByTestId("sheet")).toHaveAttribute("aria-label", /Thorin Emberhand/);
    // The whole width, the rail folded into the page's own bar (with Close).
    const box = (await page.boundingBox()) as { x: number; width: number };
    expect(box.x).toBeLessThanOrEqual(16);
    expect(box.x + box.width).toBeGreaterThanOrEqual(PHONE.width - 16);
    await expect(page.getByRole("button", { name: "Close panel" })).toBeVisible();
    // A long name ends in an ellipsis inside the page, not past it.
    const name = dave
      .getByTestId("sheet")
      .getByRole("button", { name: /Thorin Emberhand of the Deep Anvil/ });
    const nb = (await name.boundingBox()) as { x: number; width: number };
    expect(nb.x + nb.width).toBeLessThanOrEqual(box.x + box.width);

    const sections = [
      "Overview",
      "Abilities",
      "Actions",
      "Spells",
      "Inventory",
      "Features",
      "Custom",
      "Notes",
      "Token",
    ];
    const problems: string[] = [];
    for (const s of sections) {
      const sheet = dave.getByTestId("sheet");
      const tab = sheet.getByRole("tab", { name: s, exact: true });
      if (await tab.count()) await tab.click();
      else {
        await sheet.getByRole("button", { name: "More sections" }).click();
        await dave.getByRole("menuitem", { name: s, exact: true }).click();
      }
      await expect(sheet.getByRole("tab", { name: s, exact: true })).toHaveAttribute("aria-selected", "true");
      await dave.waitForTimeout(150);
      for (const x of await sideways(dave, "sheet")) problems.push(`${s}: scrolls sideways — ${x}`);
      for (const x of await smallTargets(dave, "sheet")) problems.push(`${s}: small target — ${x}`);
      await dave.screenshot({ path: `artifacts/screens/p6/phone-${s.toLowerCase()}.png` });
    }
    expect(problems).toEqual([]);

    // Rolling from the page closes it: the dice are seen on the board, and Sheet brings the page back.
    await dave.getByTestId("sheet").getByRole("tab", { name: "Overview", exact: true }).click();
    await dave.getByTestId("sheet").getByRole("button", { name: "Roll Initiative", exact: true }).click();
    await expect(page).toHaveCount(0);
    await expect.poll(async () => (await hook<unknown[]>(dave, "rollFeed")).length).toBeGreaterThan(0);
    await dave.getByRole("button", { name: "Sheet", exact: true }).click();
    await expect(page).toBeVisible();
  });
});
