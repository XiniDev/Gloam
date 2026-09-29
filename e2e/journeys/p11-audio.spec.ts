import { withAutoplayPolicy } from "../fixtures/autoplay.ts";
import { adminAtTable, boardSettled, camera, createScene, hook, introDone, req } from "../fixtures/board.ts";
import { expect, newPlayerContext, test } from "../fixtures/test.ts";

type Level = { name: string; channel: string; peakDb: number; lufsM: number; plan: number | null };
type Peak = { played: boolean; channel: number; master: number };

/** Anything that looks like an audio file on the wire (by type or by name). */
const AUDIO_FILE = /\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|weba|webm)(\?|$)/i;

test.describe("P11 — the sound engine (AUD)", () => {
  test("AC-AUD-01 / AC-AUD-04: every §31 sound is synthesized as it plays — no audio files — on its channel, with its volume and mute; sound unlocks on the first gesture", async ({
    browser,
    gloam,
    guardLog,
  }) => {
    const { page } = await newPlayerContext(browser, gloam.url, guardLog);
    await withAutoplayPolicy(page);
    const audioFiles: string[] = [];
    page.on("response", (r) => {
      const type = r.headers()["content-type"] ?? "";
      if (type.startsWith("audio/") || AUDIO_FILE.test(r.url())) audioFiles.push(r.url());
    });
    await page.goto("/dev/sounds");
    await expect(page.getByTestId("dev-sounds")).toBeVisible();

    // Blocked until a gesture: the chip offers to enable it. The first click anywhere does.
    await expect.poll(() => hook(page, "audioState")).toBe("locked");
    await expect(page.getByRole("button", { name: "Tap to enable sound" })).toBeVisible();
    await page.getByRole("heading", { name: "Sound board" }).click();
    await expect.poll(() => hook(page, "audioState")).toBe("running");
    await expect(page.getByRole("button", { name: "Tap to enable sound" })).toBeHidden();

    // Every event, rendered once offline at unity: it sounds, and it sits where the level plan puts it (±3 dB).
    const levels = await hook<Level[]>(page, "measureSounds");
    expect(levels.length).toBeGreaterThanOrEqual(48);
    const off: string[] = [];
    for (const l of levels) {
      expect(l.peakDb, `${l.name} is silent`).toBeGreaterThan(-40);
      expect(["dice", "effects", "ui"], `${l.name}'s channel`).toContain(l.channel);
      if (l.plan !== null && Math.abs(l.peakDb - l.plan) > 3)
        off.push(`${l.name}: ${l.peakDb.toFixed(1)} dBFS against the plan's ${l.plan}`);
    }
    expect(off, "sounds off the level plan by more than 3 dB").toEqual([]);
    await expect(page.getByTestId("sound-row")).toHaveCount(levels.length + 1); // and the dice's tumble

    // Live, through the mixer: each channel carries its sound to the master; its mute silences it; its slider
    // lowers it (half-way is −24 dB); the master's mute silences everything.
    for (const [name, label] of [
      ["diceTrayResin", "Dice"],
      ["force", "Effects"],
      ["chime", "Interface"],
    ] as const) {
      const on = await hook<Peak>(page, "peakWhile", name, 900);
      expect(on.played, name).toBe(true);
      expect(on.channel, `${name} on its channel`).toBeGreaterThan(0.01);
      expect(on.master, `${name} at the master`).toBeGreaterThan(0.005);
      await page.getByRole("button", { name: `Mute ${label}`, exact: true }).click();
      // (A fader moves on a 20-ms time constant — no click — so it's down a quarter-second later.)
      await page.waitForTimeout(250);
      const muted = await hook<Peak>(page, "peakWhile", name, 700);
      expect(muted.channel, `${name} muted`).toBeLessThan(1e-4);
      expect(muted.master, `${name} muted, at the master`).toBeLessThan(1e-4);
      await page.getByRole("button", { name: `Unmute ${label}`, exact: true }).click();
      await page.getByRole("slider", { name: `${label} volume` }).fill("0.5");
      await page.waitForTimeout(250);
      const half = await hook<Peak>(page, "peakWhile", name, 900);
      expect(half.channel / on.channel, `${name} at half its slider`).toBeLessThan(0.2);
      await page.getByRole("slider", { name: `${label} volume` }).fill("1");
    }
    await page.getByRole("button", { name: "Mute Master", exact: true }).click();
    await page.waitForTimeout(250);
    const all = await hook<Peak>(page, "peakWhile", "force", 700);
    expect(all.master).toBeLessThan(1e-4);
    await page.getByRole("button", { name: "Unmute Master", exact: true }).click();

    // The tumble of a throw plays too (a continuous voice, not a recipe).
    await page.getByRole("button", { name: "Play Dice tumbling" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window.__gloam?.sounds ?? []).some((s) => s.name === "diceRumble" && s.played)),
      )
      .toBe(true);

    await page.screenshot({ path: "artifacts/screens/p11/sound-board.png", fullPage: true });
    expect(audioFiles, "audio files fetched").toEqual([]);
  });

  test("AC-AUD-04 (fallback): where the first gesture didn't unlock sound, the chip does", async ({
    browser,
    gloam,
    guardLog,
  }) => {
    const { page } = await newPlayerContext(browser, gloam.url, guardLog);
    await withAutoplayPolicy(page);
    await page.goto("/dev/sounds");
    await expect(page.getByTestId("dev-sounds")).toBeVisible();
    await expect.poll(() => hook(page, "audioState")).toBe("locked");
    await page.getByRole("button", { name: "Tap to enable sound" }).click();
    await expect.poll(() => hook(page, "audioState")).toBe("running");
    await expect(page.getByRole("button", { name: "Tap to enable sound" })).toBeHidden();
  });
  test("AC-AUD-05: a sound on the board is panned by where it is on screen and attenuated by its distance from the camera's target", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Echoing hall",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const token = async (name: string, x: number, y: number) =>
      (
        await req<{ tokenId: string }>(admin, "token.create", {
          sceneId,
          name,
          pos: { x, y },
          stats: { hp: 30, hpMax: 30, ac: 10 },
        })
      ).tokenId;
    const west = await token("West", 5, 20);
    const east = await token("East", 55, 20);
    const cam = await camera(admin);
    const middle = await token("Middle", cam.target[0], cam.target[2]);
    await expect.poll(async () => (await hook<{ id: string }[]>(admin, "tokens")).length).toBe(3);
    type Sound = { name: string; played: boolean; pan?: number; distanceFt?: number };
    /** Hurts a creature and returns the damage sound its fall of HP made. */
    const hurt = async (tokenId: string) => {
      const before = await admin.evaluate(() => window.__gloam?.sounds.length ?? 0);
      await req(admin, "hp.apply", { targets: [tokenId], kind: "damage", amount: 3 });
      await expect
        .poll(() =>
          admin.evaluate(
            (n) => (window.__gloam?.sounds ?? []).slice(n).filter((s) => s.name === "damage").length,
            before,
          ),
        )
        .toBe(1);
      return (await admin.evaluate(
        (n) => (window.__gloam?.sounds ?? []).slice(n).find((s) => s.name === "damage"),
        before,
      )) as Sound;
    };
    const w = await hurt(west);
    const e = await hurt(east);
    const m = await hurt(middle);
    for (const s of [w, e, m]) expect(s.played).toBe(true);
    // Left of the screen, right of it, and in the middle.
    expect(w.pan ?? 0).toBeLessThan(-0.25);
    expect(e.pan ?? 0).toBeGreaterThan(0.25);
    expect(Math.abs(m.pan ?? 1)).toBeLessThan(0.1);
    // Its distance from the camera's target, across the table (the engine turns it into 1/(1 + d/60)).
    expect(w.distanceFt ?? 0).toBeCloseTo(Math.hypot(5 - cam.target[0], 20 - cam.target[2]), 0);
    expect(e.distanceFt ?? 0).toBeCloseTo(Math.hypot(55 - cam.target[0], 20 - cam.target[2]), 0);
    expect(m.distanceFt ?? 99).toBeLessThan(1);
  });
});
