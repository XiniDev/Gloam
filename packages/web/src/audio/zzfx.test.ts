import { describe, expect, it } from "vitest";
import { buildSamples, type ZzfxParams } from "./zzfx.ts";

/** Parity with the pinned npm package (zzfx@1.3.2), whose module creates an AudioContext at import time. */
async function reference(): Promise<{ build: (...p: number[]) => number[] }> {
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {};
  const mod = (await import("zzfx")) as unknown as {
    ZZFX: { buildSamples: (...p: number[]) => number[]; volume: number; sampleRate: number };
  };
  return { build: (...p) => mod.ZZFX.buildSamples.call({ ...mod.ZZFX, volume: 1, sampleRate: 48000 }, ...p) };
}

const RECIPES: ZzfxParams[] = [
  [0.124, 0, 220, 0.001, 0, 0.06, 1, 0.6, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0.4, 0.012, 0, -700],
  [0.3, 0, 440, 0.01, 0.05, 0.2, 0, 1, 0, 0, 100, 0.05, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  [0.2, 0, 900, 0, 0.02, 0.1, 2, 1.5, 3, 0, 0, 0, 0.06, 0.2, 5, 0, 0.03, 0.8, 0.02, 0.3, 1200],
  [0.1, 0, 1400, 0, 0, 0.03, 4, 1, 0, 0, 0, 0, 0, 0.5, 0, 0.1, 0, 1, 0, 0, 0],
  [0.5, 0, 150, 0.02, 0.1, 0.3, 5, 0.3, -2, 0.1, 0, 0, 0.1, 0, 2, 0, 0, 0.6, 0.05, 0.1, -300],
];

describe("vendored ZzFX buildSamples", () => {
  it("matches zzfx@1.3.2 sample for sample (randomness 0, volume scale 1)", async () => {
    const ref = await reference();
    for (const p of RECIPES) {
      const mine = buildSamples(p, 48000);
      const theirs = ref.build(...(p as number[]));
      expect(mine.length).toBe(theirs.length);
      let maxDiff = 0;
      for (let i = 0; i < mine.length; i++)
        maxDiff = Math.max(maxDiff, Math.abs((mine[i] ?? 0) - (theirs[i] ?? 0)));
      expect(maxDiff).toBeLessThan(1e-6);
    }
  });
});
