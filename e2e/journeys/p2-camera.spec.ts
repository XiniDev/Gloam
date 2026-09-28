import type { Page } from "@playwright/test";
import {
  adminAtTable,
  admitPlayer,
  boardSettled,
  camera,
  createScene,
  hook,
  introDone,
} from "../fixtures/board.ts";
import { expect, test } from "../fixtures/test.ts";

/** The rig's easing (CameraRig.tsx): cubic ease-in-out. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function unease(f: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ease(mid) < f) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

type CamLog = {
  log: { t: number; tx: number; tz: number; pitch: number; dist: number }[];
  tweenStarts: { kind: string; at: number }[];
};

/**
 * Durations implied by each rendered mid-flight frame of the rig's most recent `kind` tween begun after `after`
 * (page clock): t − start = duration · unease(progress). Exact per frame, whatever the frame rate.
 */
async function impliedDurations(
  page: Page,
  kind: "pitch" | "move",
  after: number,
  progress: (from: CamLog["log"][number], to: CamLog["log"][number], f: CamLog["log"][number]) => number,
): Promise<{ began: number; durations: number[] }> {
  const { log, tweenStarts } = await hook<CamLog>(page, "cameraLog");
  const began = [...tweenStarts].reverse().find((t) => t.kind === kind && t.at > after)?.at;
  if (began === undefined) return { began: Number.NaN, durations: [] };
  const from = [...log].reverse().find((f) => f.t < began);
  const to = log[log.length - 1];
  if (!from || !to) return { began, durations: [] };
  const durations = log
    .filter((f) => f.t > began)
    .map((f) => ({ t: f.t - began, f: progress(from, to, f) }))
    .filter((q) => q.f > 0.02 && q.f < 0.98)
    .map((q) => q.t / unease(q.f));
  return { began, durations };
}

const boardBox = async (page: Page) =>
  (await page.getByTestId("board").boundingBox()) as { x: number; y: number; width: number; height: number };
const ground = (page: Page, x: number, y: number) =>
  hook<{ x: number; y: number } | null>(page, "groundAt", x, y);

/** Camera behaviour, not resolution: a smaller board renders enough frames under software GL to time the tweens. */
const VIEWPORT = { width: 800, height: 500 };

