import { type Browser, type CDPSession, devices, type Page, webkit } from "@playwright/test";
import { withAutoplayPolicy } from "../fixtures/autoplay.ts";
import { adminAtTable, boardSettled, camera, createScene, hook, introDone, req } from "../fixtures/board.ts";
import { expect, guard, knockAsNew, test } from "../fixtures/test.ts";

type Tok = { id: string; pos: { x: number; y: number } };

async function screenOf(p: Page, id: string) {
  const t = (await hook<Tok | null>(p, "token", id)) as Tok;
  const s = await hook<{ sx: number; sy: number }>(p, "project", t.pos.x, t.pos.y, 0.15);
  return { x: s.sx, y: s.sy };
}

/**
 * Phones (SPEC §8.21; AC-RSP-04), in Playwright's WebKit with an iPhone's profile and Chromium with a Pixel's: sound
 * unlocks on the first touch (a phone's autoplay policy emulated — headless engines don't apply one); the table is exactly as tall as the dynamic viewport (100dvh — Safari's toolbars come
 * and go); dragging on the board never scrolls or bounces the page; and a drag that leaves the board (the finger
 * running over the HUD) keeps going and lands. (A manual checklist for real phones is in docs/HOSTING.md.)
 */
test.describe("P14 — phones in WebKit and Chromium (RSP)", () => {
  test("AC-RSP-04: iPhone (WebKit) and Pixel (Chromium): audio unlocks on the first gesture, 100dvh, no rubber-band scroll, drags keep their pointer", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(420_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Courtyard",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 60,
    });
    await boardSettled(admin, sceneId);
    // WebKit here, or a remote one (GLOAM_WEBKIT_WS: `playwright run-server` on Linux, e.g. Playwright's Docker image —
    // its WebKit has Web Audio), reaching this machine's server through the client (exposeNetwork).
    const remote = process.env.GLOAM_WEBKIT_WS;
    const wk = remote ? await webkit.connect(remote, { exposeNetwork: "<loopback>" }) : await webkit.launch();
    try {
      for (const [label, b, device] of [
        ["Pixel", browser, devices["Pixel 7"]],
        ["iPhone", wk, devices["iPhone 13"]],
      ] as const) {
        const context = await (b as Browser).newContext({ ...device, baseURL: gloam.url });
        guardLog.contexts.push(context);
        const page = await context.newPage();
        guard(page, gloam.url, guardLog);
        await knockAsNew(page, gloam.url, code, label);
        await admin
          .getByRole("alert")
          .filter({ hasText: `${label} is knocking` })
          .getByRole("button", { name: "Admit" })
          .click();
        await expect(page).toHaveURL(/\/table$/);
        await introDone(page);
        const userId = (await hook<{ userId: string }>(page, "me")).userId;
        const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
          sceneId,
          name: `${label}'s scout`,
          pos: { x: 17.5, y: 27.5 },
          ownerIds: [userId],
          disposition: "party",
        });
        await expect.poll(() => hook(page, "token", tokenId)).not.toBeNull();

        // ── Sound: locked until the first touch. (Typing the code was a gesture, and browsers remember one for the
        // site: the check is on the table opened afresh in a new browser session, signed in, never touched.)
        const fresh = await (b as Browser).newContext({
          ...device,
          baseURL: gloam.url,
          storageState: await context.storageState(),
        });
        guardLog.contexts.push(fresh);
        const cold = await fresh.newPage();
        guard(cold, gloam.url, guardLog);
        // (Headless browsers let every AudioContext run; the phone's policy — held until a real touch — stands in.)
        await withAutoplayPolicy(cold);
        await cold.goto(`${gloam.url}/table`);
        await introDone(cold);
        const webAudio = await cold.evaluate(
          () => "AudioContext" in window || "webkitAudioContext" in window,
        );
        const cvp = cold.viewportSize() as { width: number; height: number };
        if (webAudio) {
          expect(await hook<string>(cold, "audioStatus"), `${label}: before any gesture`).not.toBe("running");
          await cold.touchscreen.tap(Math.round(cvp.width / 2), Math.round(cvp.height * 0.45));
          await expect
            .poll(() => hook<string>(cold, "audioStatus"), { message: `${label}: after the first tap` })
            .toBe("running");
        } else {
          // Playwright's WebKit build for Windows has no Web Audio at all (AudioContext is undefined): the page runs
          // silent and says so, without an error (the guard fails the test on any). On a WebKit with Web Audio —
          // macOS or Linux, or GLOAM_WEBKIT_WS pointing at one — the unlock is checked as for the Pixel.
          await cold.touchscreen.tap(Math.round(cvp.width / 2), Math.round(cvp.height * 0.45));
          expect(await hook<string>(cold, "audioStatus"), `${label}: no Web Audio here`).toBe("unavailable");
          test.info().annotations.push({
            type: "webkit",
            description: `${label}: this WebKit build has no Web Audio`,
          });
        }
        await fresh.close();
        const vp = page.viewportSize() as { width: number; height: number };

        // ── The table is the dynamic viewport's height (100dvh) ──
        const layout = await page.evaluate(() => {
          const root = document.querySelector('[class*="h-[100dvh]"]') as HTMLElement | null;
          const rules: string[] = [];
          for (const sheet of Array.from(document.styleSheets))
            for (const r of Array.from(sheet.cssRules ?? []))
              if (/100dvh/.test(r.cssText)) rules.push(r.cssText.slice(0, 80));
          return {
            height: root?.getBoundingClientRect().height ?? 0,
            inner: window.innerHeight,
            dvhRules: rules.length,
            classes: root?.className ?? "",
          };
        });
        expect(layout.dvhRules, `${label}: a 100dvh rule`).toBeGreaterThan(0);
        expect(layout.classes, `${label}: the table sized by it`).toContain("h-[100dvh]");
        expect(
          Math.abs(layout.height - layout.inner),
          `${label}: table height = viewport height`,
        ).toBeLessThan(1);

        // ── No rubber-band: the page never scrolls, whatever is dragged on the board ──
        // (Declared in the page's CSS — computed where the engine knows the property; Playwright's Windows WebKit
        // doesn't report it — and then the page not moving at all, below, is what counts.)
        const styles = await page.evaluate(() => {
          const declared = (sel: string) => {
            for (const sheet of Array.from(document.styleSheets))
              for (const r of Array.from(sheet.cssRules ?? [])) {
                const walk = (rule: CSSRule): boolean => {
                  const st = rule as CSSStyleRule;
                  if (
                    st.selectorText?.split(",").some((x) => x.trim() === sel) &&
                    /overscroll-behavior:\s*none/.test(st.cssText)
                  )
                    return true;
                  return Array.from((rule as CSSGroupingRule).cssRules ?? []).some(walk);
                };
                if (walk(r)) return "none";
              }
            return "unset";
          };
          const computed = (el: Element) => getComputedStyle(el).getPropertyValue("overscroll-behavior-y");
          return {
            html: computed(document.documentElement) || declared("html"),
            body: computed(document.body) || declared("body"),
            // The board's WebGL canvas (three marks it), and every box round it up to the board: the browser takes a
            // gesture only if none of them says touch-action: none.
            canvas: (() => {
              let el: Element | null = document.querySelector("[data-testid=board] canvas[data-engine]");
              const seen: string[] = [];
              while (el) {
                seen.push(getComputedStyle(el).touchAction);
                if ((el as HTMLElement).dataset?.testid === "board") break;
                el = el.parentElement;
              }
              return seen.includes("none") ? "none" : (seen[0] ?? "missing");
            })(),
          };
        });
        const knows = await page.evaluate(() => CSS.supports("overscroll-behavior", "none"));
        if (knows) {
          expect(styles.html, `${label}: html overscroll`).toBe("none");
          expect(styles.body, `${label}: body overscroll`).toBe("none");
        } else
          test.info().annotations.push({
            type: "webkit",
            description: `${label}: this engine doesn't know overscroll-behavior — the board's touch-action and the page not moving are the checks`,
          });
        expect(styles.canvas, `${label}: the board takes every touch`).toBe("none");
        await camera(page, { pitchDeg: 80, frame: { minX: 0, minY: 10, maxX: 40, maxY: 45 } });
        await page.waitForTimeout(400);
        const cdp: CDPSession | null = label === "Pixel" ? await context.newCDPSession(page) : null;
        const touch = (type: "touchStart" | "touchMove" | "touchEnd", pts: { x: number; y: number }[]) =>
          cdp?.send("Input.dispatchTouchEvent", {
            type,
            touchPoints: pts.map((q, i) => ({ x: Math.round(q.x), y: Math.round(q.y), id: i })),
          });
        const empty = { x: vp.width * 0.5, y: vp.height * 0.25 };
        if (cdp) {
          await touch("touchStart", [empty]);
          for (let i = 1; i <= 10; i++) await touch("touchMove", [{ x: empty.x, y: empty.y + i * 30 }]);
          await touch("touchEnd", []);
        } else {
          // (Mobile WebKit takes no wheel and Playwright gives it no touch moves — only taps: a pointer drag down the
          // board. A mouse's pointer, unlike a finger's, isn't captured by the browser: the board has to keep it.)
          await page.mouse.move(empty.x, empty.y);
          await page.mouse.down();
          for (let i = 1; i <= 10; i++) await page.mouse.move(empty.x, empty.y + i * 30);
          await page.mouse.up();
        }
        // And the document itself has nowhere to go: asked to scroll, it stays.
        await page.evaluate(() => window.scrollBy(0, 600));
        await page.waitForTimeout(300);
        const scrolled = await page.evaluate(() => ({
          y: window.scrollY,
          top: document.scrollingElement?.scrollTop ?? 0,
          vv: window.visualViewport?.offsetTop ?? 0,
        }));
        expect(scrolled, `${label}: the page stayed put`).toEqual({ y: 0, top: 0, vv: 0 });
        // (That swipe panned the view: framed again, the token and the aimed point are both on the board.)
        await camera(page, { pitchDeg: 80, frame: { minX: 0, minY: 10, maxX: 40, maxY: 45 } });
        await page.waitForTimeout(400);

        // ── A drag that runs off the board (over the HUD at the bottom) keeps going and lands ──
        const from = await screenOf(page, tokenId);
        const to = await hook<{ sx: number; sy: number }>(page, "project", 27.5, 37.5, 0.15);
        for (const [what, q] of [
          ["the token", from],
          ["the aimed point", { x: to.sx, y: to.sy }],
        ] as const)
          expect(
            q.y > 60 && q.y < vp.height - 100 && q.x > 0 && q.x < vp.width,
            `${label}: ${what} on the board (${Math.round(q.x)}, ${Math.round(q.y)})`,
          ).toBe(true);
        const offBoard = { x: from.x, y: vp.height - 8 };
        const path = [from, offBoard, { x: to.sx, y: to.sy }];
        // Which element each move went to while the finger was over the HUD (not the board): the board's, captured.
        await page.evaluate(() => {
          const w = window as unknown as { overHud: string[] };
          w.overHud = [];
          const on = (e: PointerEvent) => {
            const under = document.elementFromPoint(e.clientX, e.clientY);
            if (under && under.tagName !== "CANVAS") w.overHud.push((e.target as Element).tagName);
          };
          window.addEventListener("pointermove", on, true);
          window.addEventListener("pointerup", () => window.removeEventListener("pointermove", on, true), {
            once: true,
            capture: true,
          });
        });
        if (cdp) {
          await touch("touchStart", [from]);
          for (let k = 1; k < path.length; k++)
            for (let i = 1; i <= 8; i++) {
              const a = path[k - 1] as { x: number; y: number };
              const c = path[k] as { x: number; y: number };
              await touch("touchMove", [{ x: a.x + ((c.x - a.x) * i) / 8, y: a.y + ((c.y - a.y) * i) / 8 }]);
              await page.waitForTimeout(25);
            }
          await touch("touchEnd", []);
        } else {
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          for (let k = 1; k < path.length; k++)
            for (let i = 1; i <= 8; i++) {
              const a = path[k - 1] as { x: number; y: number };
              const c = path[k] as { x: number; y: number };
              await page.mouse.move(a.x + ((c.x - a.x) * i) / 8, a.y + ((c.y - a.y) * i) / 8);
              await page.waitForTimeout(25);
            }
          await page.mouse.up();
        }
        const overHud = await page.evaluate(() => (window as unknown as { overHud: string[] }).overHud);
        expect(overHud.length, `${label}: the drag crossed the HUD`).toBeGreaterThan(0);
        expect(new Set(overHud), `${label}: the board kept the pointer over the HUD`).toEqual(
          new Set(["CANVAS"]),
        );
        // (Where the finger lifted, out of combat: within half a foot of the aimed point.)
        await expect
          .poll(
            async () => {
              const p = (await hook<Tok>(admin, "token", tokenId)).pos;
              return Math.hypot(p.x - 27.5, p.y - 37.5) < 0.5;
            },
            { message: `${label}: the drag landed`, timeout: 15_000 },
          )
          .toBe(true);
      }
    } finally {
      await wk.close();
    }
  });
});
