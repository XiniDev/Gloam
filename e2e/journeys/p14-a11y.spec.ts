import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  camera,
  createScene,
  dmSection,
  hook,
  introDone,
  openPanel,
  req,
} from "../fixtures/board.ts";
import { expect, newPlayerContext, test } from "../fixtures/test.ts";

type Tok = { id: string; name: string; pos: { x: number; y: number } };

/** axe-core's serious and critical findings on what's on screen now (the board's canvas aside: it isn't DOM). */
async function axe(p: Page, where: string): Promise<string[]> {
  const r = await new AxeBuilder({ page: p }).exclude("canvas").analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${where}: ${v.id} — ${v.help} (${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | ")})`,
    );
}

/** The element keyboard focus is on, and whether it shows a focus ring (an outline or a ring-like box shadow). */
async function focusRing(p: Page): Promise<{ what: string; ring: boolean }> {
  return p.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { what: "nothing", ring: false };
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0;
    const shadow = s.boxShadow !== "none";
    return {
      what: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30),
      ring: outline || shadow,
    };
  });
}

/**
 * Accessibility (SPEC §8.22, §28; AC-A11Y-01…05): axe-core finds nothing serious on the main screens and keyboard focus
 * always shows; reduced motion stops the camera's flights, the shakes and the dice's tumble; the colour-blind palette
 * swaps the colours and patterns; the interface size runs 90–130 % without breaking; and a sound's picture is there
 * with the sound off.
 */
