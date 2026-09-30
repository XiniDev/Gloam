import type { Page } from "@playwright/test";
import { adminAtTable, admitPlayer, dmSection, hook, introDone } from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

type Probe = {
  kind: "track" | "preset";
  driftMs?: number | null;
  positionMs?: number;
  expectedMs?: number;
  playing?: boolean;
  preset?: string;
  seed?: number;
  scheduled?: { layer: number; bar: number; dueServerMs: number; heardServerMs: number; late: boolean }[];
};
type Sync = {
  music: { kind: string; trackId: string | null; preset: string | null; paused: boolean; rev: number };
};

/** A mono 16-bit WAV: a soft 440 Hz tone of `sec` seconds (a stand-in for an uploaded track). */
function toneWav(sec: number, rate = 22050): Buffer {
  const n = Math.floor(sec * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return b;
}

/** A page whose computer clock is `ms` off (its wall clock at load, which is what a page's time is measured from). */
async function skewClock(page: Page, ms: number): Promise<void> {
  await page.addInitScript((skew) => {
    const origin = performance.timeOrigin + skew;
    Object.defineProperty(performance, "timeOrigin", { get: () => origin });
    const now = Date.now.bind(Date);
    Date.now = () => now() + skew;
  }, ms);
}

const probe = (p: Page) => hook<Probe | null>(p, "musicProbe");
/** The quietest and loudest a channel is over a while (sampled every 10 ms, after its fader). */
const meterOver = (p: Page, channel: string, ms: number) =>
  hook<{ min: number; max: number }>(p, "meterOver", channel, ms);

/** Samples a page's track position against the server's timeline for a while: every drift it saw. */
async function drifts(p: Page, samples: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const pr = await probe(p);
    if (pr?.kind === "track" && pr.driftMs !== null && pr.driftMs !== undefined && pr.playing)
      out.push(pr.driftMs);
    await p.waitForTimeout(250);
  }
  return out;
}

