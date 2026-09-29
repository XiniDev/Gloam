import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  createScene,
  dmSection,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const SHOTS = "artifacts/screens/p11";
const sounds = (p: Page, name: string) =>
  p.evaluate((n) => (window.__gloam?.sounds ?? []).filter((s) => s.name === n && s.played).length, name);

test.describe("P11 — table flavour (FUN)", () => {
  test("AC-FUN-01 / AC-FUN-03 / AC-FUN-04 / AC-FUN-05: emotes and phrases pop over the sender's token (or portrait where it isn't seen) for 2.5 s with a sound; the raised hand on portrait and tracker, the DM told once; handouts and secret notes to exactly their recipients, unfurling and kept; the log with its automatic entries, a player's recap, search and a Markdown export", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(480_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave");
    const erin = await admitPlayer(admin, browser, gloam, guardLog, code, "Erin");
    const users = async (p: Page) => (await hook<{ userId: string }>(p, "me")).userId;
    const [daveId, erinId] = [await users(dave), await users(erin)];
    // A dark hall split by a wall: Dave's fighter on one side, Erin's rogue on the other (she can't see him).
    const sceneId = await createScene(admin, {
      name: "Dark hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
      fogMode: "dynamic",
      ambient: "dark",
    });
    await req(admin, "wall.create", { sceneId, walls: [{ a: { x: 30, y: 0 }, b: { x: 30, y: 40 } }] });
    const { tokenId: fighter } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Dave's Fighter",
      pos: { x: 15, y: 20 },
      disposition: "party",
      ownerIds: [daveId],
      stats: { hp: 20, hpMax: 20, ac: 16, senses: { darkvision: 60 } },
    });
    await req(admin, "token.create", {
      sceneId,
      name: "Erin's Rogue",
      pos: { x: 45, y: 20 },
      disposition: "party",
      ownerIds: [erinId],
      stats: { hp: 14, hpMax: 14, ac: 14, senses: { darkvision: 60 } },
    });
    for (const p of [admin, dave, erin]) await boardSettled(p, sceneId);

    // ── Emotes (AC-FUN-01) ─────────────────────────────────────────────────────────────────────────────
    await dave.mouse.move(700, 450);
    await dave.keyboard.press("e");
    const wheel = dave.getByTestId("emote-wheel");
    await expect(wheel).toBeVisible();
    await expect(wheel.getByRole("button")).toHaveCount(12 + 8 + 1 + 1); // emotes, phrases, "Your own phrase", hand
    await dave.screenshot({ path: `${SHOTS}/emote-wheel.png` });
    const t0 = Date.now();
    await wheel.getByRole("button", { name: "Laugh" }).click();
    await expect(wheel).toBeHidden();
    // Where it pops for the DM: above Dave's fighter on the board.
    const box = await admin.locator(`[data-testid="emote-pop"][data-user="${daveId}"]`).boundingBox();
    const at = await hook<{ sx: number; sy: number }>(admin, "project", 15, 20, 0);
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - at.sx)).toBeLessThan(24);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThan(at.sy);
    await admin.screenshot({ path: `${SHOTS}/emote-over-token.png` });
    // Over his token for the DM and for Dave; over his portrait for Erin, who doesn't see it — each for 2.5 s.
    type PopEntry = {
      userId: string;
      over: string;
      emote?: string;
      phrase?: string;
      shownAt: number;
      goneAt: number | null;
    };
    const pops = (p: Page) => hook<PopEntry[]>(p, "emotePops");
    for (const [p, over] of [
      [admin, "token"],
      [dave, "token"],
      [erin, "portrait"],
    ] as const) {
      await expect
        .poll(async () =>
          (await pops(p)).find((x) => x.userId === daveId && x.emote === "laugh" && x.goneAt !== null),
        )
        .toMatchObject({ over });
      const x = (await pops(p)).find((q) => q.userId === daveId && q.emote === "laugh") as PopEntry;
      const lasted = (x.goneAt as number) - x.shownAt;
      expect(lasted, "shown for 2.5 s").toBeGreaterThan(2200);
      expect(lasted).toBeLessThan(3600);
      await expect(p.getByTestId("emote-feed")).toContainText("Dave");
      expect(await sounds(p, "emotePop")).toBeGreaterThan(0);
    }
    expect(Date.now() - t0).toBeGreaterThan(2400);
    // A phrase of his own: saved from the wheel (it follows him — his profile keeps it), sent as a bubble.
    await dave.waitForTimeout(1500);
    await dave.keyboard.press("e");
    await wheel.getByRole("button", { name: "Your own phrase" }).click();
    await wheel.getByLabel("Your phrase").fill("Stand back!");
    await wheel.getByRole("button", { name: "Save" }).click();
    await wheel.getByRole("button", { name: "Stand back!" }).click();
    await expect(erin.locator('[data-testid="emote-pop"]', { hasText: "Stand back!" })).toBeVisible();
    await erin.screenshot({ path: `${SHOTS}/phrase.png` });
    // The rate limit: one every 1.5 s, in bursts of three.
    await dave.waitForTimeout(4600);
    for (let i = 0; i < 3; i++) await req(dave, "emote.send", { emote: "clap" });
    await expect(req(dave, "emote.send", { emote: "clap" })).rejects.toThrow(/Slow down|RATE_LIMITED/);

    // ── The raised hand (AC-FUN-03) ────────────────────────────────────────────────────────────────────
    const bellsBefore = await sounds(admin, "handRaised");
    await dave.keyboard.press("h");
    const daveOnTop = (p: Page) => p.locator(`[data-presence="${daveId}"]`).getByTestId("hand-badge");
    for (const p of [admin, dave, erin]) await expect(daveOnTop(p)).toBeVisible();
    await expect.poll(() => sounds(admin, "handRaised")).toBe(bellsBefore + 1);
    await expect(admin.getByText("Dave raised a hand")).toBeVisible();
    // …and in the tracker, on his creature's portrait.
    await req(admin, "combat.quickStart", {});
    await expect(
      admin.locator(`[data-testid="tracker-entry"][data-token="${fighter}"]`).getByTestId("hand-badge"),
    ).toBeVisible({
      timeout: 15_000,
    });
    await admin.screenshot({ path: `${SHOTS}/hand-raised.png` });
    // Told once: the DM hears no more while it stays up.
    await admin.waitForTimeout(1200);
    expect(await sounds(admin, "handRaised")).toBe(bellsBefore + 1);
    expect(await sounds(dave, "handRaised")).toBe(0);
    await dave.keyboard.press("h");
    for (const p of [admin, erin]) await expect(daveOnTop(p)).toBeHidden();
    await req(admin, "combat.stop", {}).catch(() => {});

    // ── Handouts and secret notes (AC-FUN-04) ─────────────────────────────────────────────────────────
    await dmSection(admin, "Handouts");
    const panel = admin.getByTestId("handouts-panel");
    await panel.getByRole("button", { name: "New handout" }).click();
    await panel.getByLabel("Title").fill("A torn map");
    await panel.getByLabel("Text").fill("**North** of the crypt, a second stair.\n\n- the well\n- the gate");
    await panel.getByRole("button", { name: "Save the handout" }).click();
    const row = panel.getByTestId("dm-handout").filter({ hasText: "A torn map" });
    await expect(row).toContainText("A draft: nobody has it yet");
    const unfurls = await sounds(dave, "handoutReveal");
    await row.getByRole("button", { name: "Show A torn map" }).click();
    await admin.getByRole("menuitem", { name: "To Dave" }).click();
    await expect(row).toContainText("Shown to Dave");
    const reveal = dave.getByTestId("handout-reveal");
    await expect(reveal).toBeVisible();
    await expect(reveal.getByRole("heading", { name: "A torn map" })).toBeVisible();
    await expect(reveal.getByText("North", { exact: true })).toHaveCSS("font-weight", "700");
    await expect.poll(() => sounds(dave, "handoutReveal")).toBe(unfurls + 1);
    await dave.waitForTimeout(700);
    await dave.screenshot({ path: `${SHOTS}/handout-reveal.png` });
    await erin.waitForTimeout(500);
    await expect(erin.getByTestId("handout-reveal")).toBeHidden();
    await reveal.getByRole("button", { name: "Keep it" }).click();
    await expect(reveal).toBeHidden();
    // Kept: in his Journal; not in Erin's.
    const journal = async (p: Page, tab: "Log" | RegExp) => {
      if (!(await p.getByRole("region", { name: "Journal" }).isVisible()))
        await p.getByRole("button", { name: /^Journal/ }).click();
      await p.getByRole("tab", { name: tab }).click();
    };
    await journal(dave, /^Handouts/);
    await expect(dave.getByTestId("handouts-list").getByTestId("handout-card")).toHaveCount(1);
    await expect(dave.getByTestId("handouts-list")).toContainText("A torn map");
    await journal(erin, /^Handouts/);
    await expect(erin.getByTestId("handouts-list").getByTestId("handout-card")).toHaveCount(0);
    // A secret note to Erin: hers alone.
    await panel.getByLabel("For").selectOption({ label: "Erin" });
    await panel.getByLabel("The note").fill("Only you notice the glyph glowing.");
    await panel.getByRole("button", { name: "Send the note" }).click();
    await expect(erin.getByTestId("handout-reveal")).toContainText("Only you notice the glyph glowing.");
    await erin.screenshot({ path: `${SHOTS}/secret-note.png` });
    // The map shown to everyone while her note is still open: it waits its turn — never two parchments at once.
    await row.getByRole("button", { name: "Show A torn map" }).click();
    await admin.getByRole("menuitem", { name: "To everyone" }).click();
    await expect(row).toContainText("Shown to everyone");
    await erin.waitForTimeout(600);
    await expect(erin.getByTestId("handout-reveal")).toHaveCount(1);
    await expect(erin.getByTestId("handout-reveal")).toContainText("glyph");
    await erin.getByTestId("handout-reveal").getByRole("button", { name: "Keep it" }).click();
    await expect(
      erin.getByTestId("handout-reveal").getByRole("heading", { name: "A torn map" }),
    ).toBeVisible();
    await expect(erin.getByTestId("handout-reveal")).toHaveCount(1);
    await erin.getByTestId("handout-reveal").getByRole("button", { name: "Keep it" }).click();
    await expect(erin.getByTestId("handout-reveal")).toBeHidden();
    await expect(erin.getByTestId("handouts-list").getByTestId("handout-card")).toHaveCount(2);
    // (Dave has it already: his list keeps one of it, no second unfurling of the same map.)
    await expect(dave.getByTestId("handouts-list").getByTestId("handout-card")).toHaveCount(1);
    await dave.waitForTimeout(500);
    expect(JSON.stringify(await hook(dave, "handouts"))).not.toContain("glyph");
    await expect(dave.getByTestId("handout-reveal")).toBeHidden();
    await admin.screenshot({ path: `${SHOTS}/dm-handouts.png` });

    // ── The campaign log (AC-FUN-05) ─────────────────────────────────────────────────────────────────
    await journal(dave, "Log");
    const log = dave.getByTestId("campaign-log");
    await expect(log).toContainText("Session 1 began.");
    await expect(log).toContainText("Combat");
    await expect(log.getByTestId("log-session")).toHaveCount(1);
    await log.getByLabel("A line for the log").fill("We found the second stair.\nDave kept the key.");
    await log.getByRole("button", { name: "Add to the log" }).click();
    await journal(erin, "Log");
    await expect(erin.getByTestId("campaign-log")).toContainText("We found the second stair.");
    // The targeted handout's line is Dave's (and the DM's), not Erin's.
    await expect(log).toContainText('showed the handout "A torn map" to a player');
    await expect(erin.getByTestId("campaign-log")).not.toContainText("to a player");
    // (Shown to everyone afterwards: that line is everyone's.)
    await expect(erin.getByTestId("campaign-log")).toContainText('The DM showed the handout "A torn map".');
    // Search narrows it.
    await log.getByLabel("Search the log").fill("stair");
    await expect(log.getByTestId("log-entry")).toHaveCount(1);
    await dave.screenshot({ path: `${SHOTS}/journal-log.png` });
    await log.getByLabel("Search the log").fill("");
    // Exported as Markdown.
    const download = dave.waitForEvent("download");
    await log.getByRole("button", { name: "Markdown" }).click();
    const file = await (await download).path();
    const md = readFileSync(file, "utf8");
    expect(md).toContain("# Test Campaign — campaign log");
    expect(md).toContain("## Session 1");
    expect(md).toContain("— Dave: We found the second stair.\n  Dave kept the key.");
  });
});
