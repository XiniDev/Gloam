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

type Compiled = { name: string; key: string; at: number; origin: "warm" | "draw"; materials: string[] };
type Warm = { phase: string; rounds: number; skipped?: boolean; doneAt?: number };
type Gpu = { lost: boolean; losses: number; restores: number; contextLost: boolean };
type Tok = { pos: { x: number; y: number } };

/** Points over the free board (clear of the top bar, the rail and the dock) where the board's colours are read. */
const GRID = [0.28, 0.42, 0.56, 0.7].flatMap((fx) => [0.3, 0.5, 0.7].map((fy) => ({ fx, fy })));

/** The board's colours (0–255) at the grid's points, averaged over a small square each. */
async function sample(p: Page): Promise<number[]> {
  const vp = p.viewportSize() as { width: number; height: number };
  const out: number[] = [];
  for (const { fx, fy } of GRID) {
    const c = await hook<{ r: number; g: number; b: number } | null>(
      p,
      "canvasRegion",
      Math.round(vp.width * fx),
      Math.round(vp.height * fy),
      8,
    );
    if (!c) throw new Error("no board canvas");
    out.push(c.r * 255, c.g * 255, c.b * 255);
  }
  return out;
}
const worst = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - (b[i] as number))));

/**
 * The board losing its WebGL context and getting it back (SPEC §40 — a phone short of graphics memory, a driver
 * reset; simulated here with WEBGL_lose_context): "Restoring board…" covers the board while the HUD stays in use; once
 * the context is back, everything is drawn again as it was — the player's fog and lighting, the lit room the board and
 * the dice reflect — the shader warm-up runs again, so play compiles nothing afterwards; and when a browser never
 * gives the context back, the board offers to reload the page, which brings it back.
 */
