import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettings } from "../state/settings.ts";
import { chooseTier, type DeviceProfile, initialTier, TIERS, TierGovernor, useTier } from "./tiers.ts";

const device = (p: Partial<DeviceProfile>): DeviceProfile => ({
  maxTexture: 16384,
  cores: 8,
  memoryGb: 8,
  touch: false,
  software: false,
  renderer: "test",
  ...p,
});

/** Feeds `seconds` of frames of `frameMs` each; returns every tier change. */
function run(g: TierGovernor, frameMs: number, seconds: number): string[] {
  const out: string[] = [];
  for (let t = 0; t < seconds * 1000 - 1e-6; t += frameMs) {
    const c = g.tick(frameMs / 1000);
    if (c) out.push(c);
  }
  return out;
}

describe("performance tiers (AC-BRD-03)", () => {
  beforeEach(() => {
    useSettings.getState().update({ tier: "auto" });
    useTier.getState().set({ name: "medium", pinned: false, reason: "default" });
    TierGovernor.forcedMs = null;
  });
  afterEach(() => {
    TierGovernor.forcedMs = null;
  });

  it("chooses the starting tier from the device heuristics (§8.4)", () => {
    expect(initialTier(device({ software: true }))).toBe("low");
    expect(initialTier(device({}))).toBe("high");
    expect(initialTier(device({ maxTexture: 8192, cores: 4 }))).toBe("medium");
    expect(initialTier(device({ maxTexture: 4096, cores: 2, memoryGb: 2 }))).toBe("low");
    expect(initialTier(device({ touch: true, memoryGb: 8, cores: 8 }))).toBe("medium");
    expect(initialTier(device({ touch: true, memoryGb: 4, cores: 8 }))).toBe("low");
  });

  it("a user's pin wins over the device; Auto hands it back", () => {
    useSettings.getState().update({ tier: "ultra" });
    chooseTier(device({ software: true }));
    expect(useTier.getState()).toMatchObject({ name: "ultra", pinned: true, reason: "pinned in settings" });
    useSettings.getState().update({ tier: "auto" });
    chooseTier(device({ software: true }));
    expect(useTier.getState()).toMatchObject({ name: "low", pinned: false, reason: "device profile" });
  });

  it("Low turns off shadow maps, bloom and ambient occlusion and caps DPR at 1; tiers step up in features", () => {
    expect(TIERS.low).toMatchObject({ shadowMap: 0, bloom: false, ao: false, dpr: 1 });
    expect(TIERS.medium.shadowMap).toBeGreaterThan(0);
    expect(TIERS.high.bloom).toBe("full");
    expect(TIERS.ultra).toMatchObject({ ao: true, softShadows: true });
  });

  it("steps down after 3 s below target and up after 10 s comfortably above", () => {
    const g = new TierGovernor(55);
    expect(run(g, 16, 1)).toEqual([]); // a healthy first second
    expect(run(g, 33, 2.9)).toEqual([]); // 30 fps: below, but not yet 3 s
    expect(run(g, 33, 0.2)).toEqual(["low"]);
    expect(useTier.getState().reason).toBe("below target for 3 s");
    expect(run(g, 8, 9.9)).toEqual([]); // 125 fps: above, but not yet 10 s
    expect(run(g, 8, 0.2)).toEqual(["medium"]);
    expect(useTier.getState().reason).toBe("comfortably above target for 10 s");
    // Brief dips don't count as "below for 3 s": the window drains while frames are on target.
    expect(run(g, 33, 2)).toEqual([]);
    expect(run(g, 18, 3)).toEqual([]);
    expect(run(g, 33, 2)).toEqual([]);
    expect(useTier.getState().name).toBe("medium");
  });

  it("judges the first second on its own: a slow start drops a tier at once", () => {
    const g = new TierGovernor(55);
    // Ten 100 ms frames sum to 0.999…: the drop lands on the frame that completes the second.
    expect(run(g, 100, 1.1)).toEqual(["low"]);
    expect(useTier.getState().reason).toBe("slow first second");
  });

  it("never changes a pinned tier", () => {
    useTier.getState().set({ name: "high", pinned: true });
    const g = new TierGovernor(55);
    expect(run(g, 200, 20)).toEqual([]);
    expect(useTier.getState().name).toBe("high");
  });

  it("a forced frame time (test hook) sets the measured rate; the windows still run on real time", () => {
    const g = new TierGovernor(55);
    run(g, 16, 1);
    TierGovernor.forcedMs = 5; // 200 fps, while real frames take 200 ms
    expect(run(g, 200, 9.8)).toEqual([]);
    expect(run(g, 200, 0.4)).toEqual(["high"]);
  });
});
