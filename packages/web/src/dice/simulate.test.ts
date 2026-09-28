import { Quaternion } from "three";
import { describe, expect, it } from "vitest";
import { MAX_STEPS, POSE, STEP_S, simulate, trayFor } from "./simulate.ts";
import { type DieKind, landedMarker, markerFor, remap, solid } from "./solids.ts";

function hash(a: Float32Array): number {
  let h = 2166136261;
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  for (const x of u) h = Math.imul(h ^ x, 16777619) >>> 0;
  return h;
}

describe("dice throws (SPEC §18.4, AC-DICE-03)", () => {
  it("the same seed throws the same way, frame for frame (every client sees one tumble)", async () => {
    const input = {
      dice: ["d20", "d6", "d6"] as DieKind[],
      seed: 12345,
      tray: trayFor(3),
      from: "near" as const,
    };
    const a = await simulate(input);
    const b = await simulate(input);
    expect(b.steps).toBe(a.steps);
    expect(hash(b.frames)).toBe(hash(a.frames));
    expect(b.landed).toEqual(a.landed);
    const c = await simulate({ ...input, seed: 12346 });
    expect(hash(c.frames)).not.toBe(hash(a.frames));
  });

  it("the tray is sized by the dice (the same for every client): each count's throw starts clear of its walls", async () => {
    let wider = 0;
    for (let n = 1; n <= 20; n++) {
      const tray = trayFor(n);
      // Deeper than wide (thrown along it), never shrinking as dice are added.
      expect(tray.d).toBeGreaterThan(tray.w);
      expect(tray.w).toBeGreaterThanOrEqual(wider);
      wider = tray.w;
      const res = await simulate({
        dice: Array(n).fill("d20") as DieKind[],
        seed: 77 + n,
        tray,
        from: "near",
      });
      for (let i = 0; i < n; i++) {
        const o = i * POSE;
        // Every die's circumradius is 0.8 cm: all of it inside the walls at release.
        expect(Math.abs(res.frames[o] as number) + 0.8, `die ${i} of ${n}`).toBeLessThan(tray.w / 2);
        expect(Math.abs(res.frames[o + 2] as number) + 0.8, `die ${i} of ${n}`).toBeLessThan(tray.d / 2);
      }
    }
  });

  it("every die type comes to rest on the server's number: 60 throws of d4 to d20 and d100's pair, each shown by the remapped pose", {
    timeout: 60_000,
  }, async () => {
    const sets: DieKind[][] = [["d4"], ["d6", "d6", "d6"], ["d8"], ["d10", "d10"], ["d12"], ["d20", "d20"]];
    let throws = 0;
    let settled = 0;
    const times: number[] = [];
    for (let k = 0; k < 60; k++) {
      const dice = sets[k % sets.length] as DieKind[];
      const tray = trayFor(dice.length);
      const res = await simulate({ dice, seed: 1000 + k * 7919, tray, from: k % 2 ? "near" : "far" });
      throws++;
      if (res.settled) settled++;
      times.push(res.steps * STEP_S);
      expect(res.steps).toBeLessThanOrEqual(MAX_STEPS);
      const n = dice.length;
      const last = res.steps;
      for (let i = 0; i < n; i++) {
        const s = solid(dice[i] as DieKind);
        const o = (last * n + i) * POSE;
        const f = res.frames;
        // In the tray, resting on the floor.
        expect(Math.abs(f[o] as number)).toBeLessThan(tray.w / 2);
        expect(Math.abs(f[o + 2] as number)).toBeLessThan(tray.d / 2);
        expect(f[o + 1] as number).toBeGreaterThan(0);
        expect(f[o + 1] as number).toBeLessThan(2);
        const q = new Quaternion(f[o + 3], f[o + 4], f[o + 5], f[o + 6]);
        // Any value the server might have decided: the remapped pose shows it.
        const values = s.kind === "d10" ? [1, 5, 10] : [1, s.faces.length];
        for (const want of values) {
          const S = remap(s, res.landed[i] as number, markerFor(s, want));
          const shown = landedMarker(s, q.clone().multiply(S));
          expect(s.labels[shown]).toBe(s.kind === "d10" ? want % 10 : want);
        }
      }
      // Contacts to clack with (each against the tray or another die), masses to scale them by, and when each die
      // comes to rest (its settle tick).
      expect(res.contacts.length).toBeGreaterThan(0);
      expect(res.contacts.every((c) => c.other === "tray" || c.other === "die")).toBe(true);
      expect(res.contacts.some((c) => c.other === "tray")).toBe(true);
      expect(res.masses.length).toBe(n);
      expect(res.masses.every((m) => m > 0)).toBe(true);
      expect(res.restStep.every((k) => k > 0 && k <= res.steps)).toBe(true);
    }
    expect(throws).toBe(60);
    // Every throw rests within the cap; a lively tumble, from about a second to at most 2.5 s (§8.9).
    expect(settled).toBe(60);
    times.sort((a, b) => a - b);
    expect(times[0] as number).toBeGreaterThanOrEqual(0.9);
    expect(times[times.length - 1] as number).toBeLessThanOrEqual(2.5);
    expect(times[Math.floor(times.length / 2)] as number).toBeGreaterThanOrEqual(1.15);
  });
});