test.describe("P2 — the camera and the DM Spotlight (BRD-02, BRD-04)", () => {
  test.use({ viewport: VIEWPORT });
  test("AC-BRD-02: zoom toward the cursor, orbit, pan, presets (400 ms), pitch/distance/bounds clamps", {
    tag: "@timing",
  }, async ({ admin }) => {
    await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Camera range",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: 60,
      heightFt: 40,
    });
    await boardSettled(admin, sceneId);
    const b = await boardBox(admin);
    const still = async () => {
      // camera-controls eases (smoothTime 0.12 s): wait until two samples 200 ms apart agree.
      await expect
        .poll(async () => {
          const a = await camera(admin);
          await admin.waitForTimeout(200);
          const c = await camera(admin);
          return (
            Math.abs(a.distance - c.distance) +
            Math.abs(a.pitchDeg - c.pitchDeg) +
            Math.abs(a.target[0] - c.target[0]) +
            Math.abs(a.target[2] - c.target[2])
          );
        })
        .toBeLessThan(0.01);
    };

    // Presets over exactly 400 ms: Shift+1 top-down, Shift+2 tabletop (55°), Shift+3 low (30°); T toggles. Each
    // transition repeats (from its reset view) until ≥ 3 rendered mid-flight frames are in; every one of them must
    // imply 400 ms from the rig's start, and the rig must start on the key press.
    const settle = (pitch: number) =>
      expect
        .poll(async () => Math.abs((await camera(admin)).pitchDeg - pitch), { timeout: 10_000 })
        .toBeLessThan(0.05);
    for (const [key, pitch, reset, resetPitch] of [
      ["Shift+Digit1", 90, "Shift+Digit2", 55],
      ["Shift+Digit3", 30, "Shift+Digit2", 55],
      ["Shift+Digit2", 55, "Shift+Digit1", 90],
      ["KeyT", 90, "Shift+Digit2", 55],
      ["KeyT", 55, "Shift+Digit1", 90],
    ] as const) {
      const all: number[] = [];
      for (let attempt = 0; attempt < 8 && all.length < 3; attempt++) {
        await admin.keyboard.press(reset);
        await settle(resetPitch);
        await admin.evaluate(() => {
          const w = window as unknown as { __keyAt: number };
          addEventListener("keydown", () => (w.__keyAt = performance.now()), { once: true, capture: true });
        });
        const after = await admin.evaluate(() => performance.now());
        await admin.keyboard.press(key);
        await settle(pitch);
        const { began, durations } = await impliedDurations(
          admin,
          "pitch",
          after,
          (a, b, f) => (f.pitch - a.pitch) / (b.pitch - a.pitch),
        );
        const keyAt = await admin.evaluate(() => (window as unknown as { __keyAt: number }).__keyAt);
        // Shift+… presses Shift first: the rig starts on the digit, a moment after the first keydown.
        expect(began - keyAt, `${key} starts on the key press`).toBeLessThan(40);
        expect(began - keyAt).toBeGreaterThanOrEqual(0);
        all.push(...durations);
      }
      test.info().annotations.push({
        type: "preset",
        description: `${key} → ${pitch}°: ${all.map((d) => Math.round(d)).join(", ")} ms`,
      });
      expect(all.length, `${key} mid-flight frames`).toBeGreaterThanOrEqual(3);
      for (const d of all) {
        expect(d, `${key} duration`).toBeGreaterThan(400 - 30);
        expect(d, `${key} duration`).toBeLessThan(400 + 30);
      }
    }

    // Zoom toward the cursor: the table point under the pointer stays under it while the distance shrinks.
    const px = b.x + b.width * 0.72;
    const py = b.y + b.height * 0.38;
    await admin.mouse.move(px, py);
    const before = await ground(admin, px, py);
    const d0 = (await camera(admin)).distance;
    for (let i = 0; i < 4; i++) {
      await admin.mouse.wheel(0, -200);
      await admin.waitForTimeout(60);
    }
    await still();
    const after = await ground(admin, px, py);
    expect((await camera(admin)).distance).toBeLessThan(d0 * 0.8);
    expect(Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(
      0.75,
    );

    // Pan (left-drag on the empty table): the point grabbed follows the pointer.
    const gx = b.x + b.width * 0.5;
    const gy = b.y + b.height * 0.55;
    const grabbed = await ground(admin, gx, gy);
    await admin.mouse.move(gx, gy);
    await admin.mouse.down();
    await admin.mouse.move(gx - 180, gy - 60, { steps: 12 });
    await admin.mouse.up();
    await still();
    const underPointer = await ground(admin, gx - 180, gy - 60);
    expect(
      Math.hypot((underPointer?.x ?? 0) - (grabbed?.x ?? 0), (underPointer?.y ?? 0) - (grabbed?.y ?? 0)),
    ).toBeLessThan(1);

    // Orbit and tilt (right-drag): azimuth turns; pitch never leaves 25°–90°.
    const az0 = (await camera(admin)).azimuthDeg;
    await admin.mouse.move(gx, gy);
    await admin.mouse.down({ button: "right" });
    await admin.mouse.move(gx + 220, gy, { steps: 12 });
    await admin.mouse.up({ button: "right" });
    await still();
    expect(Math.abs((await camera(admin)).azimuthDeg - az0)).toBeGreaterThan(10);
    for (const dy of [900, -900]) {
      await admin.mouse.move(gx, gy);
      await admin.mouse.down({ button: "right" });
      await admin.mouse.move(gx, gy + dy, { steps: 20 });
      await admin.mouse.up({ button: "right" });
      await still();
      const p = (await camera(admin)).pitchDeg;
      expect(p).toBeGreaterThanOrEqual(25 - 0.5);
      expect(p).toBeLessThanOrEqual(90 + 0.01);
      // Dragging down tilts toward top-down (orbit convention); far enough either way pins it at a clamp.
      if (dy > 0) expect(p).toBeGreaterThan(89);
      else expect(p).toBeLessThan(26);
    }

    // Distance clamps: 8–400 ft.
    await admin.keyboard.press("Shift+Digit2");
    await admin.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < 30; i++) await admin.mouse.wheel(0, 1500);
    await still();
    expect((await camera(admin)).distance).toBeLessThanOrEqual(400 + 0.5);
    expect((await camera(admin)).distance).toBeGreaterThan(300);
    for (let i = 0; i < 40; i++) await admin.mouse.wheel(0, -1500);
    await still();
    expect((await camera(admin)).distance).toBeGreaterThanOrEqual(8 - 0.01);
    expect((await camera(admin)).distance).toBeLessThan(12);

    // Bounds clamp: however far the table is dragged, the target stays within the scene + 20 % (60 × 40 ft).
    for (let i = 0; i < 6; i++) {
      await admin.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.2);
      await admin.mouse.down();
      await admin.mouse.move(b.x + b.width * 0.9, b.y + b.height * 0.9, { steps: 8 });
      await admin.mouse.up();
    }
    await still();
    const t = (await camera(admin)).target;
    expect(t[0]).toBeGreaterThanOrEqual(-12 - 0.01);
    expect(t[0]).toBeLessThanOrEqual(72 + 0.01);
    expect(t[2]).toBeGreaterThanOrEqual(-8 - 0.01);
    expect(t[2]).toBeLessThanOrEqual(48 + 0.01);
    expect(Math.min(Math.abs(t[0] + 12), Math.abs(t[2] + 8))).toBeLessThan(0.5); // pinned at a corner of the limit
  });

  test("AC-BRD-04: the DM Spotlight moves opted-in players' cameras to the spot over 600 ms; opted-out players stay", {
    tag: "@timing",
  }, async ({ admin, browser, gloam, guardLog }) => {
    const code = await adminAtTable(admin);
    await introDone(admin);
    const sceneId = await createScene(admin, {
      name: "Spotlight hall",
      mapKind: "procedural",
      floorStyle: "wood",
      widthFt: 80,
      heightFt: 50,
    });
    await boardSettled(admin, sceneId);
    const dave = await admitPlayer(admin, browser, gloam, guardLog, code, "Dave", { viewport: VIEWPORT });
    const erin = await admitPlayer(admin, browser, gloam, guardLog, code, "Erin", { viewport: VIEWPORT });
    for (const p of [dave, erin]) await boardSettled(p, sceneId);
    // Erin opts out in her settings: "Let the DM move my camera".
    await erin.getByRole("button", { name: "Settings" }).click();
    const allow = erin.getByRole("switch", { name: "Let the DM move my camera" });
    await expect(allow).toHaveAttribute("aria-checked", "true");
    await allow.click();
    await expect(allow).toHaveAttribute("aria-checked", "false");
    await erin.keyboard.press("Escape");
    const erinBefore = (await camera(erin)).target;

    // The DM Alt+Shift+clicks spots on the table (two, alternately, until ≥ 3 of Dave's rendered frames were caught
    // mid-glide); each must imply 600 ms from the moment Dave's rig began.
    const b = await boardBox(admin);
    const spots = [
      [b.x + b.width * 0.3, b.y + b.height * 0.62],
      [b.x + b.width * 0.7, b.y + b.height * 0.4],
    ] as const;
    const all: number[] = [];
    // Spotlights go at most one a second (MESSAGE_RATES): the DM's clicks are spaced to match — a refused one warns the
    // DM instead of moving anyone.
    let lastClick = 0;
    for (let i = 0; i < 8 && all.length < 3; i++) {
      const [sx, sy] = spots[i % 2] as readonly [number, number];
      const spot = (await ground(admin, sx, sy)) as { x: number; y: number };
      const wait = lastClick + 1100 - Date.now();
      if (wait > 0) await admin.waitForTimeout(wait);
      lastClick = Date.now();
      const after = await dave.evaluate(() => performance.now());
      await admin.keyboard.down("Alt");
      await admin.keyboard.down("Shift");
      await admin.mouse.click(sx, sy);
      await admin.keyboard.up("Shift");
      await admin.keyboard.up("Alt");
      await expect
        .poll(async () => {
          const t = (await camera(dave)).target;
          return Math.hypot(t[0] - spot.x, t[2] - spot.y);
        })
        .toBeLessThan(0.05);
      const { durations } = await impliedDurations(dave, "move", after, (a, z, f) => {
        const span = Math.hypot(z.tx - a.tx, z.tz - a.tz);
        return Math.hypot(f.tx - a.tx, f.tz - a.tz) / span;
      });
      all.push(...durations);
    }
    test.info().annotations.push({
      type: "spotlight",
      description: `glide durations implied by rendered frames: ${all.map((d) => Math.round(d)).join(", ")} ms`,
    });
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const d of all) {
      expect(d).toBeGreaterThan(600 - 40);
      expect(d).toBeLessThan(600 + 40);
    }
    // Erin opted out: her view didn't move.
    await erin.waitForTimeout(800);
    const erinAfter = (await camera(erin)).target;
    expect(Math.hypot(erinAfter[0] - erinBefore[0], erinAfter[2] - erinBefore[2])).toBeLessThan(0.01);
  });
});