test.describe("P14 — accessibility (A11Y)", () => {
  test("AC-A11Y-01: axe-core finds no serious violations on the main screens; keyboard focus shows a ring", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(300_000);
    const problems: string[] = [];
    // The door, as a new player sees it.
    const { page: guest } = await newPlayerContext(browser, gloam.url, guardLog);
    await guest.goto(`${gloam.url}/join`);
    await expect(guest.getByRole("heading").first()).toBeVisible();
    problems.push(...(await axe(guest, "join")));

    // The console.
    problems.push(...(await axe(admin, "admin: first run")));
    await admin.getByRole("button", { name: "Start with the demo" }).click();
    await expect(admin.getByText("The Lantern Crypt is ready")).toBeVisible({ timeout: 30_000 });
    for (const name of [
      "People",
      "Campaigns",
      "Saves",
      "Assets",
      "Content",
      "API & MCP",
      "Settings",
      "Security log",
      "About",
    ]) {
      await admin
        .getByRole("navigation", { name: "Admin sections" })
        .getByRole("link", { name, exact: true })
        .click();
      await expect(admin.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await admin.waitForLoadState("networkidle");
      problems.push(...(await axe(admin, `admin: ${name}`)));
    }

    // The table, as the DM: idle, each panel, the dice tray, a dialog.
    await adminAtTable(admin);
    await introDone(admin);
    problems.push(...(await axe(admin, "table")));
    for (const panel of ["Sheet", "Party", "Journal"] as const) {
      await openPanel(admin, panel);
      problems.push(...(await axe(admin, `table: ${panel}`)));
    }
    for (const section of ["Scenes", "Tokens & Units", "Vision & Fog", "House rules"]) {
      await dmSection(admin, section);
      problems.push(...(await axe(admin, `DM panel: ${section}`)));
    }
    await admin.keyboard.press("Escape");
    await admin.getByTestId("dice-button").click();
    problems.push(...(await axe(admin, "dice tray")));
    await admin.keyboard.press("Escape");
    expect(problems).toEqual([]);

    // Keyboard: Tab from the page's start reaches the controls, each showing where focus is.
    await admin.mouse.click(5, 450);
    const rings: string[] = [];
    for (let i = 0; i < 8; i++) {
      await admin.keyboard.press("Tab");
      const f = await focusRing(admin);
      if (f.what !== "nothing" && !f.ring) rings.push(f.what);
    }
    expect(rings, "focused without a visible ring").toEqual([]);
  });

  test("AC-A11Y-02 / AC-A11Y-03 / AC-A11Y-04 / AC-A11Y-05: reduced motion, the colour-blind palette, 90–130 % and sound's pictures", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(300_000);
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
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Brute",
      pos: { x: 12.5, y: 17.5 },
      disposition: "hostile",
      stats: { hp: 20, hpMax: 20, ac: 12 },
    });
    await expect.poll(() => hook(admin, "token", tokenId)).not.toBeNull();
    const bodyX = async () => (await hook<{ bodyX: number }>(admin, "tokenState", tokenId)).bodyX;
    /** The largest sideways offset of its body over the next `ms`. */
    const sway = async (ms: number) => {
      let most = 0;
      const until = Date.now() + ms;
      while (Date.now() < until) {
        most = Math.max(most, Math.abs(await bodyX()));
        await admin.waitForTimeout(25);
      }
      return most;
    };

    // ── AC-A11Y-02: with full motion a hit shakes it; reduced, it doesn't — nor do the camera and the dice move ──
    await hook(admin, "settings", { motion: "full" });
    await req(admin, "hp.apply", { targets: [tokenId], amount: 3, kind: "damage" });
    expect(await sway(500), "a hit shakes it (full motion)").toBeGreaterThan(0.02);
    await hook(admin, "settings", { motion: "reduced" });
    await req(admin, "hp.apply", { targets: [tokenId], amount: 3, kind: "damage" });
    expect(await sway(500), "no shake with reduced motion").toBe(0);
    // The camera cuts: brought to the creature, no tween starts and it's there at once.
    const tweensBefore = (await hook<{ tweenStarts: unknown[] }>(admin, "cameraLog")).tweenStarts.length;
    await camera(admin, { target: [50, 0, 35], ms: 0 });
    await admin.keyboard.press("Control+k");
    await admin.getByTestId("jump-to").getByRole("combobox").fill("Brute");
    await admin.keyboard.press("Enter");
    await expect.poll(async () => (await camera(admin)).target[0], { timeout: 2000 }).toBeCloseTo(12.5, 0);
    expect((await hook<{ tweenStarts: unknown[] }>(admin, "cameraLog")).tweenStarts.length).toBe(
      tweensBefore,
    );
    // The dice don't tumble: they're at rest the moment they appear.
    await req(admin, "dice.roll", { formula: "2d20", visibility: "public" });
    await expect
      .poll(
        async () =>
          (await hook<{ throws: { settledAt: number | null }[] }>(admin, "diceStage")).throws.some(
            (t) => t.settledAt !== null,
          ),
        { timeout: 1500, intervals: [50] },
      )
      .toBe(true);
    await hook(admin, "settings", { motion: "system" });

    // ── AC-A11Y-03: the colour-blind palette swaps the disposition ring and HP colours, and stripes low HP ──
    const ring = async () => (await hook<{ ring: string }>(admin, "tokenState", tokenId)).ring;
    const normal = await ring();
    await hook(admin, "settings", { colorBlind: true });
    await expect.poll(ring).toBe("#d55e00");
    expect(normal).not.toBe("#d55e00");
    const bar = async (frac: number) =>
      hook<{ r: number; g: number; b: number }[]>(admin, "renderHpBar", { frac, temp: 0, ghost: frac }, 200);
    const low = await bar(0.2);
    // Striped: its filled part alternates between two tones.
    const filled = low.slice(2, 36);
    const tones = new Set(
      filled.map((p) => `${Math.round(p.r / 24)}|${Math.round(p.g / 24)}|${Math.round(p.b / 24)}`),
    );
    expect(tones.size, "low HP striped").toBeGreaterThan(1);
    await hook(admin, "settings", { colorBlind: false });

    // ── AC-A11Y-04: the interface at 90 % and 130 %: nothing runs off the screen or over the rest ──
    for (const uiScale of [0.9, 1.3]) {
      await hook(admin, "settings", { uiScale });
      await admin.waitForTimeout(400);
      const bad = await admin.evaluate(() => {
        const d = document.documentElement;
        const out: string[] = [];
        if (d.scrollWidth > d.clientWidth + 1)
          out.push(`scrolls sideways by ${d.scrollWidth - d.clientWidth}`);
        const pieces = [
          "header",
          "[aria-label='Board tools']",
          "[data-hud='dock'] nav",
          "[data-testid='action-bar']",
        ]
          .map((s) => document.querySelector<HTMLElement>(s))
          .filter((e): e is HTMLElement => !!e && e.getBoundingClientRect().width > 0);
        const boxes = pieces.map((e) => e.getBoundingClientRect());
        for (const [i, a] of boxes.entries()) {
          if (a.right > window.innerWidth + 1 || a.bottom > window.innerHeight + 1)
            out.push(`#${i} off the screen`);
          for (const [j, b] of boxes.entries())
            if (
              j > i &&
              a.left < b.right - 1 &&
              a.right > b.left + 1 &&
              a.top < b.bottom - 1 &&
              a.bottom > b.top + 1
            )
              out.push(`#${i} over #${j}`);
        }
        return out;
      });
      expect(bad, `at ${uiScale * 100} %`).toEqual([]);
      await admin.screenshot({ path: `artifacts/screens/p14/ui-scale-${uiScale * 100}.png` });
    }
    await hook(admin, "settings", { uiScale: 1 });

    // ── AC-A11Y-05: with the sound off, a locked door says so on screen (a player at it: the DM opens any door) ──
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave");
    const daveId = (await hook<{ userId: string }>(dave, "me")).userId;
    await req(admin, "token.create", {
      sceneId,
      name: "Dave's scout",
      pos: { x: 27.5, y: 15 },
      ownerIds: [daveId],
      disposition: "party",
    });
    const wallId = (
      await req<{ wallIds: string[] }>(admin, "wall.create", {
        sceneId,
        walls: [{ a: { x: 30, y: 10 }, b: { x: 30, y: 20 }, kind: "door" }],
      })
    ).wallIds[0] as string;
    await req(admin, "door.toggle", { wallId, action: "lock" });
    await boardSettled(dave, sceneId);
    await hook(dave, "settings", { muted: true });
    await expect
      .poll(async () => (await hook<{ wallId: string }[]>(dave, "doorHandles")).length)
      .toBeGreaterThan(0);
    const handle = await hook<{ sx: number; sy: number }>(dave, "project", 30, 15, 0.9);
    await dave.mouse.click(handle.sx, handle.sy);
    await expect(dave.locator("[data-toast]").filter({ hasText: "The door is locked" })).toBeVisible();
  });
});