test.describe("P11 — music and ambience (AUD)", () => {
  test("AC-AUD-02 / AC-AUD-06 / AC-AUD-03: the DM's music plays in step for everyone — a track within 75 ms of the server's timeline on every client (a skewed clock and a late joiner too), pause and resume where it was, crossfades to and from a generative preset whose notes every client schedules alike; the ambience for everyone; each player's own music and ambience faders", {
    // Millisecond sync is measured alone (the timing project), not against another test's rendering for the CPU.
    tag: "@timing",
  }, async ({ admin, browser, gloam, guardLog }) => {
    test.setTimeout(300_000);
    const code = await adminAtTable(admin);
    await introDone(admin);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave");
    // Tracks come from the library: the DM's upload (a DM's own is approved at once).
    const track = await hook<{ id: string }>(
      admin,
      "upload",
      toneWav(40).toString("base64"),
      "Lantern waltz.wav",
      "audio",
    );
    await dmSection(admin, "Sound");
    const panel = admin.getByTestId("sound-panel");
    await expect(panel.getByRole("button", { name: "Play Lantern waltz" })).toBeVisible();
    await panel.getByRole("button", { name: "Play Lantern waltz" }).click();
    for (const p of [admin, dave])
      await expect.poll(async () => (await probe(p))?.playing, { timeout: 15_000 }).toBe(true);
    // The DM's browser measured it (length and loudness): the server now times its end.
    await expect
      .poll(() => admin.evaluate((id) => fetch(`/api/assets/${id}`).then((r) => r.json()), track.id))
      .toMatchObject({ data: { durationMs: 40_000 } });

    // In step: every client within 75 ms of the server's timeline (so within 150 ms of each other).
    await admin.waitForTimeout(2500);
    for (const p of [admin, dave]) {
      const d = await drifts(p, 12);
      expect(d.length, "samples").toBeGreaterThan(8);
      for (const x of d) expect(Math.abs(x), `drift ${x.toFixed(0)} ms`).toBeLessThanOrEqual(75);
    }

    // A late joiner — on a computer whose clock is 7 s fast — starts at the current position, in step.
    const erin = await admitPlayer(admin, browser, gloam, guardLog, code, "Erin", {
      onPage: (p) => skewClock(p, 7000),
    });
    await expect
      .poll(async () => (await probe(erin))?.playing, {
        timeout: 15_000,
        message: `Erin: ${JSON.stringify(await erin.evaluate(() => ({ clock: (window.__gloam?.clock as () => unknown)?.(), sync: (window.__gloam?.audioSync as () => { music: unknown })?.().music, state: (window.__gloam as Record<string, unknown>)?.audioState })))}`,
      })
      .toBe(true);
    const clock = await hook<{ serverNow: number }>(erin, "clock");
    expect(Math.abs(clock.serverNow - Date.now()), "Erin's idea of the server's time").toBeLessThan(40);
    await erin.waitForTimeout(2500);
    const late = await probe(erin);
    expect(late?.positionMs).toBeGreaterThan(8000);
    for (const x of await drifts(erin, 12))
      expect(Math.abs(x), `Erin's drift ${x.toFixed(0)} ms`).toBeLessThanOrEqual(75);

    // Pause and resume: it stops everywhere, and carries on from where it stopped.
    await panel.getByRole("button", { name: "Pause", exact: true }).click();
    for (const p of [admin, dave, erin])
      await expect.poll(async () => (await probe(p))?.playing, { timeout: 5000 }).toBe(false);
    const pausedAt = (await probe(dave))?.expectedMs ?? 0;
    await dave.waitForTimeout(1500);
    await panel.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(async () => (await probe(dave))?.playing, { timeout: 5000 }).toBe(true);
    const resumed = (await probe(dave))?.expectedMs ?? 0;
    expect(resumed - pausedAt).toBeLessThan(1000);
    await dave.waitForTimeout(2500);
    for (const x of await drifts(dave, 8)) expect(Math.abs(x)).toBeLessThanOrEqual(75);

    // To a generative preset: a 2-s crossfade — the music never drops out — and every client plays the same notes.
    const during = meterOver(dave, "music", 2600);
    await panel.getByRole("button", { name: /^Tavern Plucked/ }).click();
    const fadeLevels = await during;
    expect(fadeLevels.min, "the music through the crossfade").toBeGreaterThan(0.002);
    for (const p of [admin, dave, erin])
      await expect.poll(async () => (await probe(p))?.kind, { timeout: 10_000 }).toBe("preset");
    await dave.waitForTimeout(4000);
    const [pd, pe] = [await probe(dave), await probe(erin)];
    expect(pd?.seed).toBe(pe?.seed);
    const key = (s: NonNullable<Probe["scheduled"]>[number]) =>
      `${s.layer}:${s.bar}:${s.dueServerMs.toFixed(1)}`;
    const dueD = new Set((pd?.scheduled ?? []).map(key));
    const common = (pe?.scheduled ?? []).filter((s) => dueD.has(key(s)));
    // The same notes, due at the same server time on both — Erin's clock 7 s off notwithstanding.
    expect(common.length, "notes both scheduled").toBeGreaterThan(20);
    for (const s of pe?.scheduled ?? []) {
      if (s.late) continue;
      // Each heard when it's due (within 5 ms), on the server's clock as each page reckons it.
      expect(Math.abs(s.heardServerMs - s.dueServerMs)).toBeLessThan(5);
    }
    const lateShare =
      (pe?.scheduled ?? []).filter((s) => s.late).length / Math.max(1, pe?.scheduled?.length ?? 1);
    expect(lateShare, "notes scheduled too late to be on time").toBeLessThan(0.1);
    // Preset to preset: the same 2-s crossfade, never a gap.
    const between = meterOver(dave, "music", 2600);
    await panel.getByRole("button", { name: /^Battle/ }).click();
    expect((await between).min, "the music from Tavern to Battle").toBeGreaterThan(0.002);
    await expect.poll(async () => (await probe(dave))?.preset).toBe("battle");
    // …and back to a track, through a playlist made here: crossfading again.
    await panel.getByLabel("New playlist's name").fill("Road");
    await panel.getByRole("button", { name: "Make", exact: true }).click();
    await panel.getByRole("button", { name: "Add Lantern waltz to a playlist" }).click();
    await admin.getByRole("menuitem", { name: "Road" }).click();
    await expect(panel.getByTestId("playlist-row")).toContainText("1 track");
    await panel.getByRole("button", { name: "Play Road" }).click();
    for (const p of [admin, dave, erin])
      await expect.poll(async () => (await probe(p))?.kind, { timeout: 10_000 }).toBe("track");
    await expect
      .poll(
        async () =>
          (await hook<{ music: { playlistId: string | null } }>(dave, "audioSync")).music.playlistId,
      )
      .not.toBeNull();

    // Ambience (AC-AUD-03): the DM's Storm, synthesized on every client; a layer moved by hand, for everyone.
    await panel.getByRole("button", { name: "Storm", exact: true }).click();
    for (const p of [admin, dave, erin]) {
      await expect
        .poll(async () => Object.keys(await hook<Record<string, number>>(p, "ambienceProbe")).sort(), {
          timeout: 10_000,
        })
        .toEqual(["rain", "wind"]);
      await expect.poll(() => meterOver(p, "ambience", 600).then((r) => r.max)).toBeGreaterThan(0.005);
    }
    await panel.getByRole("slider", { name: "Fire level" }).fill("0.6");
    for (const p of [dave, erin])
      await expect
        .poll(async () => Object.keys(await hook<Record<string, number>>(p, "ambienceProbe")).sort())
        .toEqual(["fire", "rain", "wind"]);
    await expect
      .poll(
        async () =>
          (
            await hook<{ ambience: { levels: Record<string, number>; preset: string | null } }>(
              dave,
              "audioSync",
            )
          ).ambience,
      )
      .toMatchObject({ preset: null, levels: { rain: 0.9, wind: 0.8, fire: 0.6 } });

    // Each player's own faders: Dave mutes his music and ambience; Erin still hears both.
    await dave.getByRole("button", { name: "Settings" }).click();
    for (const label of ["Music", "Ambience"])
      await dave.getByRole("button", { name: `Mute ${label}`, exact: true }).click();
    await dave.keyboard.press("Escape");
    await dave.waitForTimeout(300);
    for (const c of ["music", "ambience"]) {
      const mine = await meterOver(dave, c, 800);
      expect(mine.max, `Dave's ${c}, muted`).toBeLessThan(1e-4);
      const hers = await meterOver(erin, c, 800);
      expect(hers.max, `Erin's ${c}`).toBeGreaterThan(0.001);
    }
    // The DM's mixer says the mix is no longer the preset's.
    await expect(panel.getByRole("button", { name: "Storm", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await admin.screenshot({ path: "artifacts/screens/p11/sound-panel.png" });
    // (The late page's own test clock is off by design; nothing else.)
    void guardLog;
  });

  test("the music survives the table: what was playing when it closed plays on when it opens again (the campaign keeps it)", async ({
    admin,
  }) => {
    await adminAtTable(admin);
    await introDone(admin);
    await dmSection(admin, "Sound");
    await admin
      .getByTestId("sound-panel")
      .getByRole("button", { name: /^Wonder/ })
      .click();
    await expect.poll(async () => (await probe(admin))?.kind).toBe("preset");
    const before = await hook<Sync>(admin, "audioSync");
    await admin.reload();
    await introDone(admin);
    await expect
      .poll(async () => (await hook<Sync>(admin, "audioSync")).music)
      .toMatchObject({
        kind: "preset",
        preset: "wonder",
        rev: before.music.rev,
      });
    await expect.poll(async () => (await probe(admin))?.kind, { timeout: 10_000 }).toBe("preset");
  });
});