test.describe("P15 — a lost WebGL context restores the board (SPEC §40)", () => {
  test("SPEC §40: “Restoring board…”, everything drawn again, the warm-up redone, and Reload when it never comes back", async ({
    admin,
    browser,
    gloam,
    guardLog,
  }) => {
    test.setTimeout(420_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    // A dark room in dynamic fog with a torch and walls: what the player sees is the vision passes' drawing.
    const sceneId = await createScene(admin, {
      name: "Cellar",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 40,
      heightFt: 30,
      fogMode: "dynamic",
    });
    await req(admin, "scene.update", { sceneId, ambientLevel: "dark" });
    await req(admin, "wall.create", {
      sceneId,
      walls: [
        { a: { x: 20, y: 0 }, b: { x: 20, y: 12 } },
        { a: { x: 20, y: 18 }, b: { x: 20, y: 30 } },
        { a: { x: 0, y: 20 }, b: { x: 12, y: 20 } },
      ],
    });
    await req(admin, "light.create", { sceneId, pos: { x: 10, y: 10 }, preset: "torch" });
    await boardSettled(admin, sceneId);

    // The player warms up (test builds do only when asked — see Warmup.tsx), without motion: the fog's drift and the
    // torch's flicker would otherwise change the colours between two readings.
    const player = await admitPlayer(admin, browser, gloam, guardLog, code, "Dana", {
      reducedMotion: "reduce",
      onPage: (p) =>
        p.addInitScript(() => {
          try {
            localStorage.setItem("gloam:warmup", "on");
          } catch {}
        }),
    });
    const danaId = (await hook<{ userId: string }>(player, "me")).userId;
    const { tokenId } = await req<{ tokenId: string }>(admin, "token.create", {
      sceneId,
      name: "Dana's scout",
      pos: { x: 12.5, y: 12.5 },
      ownerIds: [danaId],
      disposition: "party",
    });
    await boardSettled(player, sceneId);
    await expect.poll(() => hook(player, "token", tokenId)).not.toBeNull();
    const first = await hook<Warm>(player, "warmup");
    expect(first).toMatchObject({ phase: "done", rounds: 1 });
    expect(first.skipped).toBeFalsy();
    for (const p of [admin, player]) await camera(p, { pitchDeg: 70, distance: 60, target: [16, 14], ms: 0 });
    await player.waitForTimeout(1500);

    // ── The player's board as drawn, twice (how much it changes on its own) ──
    const before = await sample(player);
    await player.waitForTimeout(600);
    const noise = worst(before, await sample(player));
    const tolerance = Math.max(6, noise * 2 + 2);
    const visionBefore = await hook<{ draws: number; lightDraws: number }>(player, "vision");

    // ── The context goes: "Restoring board…" over the board; the HUD still works ──
    await hook(player, "loseContext");
    await expect.poll(() => hook<Gpu>(player, "gpu")).toMatchObject({ lost: true, contextLost: true });
    const overlay = player.getByTestId("board-restoring");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Restoring board…");
    await player.getByTestId("dice-button").click();
    await expect(player.getByTestId("dice-tray")).toBeVisible();
    await player.getByRole("button", { name: "Close the tray" }).click();
    expect((await hook<Warm>(player, "warmup")).phase).not.toBe("done");

    // ── …and comes back: the warm-up runs again, then the board shows as it was ──
    await hook(player, "restoreContext");
    await expect(overlay).toBeHidden({ timeout: 150_000 });
    const again = await hook<Warm>(player, "warmup");
    expect(again).toMatchObject({ phase: "done", rounds: 2 });
    expect(again.skipped).toBeFalsy();
    expect(await hook<Gpu>(player, "gpu")).toMatchObject({ lost: false, losses: 1, restores: 1 });
    const visionAfter = await hook<{ draws: number; lightDraws: number }>(player, "vision");
    expect(visionAfter.draws, "the vision passes drawn again").toBeGreaterThan(visionBefore.draws);
    expect(visionAfter.lightDraws, "the lights drawn again").toBeGreaterThan(visionBefore.lightDraws);
    await expect
      .poll(async () => worst(before, await sample(player)), {
        message: `the board as it was (± ${tolerance.toFixed(1)}; it changes by ${noise.toFixed(1)} on its own)`,
        timeout: 15_000,
      })
      .toBeLessThanOrEqual(tolerance);

    // Play after it compiles nothing: the camera, a drag, dice.
    const shown = again.doneAt as number;
    const at = (await hook<Tok>(player, "token", tokenId)).pos;
    await camera(player, { pitchDeg: 40, distance: 45, ms: 0 });
    await player.waitForTimeout(400);
    await camera(player, { pitchDeg: 70, distance: 60, target: [16, 14], ms: 0 });
    await player.waitForTimeout(400);
    const s = await hook<{ sx: number; sy: number }>(player, "project", at.x, at.y, 0.15);
    const t = await hook<{ sx: number; sy: number }>(player, "project", at.x + 5, at.y, 0.15);
    await player.mouse.move(s.sx, s.sy);
    await player.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await player.mouse.move(s.sx + ((t.sx - s.sx) * i) / 8, s.sy + ((t.sy - s.sy) * i) / 8);
      await player.waitForTimeout(40);
    }
    await player.mouse.up();
    await expect
      .poll(async () => (await hook<Tok>(admin, "token", tokenId)).pos.x, { timeout: 15_000 })
      .toBeCloseTo(at.x + 5, 0);
    await req(player, "dice.roll", { formula: "1d20 + 1d6" });
    await player.waitForTimeout(3500);
    const late = (await hook<Compiled[]>(player, "programs")).filter(
      (c) => c.at > shown && c.origin === "draw",
    );
    for (const c of late) console.log(`  late: ${c.name} ${c.key} :: ${c.materials.join(" | ")}`);
    expect(late.map((c) => c.name)).toEqual([]);

    // ── The lit rooms reflected by the board and the dice are drawn again (the DM's board, no warm-up) ──
    const envBefore = {
      board: (await hook<number[]>(admin, "envLight", "board")) as number[],
      dice: (await hook<number[]>(admin, "envLight", "dice")) as number[],
    };
    for (const [k, v] of Object.entries(envBefore))
      expect(Math.max(...v), `${k}: the metal ball reflects the room`).toBeGreaterThan(20);
    await hook(admin, "loseContext");
    await expect(admin.getByTestId("board-restoring")).toBeVisible();
    await hook(admin, "restoreContext");
    await expect(admin.getByTestId("board-restoring")).toBeHidden({ timeout: 30_000 });
    for (const k of ["board", "dice"] as const) {
      const after = (await hook<number[]>(admin, "envLight", k)) as number[];
      console.log(`[context] ${k} room: ${envBefore[k].join(",")} → ${after.join(",")}`);
      expect(worst(envBefore[k], after), `${k}: the same room after the restore`).toBeLessThanOrEqual(2);
    }

    // ── A context the browser never gives back: after a while, Reload — and the board is back ──
    await hook(player, "loseContext");
    await expect(overlay).toBeVisible();
    const reload = player.getByRole("button", { name: "Reload the page" });
    await expect(reload).toBeVisible({ timeout: 15_000 });
    // (The page is already /table: the reload is the new page's load.)
    await Promise.all([player.waitForEvent("load"), reload.click()]);
    await expect(player).toHaveURL(/\/table$/);
    await introDone(player);
    await boardSettled(player, sceneId);
    expect(await hook<Gpu>(player, "gpu")).toMatchObject({ lost: false, losses: 0, contextLost: false });
    await expect(player.getByTestId("board-restoring")).toBeHidden();
  });
});
