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
const SHOTS = "artifacts/screens/p6";

interface Token {
  id: string;
  name: string;
  actorId: string;
  pos: { x: number; y: number };
}
interface Roll {
  id: string;
  label?: string;
  total?: number;
  masked?: true;
}
const tokens = (p: Page) => hook<Token[]>(p, "tokens");
const feed = (p: Page) => hook<Roll[]>(p, "rollFeed");

test.describe("P6 — roll requests (DICE-06)", () => {
  test.use({ viewport: VIEWPORT });
  test.setTimeout(300_000);

  test("AC-DICE-06: a request puts a card with Roll / Enter / Skip before each target's player, with the formula from their sheet; the DM's live board shows each answer against a hidden DC, rolls for a player and for the NPCs, sets a result, closes it", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Rope bridge",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const erin = await admitPlayer(admin, browser, gloam, guardLog, code, "Erin", { viewport: VIEWPORT });
    const idOf = async (p: Page) => (await hook<{ userId: string }>(p, "me")).userId;
    const make = async (owner: Page, name: string, dex: number) => {
      const { actorId } = await req<{ actorId: string }>(admin, "actor.quickCreate", {
        name,
        classLevel: "Rogue 3",
        hpMax: 20,
        ac: 14,
        ownerUserId: await idOf(owner),
      });
      await req(admin, "actor.change", {
        actorId,
        changes: [{ path: ["core", "abilities", "dex"], after: dex }],
      });
      return actorId;
    };
    const thorin = await make(dave, "Thorin", 14);
    const mira = await make(erin, "Mira", 12);
    // Two goblins the DM runs (unlinked copies of one creature, DEX 14).
    const { actorId: goblin } = await req<{ actorId: string }>(admin, "actor.create", {
      kind: "npc",
      sheet: { core: { name: "Goblin", size: "small", hp: { max: 7, current: 7 }, abilities: { dex: 14 } } },
    });
    for (const x of [40, 45])
      await req(admin, "token.create", {
        sceneId,
        name: "Goblin",
        actorId: goblin,
        link: "unlinked",
        pos: { x, y: 25 },
        disposition: "hostile",
      });
    await expect.poll(async () => (await tokens(admin)).length).toBe(4);
    const all = await tokens(admin);
    const tokenOf = (actorId: string) => (all.find((t) => t.actorId === actorId) as Token).id;
    const goblins = all.filter((t) => t.actorId === goblin).map((t) => t.id);
    for (const p of [dave, erin]) await boardSettled(p, sceneId);

    // ── The DM asks the party for a Dexterity save against a hidden DC 14. ──
    await admin.getByRole("button", { name: /^DM panel/ }).click();
    const panel = admin.getByRole("region", { name: "DM panel", exact: true });
    await panel.getByRole("tab", { name: "Requests" }).click();
    const form = panel.getByTestId("new-request");
    await form.getByRole("button", { name: "All party" }).click();
    await expect(form.getByRole("button", { pressed: true })).toHaveCount(2);
    await form.getByRole("radiogroup", { name: "What to roll" }).getByRole("radio", { name: "Save" }).click();
    await form.getByLabel("Saving throw").selectOption({ label: "Dexterity" });
    await form.getByLabel("DC", { exact: true }).fill("14");
    await expect(form.getByRole("switch", { name: /Show the DC to players/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await form.getByRole("button", { name: "Ask 2 creatures" }).click();

    // Each player: a card for their own character, its formula from their sheet, the DC not shown.
    // One card per request (its label, the DC when shown), a line per creature the player answers for.
    const groupFor = (p: Page) => p.getByTestId("request-group");
    const cardFor = (p: Page) => p.getByTestId("request-card");
    await expect(groupFor(dave)).toHaveCount(1);
    await expect(groupFor(erin)).toHaveCount(1);
    await expect(cardFor(dave)).toHaveCount(1);
    await expect(cardFor(erin)).toHaveCount(1);
    await expect(groupFor(dave)).toContainText("Dexterity save");
    await expect(groupFor(erin)).toContainText("Dexterity save");
    await expect(cardFor(dave)).toContainText("Thorin");
    await expect(cardFor(dave)).toContainText("1d20 + 2");
    await expect(cardFor(erin)).toContainText("Mira");
    await expect(cardFor(erin)).toContainText("1d20 + 1");
    for (const p of [dave, erin]) {
      await expect(groupFor(p)).not.toContainText("DC");
      for (const b of ["Roll", "Enter physical roll", "Skip"])
        await expect(cardFor(p).getByRole("button", { name: b, exact: true })).toBeVisible();
    }
    await dave.screenshot({ path: `${SHOTS}/request-card.png` });
    // The DM's board: both waiting.
    const board = panel.getByTestId("request-board");
    await expect(board).toHaveCount(1);
    await expect(board).toContainText("DC 14 (hidden)");
    const row = (id: string) => board.locator(`[data-testid="request-row"][data-target="${id}"]`);
    await expect(row(tokenOf(thorin))).toHaveAttribute("data-state", "pending");
    await expect(row(tokenOf(mira))).toHaveAttribute("data-state", "pending");

    // Dave rolls (the server rolls, with his modifier); Erin enters the roll she made at the table.
    const before = (await feed(dave)).length;
    await cardFor(dave).getByRole("button", { name: "Roll", exact: true }).click();
    await expect(cardFor(dave)).toHaveAttribute("data-state", "rolled");
    await expect.poll(async () => (await feed(dave)).length).toBeGreaterThan(before);
    const daveRoll = (await feed(dave))[0] as Roll;
    expect(daveRoll.label).toBe("Dexterity save · Thorin");
    // His card shows his number, but not how it went (the DC is hidden).
    await expect(cardFor(dave)).toContainText(String(daveRoll.total));
    await expect(cardFor(dave)).not.toContainText(/success|failure/);
    await cardFor(erin).getByRole("button", { name: "Enter physical roll" }).click();
    await cardFor(erin).getByLabel("Your total").fill("11");
    await cardFor(erin).getByRole("button", { name: "Send" }).click();
    await expect(cardFor(erin)).toHaveAttribute("data-state", "manual");
    // The DM sees both, each against the DC.
    await expect(row(tokenOf(thorin))).toHaveAttribute("data-state", "rolled");
    await expect(row(tokenOf(thorin)).getByTestId("request-total")).toHaveText(String(daveRoll.total));
    await expect(row(tokenOf(thorin))).toContainText((daveRoll.total as number) >= 14 ? "pass" : "fail");
    await expect(row(tokenOf(mira))).toHaveAttribute("data-state", "manual");
    await expect(row(tokenOf(mira)).getByTestId("request-total")).toHaveText("11");
    await expect(row(tokenOf(mira))).toContainText("fail");
    // Passes and failures in their colours (the success and danger-text tokens).
    const colour = (id: string) =>
      row(id)
        .getByTestId("request-total")
        .evaluate((e) => getComputedStyle(e).color);
    const token = (name: string) =>
      admin.evaluate((v) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${v})`;
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      }, name);
    const [pass, fail] = [await token("--success"), await token("--danger-text")];
    expect(pass).not.toBe(fail);
    expect(await colour(tokenOf(mira))).toBe(fail);
    expect(await colour(tokenOf(thorin))).toBe((daveRoll.total as number) >= 14 ? pass : fail);
    // The DM sets a result by hand (a ruling): Mira 15, now a pass.
    await row(tokenOf(mira)).getByRole("button", { name: "Change" }).click();
    await row(tokenOf(mira)).getByLabel("Mira's result").fill("15");
    await row(tokenOf(mira)).getByRole("button", { name: "Set the result" }).click();
    await expect(row(tokenOf(mira))).toHaveAttribute("data-state", "dm");
    await expect(row(tokenOf(mira))).toContainText("pass");
    await admin.screenshot({ path: `${SHOTS}/request-board.png` });
    await board.getByRole("button", { name: "Close the request" }).click();
    await expect(board).toHaveCount(0);
    await expect(cardFor(dave)).toHaveCount(0);
    await expect(cardFor(erin)).toHaveCount(0);

    // ── From the radial menu: a blind Perception check for Thorin and both goblins. ──
    await camera(admin, { pitchDeg: 90, distance: 60, target: [30, 20], ms: 0 });
    const t = all.find((x) => x.id === goblins[0]) as Token;
    const s = await hook<{ sx: number; sy: number }>(admin, "project", t.pos.x, t.pos.y, 0.15);
    await admin.mouse.click(s.sx, s.sy, { button: "right" });
    await admin.getByRole("menuitem", { name: "DM" }).click();
    await admin.getByRole("menuitem", { name: "Request a roll" }).click();
    await expect(form.getByRole("button", { pressed: true })).toHaveCount(1);
    await form.getByRole("button", { name: "Thorin" }).click();
    await form
      .getByRole("button", { name: "Goblin" })
      .and(form.getByRole("button", { pressed: false }))
      .click();
    await expect(form.getByRole("button", { pressed: true })).toHaveCount(3);
    await form
      .getByRole("radiogroup", { name: "What to roll" })
      .getByRole("radio", { name: "Check" })
      .click();
    await form.getByLabel("Skill").selectOption({ label: "Perception (WIS)" });
    await form.getByLabel("DC", { exact: true }).fill("12");
    await form
      .getByRole("radiogroup", { name: "Who sees the result" })
      .getByRole("radio", { name: "Blind" })
      .click();
    await form.getByRole("button", { name: "Ask 3 creatures" }).click();
    const blind = panel.getByTestId("request-board");
    await expect(blind).toContainText("Perception check");
    await expect(blind).toContainText("blind");
    // Only Thorin's player gets a card; the goblins are the DM's to roll.
    await expect(cardFor(dave)).toHaveCount(1);
    await expect(cardFor(erin)).toHaveCount(0);
    await expect(groupFor(dave)).toContainText("Blind — the DM sees the number, you won't.");
    // The DM rolls both goblins with one click, and rolls for Thorin (with his modifiers).
    await blind.getByRole("button", { name: "Roll the 2 that are yours" }).click();
    for (const g of goblins)
      await expect(blind.locator(`[data-target="${g}"]`)).toHaveAttribute("data-state", "dm");
    await blind
      .locator(`[data-target="${tokenOf(thorin)}"]`)
      .getByRole("button", { name: "Roll for them" })
      .click();
    await expect(blind.locator(`[data-target="${tokenOf(thorin)}"]`)).toHaveAttribute("data-state", "dm");
    await expect(blind.locator(`[data-target="${tokenOf(thorin)}"]`).getByTestId("request-total")).toHaveText(
      /\d+/,
    );
    // Blind: Thorin's player learns it was rolled, never the number.
    await expect(cardFor(dave)).toHaveAttribute("data-state", "dm");
    await expect(cardFor(dave)).toContainText("Sent to the DM.");
    await expect(cardFor(dave).getByText(/^\d+$/)).toHaveCount(0);
    await admin.screenshot({ path: `${SHOTS}/request-board-blind.png` });
    await blind.getByRole("button", { name: "Close the request" }).click();
    await expect(cardFor(dave)).toHaveCount(0);
  });
});
