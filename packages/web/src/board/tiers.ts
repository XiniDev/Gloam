import { create } from "zustand";
import { useSettings } from "../state/settings.ts";

/** Performance tiers (SPEC §24.6). */
export type TierName = "ultra" | "high" | "medium" | "low";
export const TIER_ORDER: TierName[] = ["low", "medium", "high", "ultra"];

export interface TierSpec {
  name: TierName;
  /** Device-pixel-ratio cap. */
  dpr: number;
  /** Shadow map size; 0 = blob shadows only. */
  shadowMap: 0 | 1024 | 2048;
  softShadows: boolean;
  bloom: "full" | "half" | false;
  ao: boolean;
  smaa: boolean;
  pointLights: number;
  fogPxPerFt: number;
  /** War fog drift: frames per second spent on it (0: still). */
  fogDriftFps: number;
  /** Light flicker: frames per second spent on it. */
  flickerFps: number;
  particles: number;
  /** Largest map texture this tier loads (AC-BRD-06, with the device's MAX_TEXTURE_SIZE). */
  textureCap: number;
  /** Dust motes drifting through the key light. */
  dust: number;
}

export const TIERS: Record<TierName, TierSpec> = {
  ultra: {
    name: "ultra",
    dpr: 2,
    shadowMap: 2048,
    softShadows: true,
    bloom: "full",
    ao: true,
    smaa: true,
    pointLights: 8,
    fogPxPerFt: 6,
    fogDriftFps: 24,
    flickerFps: 30,
    particles: 1,
    textureCap: 8192,
    dust: 160,
  },
  high: {
    name: "high",
    dpr: 1.75,
    shadowMap: 2048,
    softShadows: false,
    bloom: "full",
    ao: false,
    smaa: true,
    pointLights: 4,
    fogPxPerFt: 4,
    fogDriftFps: 16,
    flickerFps: 24,
    particles: 0.7,
    textureCap: 8192,
    dust: 110,
  },
  medium: {
    name: "medium",
    dpr: 1.5,
    shadowMap: 1024,
    softShadows: false,
    bloom: "half",
    ao: false,
    smaa: false,
    pointLights: 2,
    fogPxPerFt: 3,
    fogDriftFps: 8,
    flickerFps: 12,
    particles: 0.4,
    textureCap: 4096,
    dust: 60,
  },
  low: {
    name: "low",
    dpr: 1,
    shadowMap: 0,
    softShadows: false,
    bloom: false,
    ao: false,
    smaa: false,
    pointLights: 0,
    fogPxPerFt: 2,
    fogDriftFps: 0,
    flickerFps: 4,
    particles: 0.2,
    textureCap: 2048,
    dust: 0,
  },
};

export interface DeviceProfile {
  maxTexture: number;
  cores: number;
  memoryGb: number;
  touch: boolean;
  software: boolean;
  renderer: string;
}

/** Reads the device heuristics §8.4 names (texture limit, cores, memory, touch, software rendering). */
export function probeDevice(gl: WebGLRenderingContext | WebGL2RenderingContext): DeviceProfile {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(
    (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "",
  );
  return {
    maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
    cores: nav.hardwareConcurrency || 4,
    memoryGb: nav.deviceMemory ?? 8,
    touch: matchMedia("(pointer: coarse)").matches,
    software: /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(renderer),
    renderer,
  };
}

/** The starting tier from the device profile; runtime adaptation corrects it from measured frame times. */
export function initialTier(d: DeviceProfile): TierName {
  if (d.software) return "low";
  if (d.touch) return d.memoryGb >= 6 && d.cores >= 8 ? "medium" : "low";
  if (d.maxTexture >= 16384 && d.cores >= 8 && d.memoryGb >= 8) return "high";
  if (d.maxTexture >= 8192 && d.cores >= 4) return "medium";
  return "low";
}

interface TierStore {
  name: TierName;
  /** "auto" follows the governor; otherwise the user pinned this tier in settings. */
  pinned: boolean;
  device: DeviceProfile | null;
  /** Why the current tier was chosen (shown in the perf overlay and test hooks). */
  reason: string;
  fps: number;
  set(p: Partial<Omit<TierStore, "set">>): void;
}

export const useTier = create<TierStore>((set) => ({
  name: "medium",
  pinned: false,
  device: null,
  reason: "default",
  fps: 0,
  set: (p) => set(p),
}));

export const tierSpec = () => TIERS[useTier.getState().name];

/** Applies the device profile and the user's pin (settings.tier). */
export function chooseTier(device: DeviceProfile): void {
  const pin = useSettings.getState().tier;
  if (pin !== "auto")
    useTier.getState().set({ device, name: pin, pinned: true, reason: "pinned in settings" });
  else useTier.getState().set({ device, name: initialTier(device), pinned: false, reason: "device profile" });
}

/**
 * Runtime adaptation (SPEC §8.4): step down after 3 s below target, step up after 10 s comfortably above. The first
 * second after start is judged on its own: a slow start drops a tier at once.
 */
export class TierGovernor {
  private below = 0;
  private above = 0;
  private sinceStart = 0;
  private startFrames = 0;
  private frames = 0;
  private acc = 0;
  private frameAcc = 0;
  private readonly target: number;
  /** Test hook: a forced frame time in ms (null = measured). */
  static forcedMs: number | null = null;

  constructor(targetFps = 55) {
    this.target = targetFps;
  }

  /**
   * Feed one frame's duration (seconds). Returns a tier change, if any. The windows (first second, 3 s below, 10 s
   * above) run on real elapsed time; a test's forced frame time replaces only the measured frame duration.
   */
  tick(dt: number): TierName | null {
    const store = useTier.getState();
    const real = Math.min(dt, 0.5);
    const frame = TierGovernor.forcedMs !== null ? TierGovernor.forcedMs / 1000 : real;
    this.frames++;
    this.acc += real;
    this.frameAcc += frame;
    if (this.acc >= 0.5) {
      store.set({ fps: Math.round(this.frames / this.frameAcc) });
      this.frames = 0;
      this.acc = 0;
      this.frameAcc = 0;
    }
    if (store.pinned) return null;
    const fps = 1 / Math.max(frame, 1e-3);
    if (this.sinceStart < 1) {
      this.sinceStart += real;
      this.startFrames++;
      // A slow start drops a tier at once: under 24 frames in the first second (or slow forced frames).
      if (this.sinceStart >= 1 && (this.startFrames < 24 || fps < 24))
        return this.step(-1, "slow first second");
      return null;
    }
    if (fps < this.target * 0.85) {
      this.below += real;
      this.above = 0;
    } else if (fps > this.target * 1.1) {
      this.above += real;
      this.below = 0;
    } else {
      this.below = Math.max(0, this.below - real);
      this.above = Math.max(0, this.above - real);
    }
    if (this.below >= 3) return this.step(-1, "below target for 3 s");
    if (this.above >= 10) return this.step(1, "comfortably above target for 10 s");
    return null;
  }

  private step(dir: -1 | 1, reason: string): TierName | null {
    this.below = 0;
    this.above = 0;
    const store = useTier.getState();
    const i = TIER_ORDER.indexOf(store.name) + dir;
    const next = TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, i))] as TierName;
    if (next === store.name) return null;
    store.set({ name: next, reason });
    return next;
  }
}
