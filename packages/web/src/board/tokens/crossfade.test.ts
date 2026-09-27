import { describe, expect, it } from "vitest";
import { frameDelta, setFrameDelta } from "../frames.ts";
import { AUTO_COIN_PITCH, CROSSFADE_S, crossfadeStep } from "./crossfade.ts";

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

  it("the first frame after an idle pause steps a nominal 1/60 s, not the whole pause", () => {
    setFrameDelta(4.2, false); // 4.2 s since the last frame, board was idle
    expect(frameDelta()).toBeCloseTo(1 / 60, 9);
    expect(crossfadeStep(0, 1, frameDelta())).toBeLessThan(0.1);
    setFrameDelta(0.05, true);
    expect(frameDelta()).toBe(0.05);
    setFrameDelta(3, true); // a very slow continuous frame is capped
    expect(frameDelta()).toBe(0.25);
  });
});
