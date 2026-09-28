import { create } from "zustand";
import { useSettings } from "../state/settings.ts";
import { logSound } from "../test/hooks.ts";
import { RECIPES, type SfxName } from "./recipes.ts";

export type Channel = "master" | "dice" | "effects" | "ui" | "music" | "ambience";
export const CHANNELS: Channel[] = ["master", "dice", "effects", "ui", "music", "ambience"];

interface AudioStatus {
  /** "locked": the browser is blocking audio until a gesture (show the enable-sound chip, AC-AUD-04). */
  state: "idle" | "locked" | "running" | "unavailable";
  set(s: AudioStatus["state"]): void;
}
export const useAudioStatus = create<AudioStatus>((set) => ({
  state: "idle",
  set: (state) => set({ state }),
}));

export interface PlayOptions {
  /** Screen-space pan −1…1 (mapped to −0.8…0.8, SPEC §25.1). Board sounds only. */
  pan?: number;
  /** Distance from the camera target in feet → gain 1/(1 + d/60). */
  distanceFt?: number;
  /** Extra gain multiplier (e.g. dice impulse). */
  gain?: number;
  /** Playback-rate factor; defaults to ±4 % random variation. */
  rate?: number;
}

/**
 * The Web Audio graph (SPEC §25.1): AudioContext → master gain → gentle compressor → destination, with channel
 * gains for dice, effects, UI, music and ambience. Everything is synthesized locally (P1: no audio files).
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private channels = new Map<Channel, GainNode>();
  private noise = new Map<"white" | "pink" | "brown", AudioBuffer>();
  private unlockBound = false;

  /** Creates the context lazily (first call happens inside a user gesture wherever possible). */
  ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) {
      useAudioStatus.getState().set("unavailable");
      return null;
    }
    const ctx = new Ctor({ latencyHint: "interactive" });
    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);
    for (const c of CHANNELS) {
      if (c === "master") continue;
      const g = ctx.createGain();
      g.connect(master);
      this.channels.set(c, g);
    }
    this.ctx = ctx;
    this.master = master;
    this.applyVolumes();
    useSettings.subscribe(() => this.applyVolumes());
    useAudioStatus.getState().set(ctx.state === "running" ? "running" : "locked");
    ctx.addEventListener("statechange", () => {
      useAudioStatus.getState().set(ctx.state === "running" ? "running" : "locked");
    });
    return ctx;
  }

  /** Resumes on the first user gesture anywhere in the app (SPEC §8.17 Audio unlock). */
  bindUnlock(): void {
    if (this.unlockBound || typeof window === "undefined") return;
    this.unlockBound = true;
    const unlock = () => {
      void this.resume();
    };
    for (const ev of ["pointerdown", "keydown", "touchend"])
      window.addEventListener(ev, unlock, { capture: true, passive: true });
  }

  async resume(): Promise<boolean> {
    const ctx = this.ensure();
    if (!ctx) return false;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        // stays locked; the enable-sound chip remains
      }
    }
    return ctx.state === "running";
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master) return;
    const s = useSettings.getState();
    const now = this.ctx.currentTime;
    const masterOn = !s.muted && !s.channelMuted.master;
    this.master.gain.setTargetAtTime(masterOn ? s.volumes.master : 0, now, 0.02);
    for (const [c, g] of this.channels) {
      const v = s.channelMuted[c] ? 0 : s.volumes[c];
      g.gain.setTargetAtTime(v, now, 0.02);
    }
  }

  channel(c: Exclude<Channel, "master">): GainNode | null {
    this.ensure();
    return this.channels.get(c) ?? null;
  }

  /** Loopable 10-s noise buffers (white, pink, brown), generated once (SPEC §25.4). */
  noiseBuffer(kind: "white" | "pink" | "brown"): AudioBuffer {
    const ctx = this.ensure() as AudioContext;
    const cached = this.noise.get(kind);
    if (cached) return cached;
    const len = ctx.sampleRate * 10;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === "white") d[i] = w * 0.5;
      else if (kind === "pink") {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    this.noise.set(kind, buf);
    return buf;
  }

  /**
   * Plays a synthesized sound on its channel. Returns false while audio is locked or disabled. Every attempt is
   * recorded in the test-build sound log (with whether it actually sounded), so journeys can assert on cues.
   */
  play(name: SfxName, opts: PlayOptions = {}): boolean {
    const played = this.render(name, opts);
    logSound(name, played, opts.gain);
    return played;
  }

  private render(name: SfxName, opts: PlayOptions): boolean {
    const ctx = this.ensure();
    if (ctx?.state !== "running") return false;
    const recipe = RECIPES[name];
    const bus = this.channels.get(recipe.channel);
    if (!bus) return false;
    let dest: AudioNode = bus;
    if (recipe.channel !== "ui" && (opts.pan !== undefined || opts.distanceFt !== undefined)) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-0.8, Math.min(0.8, (opts.pan ?? 0) * 0.8));
      const dist = ctx.createGain();
      dist.gain.value = 1 / (1 + Math.max(0, opts.distanceFt ?? 0) / 60);
      pan.connect(dist).connect(bus);
      dest = pan;
    }
    if (opts.gain !== undefined && opts.gain !== 1) {
      const g = ctx.createGain();
      g.gain.value = opts.gain;
      g.connect(dest);
      dest = g;
    }
    const rate = opts.rate ?? 1 + (Math.random() * 2 - 1) * recipe.variation;
    recipe.play(ctx, dest, ctx.currentTime + 0.005, rate, this);
    return true;
  }
}

export const audio = new AudioEngine();
export type { AudioEngine };
