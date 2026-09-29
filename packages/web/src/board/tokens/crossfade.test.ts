import { describe, expect, it } from "vitest";
import { frameDelta, setFrameDelta } from "../frames.ts";
import { AUTO_COIN_PITCH, approach, CROSSFADE_S, crossfadeStep, fadeFrame } from "./crossfade.ts";

describe("auto mode crossfade (AC-TOK-11)", () => {
  it("switches at 70° and crossfades linearly over 200 ms, whatever the frame rate", () => {
    expect(AUTO_COIN_PITCH).toBe(70);
    expect(CROSSFADE_S).toBe(0.2);
    for (const frameMs of [8, 16.7, 33, 50]) {
      let w = 0;
      let t = 0;
      while (w < 1) {
        w = crossfadeStep(w, 1, frameMs / 1000);
        t += frameMs;
      }
      // Done on the first frame at or after 200 ms.
      expect(t).toBeGreaterThanOrEqual(200 - 1e-9);
      expect(t).toBeLessThan(200 + frameMs);
    }
    // And back.
    let w = 1;
    for (let i = 0; i < 6; i++) w = crossfadeStep(w, 0, 1 / 30);
    expect(w).toBeCloseTo(0, 9);
    // Reversing mid-fade continues from where it is (no jump).
    expect(crossfadeStep(0.4, 0, 0.02)).toBeCloseTo(0.3, 9);
  });

  it("a settled fade stays settled (no dip toward the other end on every frame)", () => {
    // A fade at its target must not move: a dip there made settled overlays and coins flicker on every redraw,
    // and kept the board rendering forever.
    for (const dt of [1 / 60, 0.05, 0.25]) {
      expect(crossfadeStep(1, 1, dt)).toBe(1);
      expect(crossfadeStep(0, 0, dt)).toBe(0);
      expect(approach(1, 1, dt / 0.15)).toBe(1);
      expect(approach(0.5, 0.5, 10)).toBe(0.5);
    }
    // It lands exactly on the target (no overshoot), from either side, and partial targets work.
    expect(approach(0.95, 1, 0.2)).toBe(1);
    expect(approach(0.05, 0, 0.2)).toBe(0);
    expect(approach(0, 0.4, 1)).toBe(0.4);
    expect(approach(1, 0.4, 0.25)).toBe(0.75);
  });

  it("the first frame after an idle pause steps a nominal 1/60 s, not the whole pause", () => {
    setFrameDelta(4.2, false); // 4.2 s since the last frame, board was idle
    expect(frameDelta()).toBeCloseTo(1 / 60, 9);
    expect(crossfadeStep(0, 1, frameDelta())).toBeLessThan(0.1);
    setFrameDelta(0.05, true);
    expect(frameDelta()).toBe(0.05);
    setFrameDelta(3, true); // a very slow continuous frame is capped
    expect(frameDelta()).toBe(0.25);
  });

  it("a fade starts on the frame its target changes — the time before the change isn't spent on it", () => {
    // A paced ambient frame 250 ms after the last one sees the camera tipped past 70°: the fade begins there (still 0),
    // then runs over the next frames — before, it finished in that one frame and the crossfade was never drawn.
    let f = fadeFrame({ w: 0, want: 0 }, 1, 0.25);
    expect(f).toEqual({ w: 0, want: 1 });
    f = fadeFrame(f, 1, 0.05);
    expect(f.w).toBeCloseTo(0.25, 9);
    f = fadeFrame(f, 1, 0.05);
    expect(f.w).toBeCloseTo(0.5, 9);
    // Reversed mid-fade: that frame holds where it is, then it heads back.
    f = fadeFrame(f, 0, 0.25);
    expect(f).toEqual({ w: 0.5, want: 0 });
    f = fadeFrame(f, 0, 0.05);
    expect(f.w).toBeCloseTo(0.25, 9);
    // A steady target just steps.
    expect(fadeFrame({ w: 1, want: 1 }, 1, 0.25)).toEqual({ w: 1, want: 1 });
  });
});
