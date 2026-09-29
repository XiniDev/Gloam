import { mkdirSync } from "node:fs";
import {
  adminAtTable,
  boardSettled,
  createScene,
  dmSection,
  hook,
  introDone,
  req,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

const SHOTS = "artifacts/screens/p10";
mkdirSync(SHOTS, { recursive: true });

type Token = { id: string; name: string; hp?: { hp: number } };

/**
 * P10 — undo and history (SPEC §8.14, §14.4; J8 "Fat finger"). The DM's History panel lists the table's changes and
 * filters them; a doubled damage is one click on Revert; Restore to here puts a creature back as it was, after a
 * confirmation listing what changes; a deleted token and a fog wipe come back with Ctrl+Z.
 */
test.describe("P10 — undo and history (UNDO)", () => {
  test("AC-UNDO-03/04: the History panel lists and filters; one click reverts a doubled damage; Restore to here confirms what it reverts; a deleted token and a fog wipe come back with Ctrl+Z", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Barrow",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 30,
    });
    await boardSettled(admin, sceneId);
    const { tokenId: g } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Barrow Wight",
      pos: { x: 20, y: 15 },
      disposition: "hostile",
      stats: { hp: 45, hpMax: 45, ac: 14 },
    });
    const hp = async () => (await hook<Token[]>(admin, "tokens")).find((t) => t.id === g)?.hp?.hp;
    // J8: Fireball's damage applied twice by mistake.
    for (let i = 0; i < 2; i++) {
      await req(admin, "hp.apply", { targets: [g], kind: "damage", amount: 18, label: "Fireball" });
      await admin.waitForTimeout(250);
    }
    await expect.poll(hp).toBe(9);

    // The History panel: both entries, newest first, with who, where and when.
    await dmSection(admin, "History");
    const panel = admin.getByTestId("history-panel");
    const rows = panel.getByTestId("history-row");
    const damage = rows
      .filter({ has: admin.locator('[data-type="hp.apply"]') })
      .or(rows.and(admin.locator('[data-type="hp.apply"]')));
    await expect(damage).toHaveCount(2);
    await expect(rows.first()).toContainText("Barrow");
    await admin.screenshot({ path: `${SHOTS}/history-panel.png` });
    // Filtered by kind: HP only.
    await panel.getByLabel("Kind").selectOption("hp");
    await expect(rows).toHaveCount(2);
    await panel.getByLabel("Kind").selectOption("");
    // One click reverts the duplicate: its HP back by one Fireball, the entry struck through.
    await damage.first().getByRole("button", { name: "Revert" }).click();
    await expect.poll(hp).toBe(27);
    await expect(damage.first()).toHaveAttribute("data-undone", "true");

    // Restore to the Wight's creation: a confirmation lists what changes, then it's as it was made.
    const created = panel.locator('[data-testid="history-row"][data-type="token.create"]');
    await created.getByRole("button", { name: /^More for/ }).click();
    await admin.getByRole("menuitem", { name: "Restore to here…" }).click();
    const confirm = admin.getByRole("dialog", { name: "Restore to here?" });
    await expect(confirm.getByTestId("history-confirm")).toContainText("Fireball");
    await admin.screenshot({ path: `${SHOTS}/history-restore.png` });
    await confirm.getByRole("button", { name: /^Revert \d+ changes?$/ }).click();
    await expect.poll(hp).toBe(45);

    // A deleted token: Ctrl+Z brings it back.
    await req(admin, "token.delete", { tokenIds: [g] });
    await expect.poll(async () => (await hook<Token[]>(admin, "tokens")).some((t) => t.id === g)).toBe(false);
    await admin.getByTestId("board").click({ position: { x: 5, y: 5 } });
    await admin.keyboard.press("Control+z");
    const there = async () => (await hook<Token[]>(admin, "tokens")).some((t) => t.id === g);
    await expect.poll(there).toBe(true);
    // Redo (Ctrl+Shift+Z, or Ctrl+Y) deletes it again; undo brings it back once more.
    await admin.keyboard.press("Control+Shift+z");
    await expect.poll(there).toBe(false);
    await admin.keyboard.press("Control+z");
    await expect.poll(there).toBe(true);
    await admin.keyboard.press("Control+y");
    await expect.poll(there).toBe(false);
    await admin.keyboard.press("Control+z");
    await expect.poll(there).toBe(true);

    // A fog wipe (J8's Hide all): the revealed map hidden in one stroke; Ctrl+Z restores it.
    await req(admin, "scene.update", { sceneId, fogMode: "painted" });
    const revealed = async () => (await hook<{ layers: Record<string, number> }>(admin, "fog"))?.layers ?? {};
    const lit = async () => Object.values(await revealed()).reduce((a, b) => a + b, 0);
    await req(admin, "fog.paint", {
      sceneId,
      mode: "reveal",
      target: "all",
      shape: { kind: "brush", points: [{ x: 10, y: 15 }], radius: 8 },
    });
    await expect.poll(lit).toBeGreaterThan(0);
    const before = await lit();
    await req(admin, "fog.paint", {
      sceneId,
      mode: "hide",
      target: "all",
      shape: { kind: "all" },
    });
    await expect.poll(lit).toBe(0);
    await admin.keyboard.press("Control+z");
    await expect.poll(lit).toBe(before);
  });
});
