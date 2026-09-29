import { describe, expect, it } from "vitest";
import { distanceGain, sliderGain, stereoPan } from "./engine.ts";
import { integratedLufs, measureSamples } from "./measure.ts";

describe("audio levels (sound.md §6)", () => {
  it("measures a full-scale 997 Hz sine at 0 dBFS peak and −3.01 LUFS (BS.1770's reference)", () => {
    const sr = 48000;
    const x = new Float32Array(sr * 2);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 997 * i) / sr);
    const m = measureSamples(x, sr);
    expect(m.peakDb).toBeCloseTo(0, 2);
    expect(m.lufsM).toBeCloseTo(-3.01, 1);
    // 20 dB down reads 20 dB down; silence reads −∞.
    const quiet = x.map((v) => v / 10);
    expect(measureSamples(quiet, sr).lufsM).toBeCloseTo(-23.01, 1);
    expect(measureSamples(new Float32Array(sr), sr).peakDb).toBe(Number.NEGATIVE_INFINITY);
  });

  it("measures a recording's integrated loudness (gated): a −20 dBFS 997 Hz sine in both channels reads −20 LUFS; silence gaps don't pull it down", () => {
    const sr = 48000;
    const x = new Float32Array(sr * 6);
    for (let i = 0; i < x.length; i++) x[i] = i < sr * 3 ? 0.1 * Math.sin((2 * Math.PI * 997 * i) / sr) : 0;
    // Two channels: +3 dB over one (−23 + 3 = −20).
    expect(integratedLufs([x, x], sr)).toBeCloseTo(-20.0, 0);
  });

  it("places a board sound: its screen side into ±0.8 of pan, and 1/(1 + d/60) by its distance (AC-AUD-05)", () => {
    expect(stereoPan(-1)).toBeCloseTo(-0.8);
    expect(stereoPan(0.5)).toBeCloseTo(0.4);
    expect(stereoPan(3)).toBeCloseTo(0.8);
    expect(distanceGain(0)).toBe(1);
    expect(20 * Math.log10(distanceGain(60))).toBeCloseTo(-6.02, 1);
    expect(20 * Math.log10(distanceGain(120))).toBeCloseTo(-9.54, 1);
    expect(distanceGain(-5)).toBe(1);
  });

  it("maps the settings sliders through −48 dB of travel (0.9375 → −3 dB, 0.5 → −24 dB, 0 → silence)", () => {
    const db = (s: number) => 20 * Math.log10(sliderGain(s));
    expect(sliderGain(1)).toBe(1);
    expect(db(0.9375)).toBeCloseTo(-3, 5);
    expect(db(0.875)).toBeCloseTo(-6, 5);
    expect(db(0.5)).toBeCloseTo(-24, 5);
    expect(sliderGain(0)).toBe(0);
  });
});
