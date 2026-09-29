import { create } from "zustand";
import { useSettings } from "../state/settings.ts";
import { logSound } from "../test/hooks.ts";
import { RECIPES, type Recipe, type SfxName } from "./recipes.ts";
import { genIR, lpf } from "./synth.ts";

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
  /** Playback-rate factor; defaults to the recipe's random variation (±4 % for most). */
  rate?: number;
  /** A stable number for a sound with a voice of its own (a door's id → its creak). */
  seed?: number;
  /** Seconds from now (a spell's element when its projectile lands). */
  delay?: number;
}

/** A settings slider (0–1) to a gain (sound.md §6.1): −48 dB across the travel, so its top half isn't dead. */
export function sliderGain(s: number): number {
  return s <= 0 ? 0 : 10 ** ((-48 * (1 - Math.min(1, s))) / 20);
}

/** A board sound's stereo position: its screen pan (−1…1) mapped into ±0.8, never hard left or right (§25.1). */
export function stereoPan(pan: number): number {
  return Math.max(-0.8, Math.min(0.8, pan * 0.8));
}

/** A board sound's loudness by its distance (ft) from the camera's target: 1/(1 + d/60) (§25.1, sound.md §6.5). */
export function distanceGain(distanceFt: number): number {
  return 1 / (1 + Math.max(0, distanceFt) / 60);
}

/** Voices a channel sounds at once (sound.md §6.6); a hero sound is never the one dropped. */
const VOICE_CAP: Record<"dice" | "effects" | "ui", number> = { dice: 16, effects: 12, ui: 6 };

/**
 * The Web Audio graph (SPEC §25.1, docs/research/sound.md §6.1): channel gains for dice, effects, UI, music and
 * ambience into a master gain → a gentle compressor → a safety limiter → the speakers. Dice, effects and UI also feed
 * a generated 1.8-s stone-hall reverb through post-fader taps (muting a channel mutes its reverb too). Music passes a
 * ducking gain ("Your turn" and a knock dip it 4 dB). Everything is synthesized locally (P1: no audio files).
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private channels = new Map<Channel, GainNode>();
  private reverbTaps = new Map<Channel, GainNode>();
  private musicDuck: GainNode | null = null;
  private noise = new Map<"white" | "pink" | "brown", AudioBuffer>();
  private voices = new Map<Channel, number[]>();
  /** Test builds: a meter on each channel's output (after its fader) and on the master's. */
  private meters = new Map<Channel, AnalyserNode>();
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
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    master.connect(comp).connect(limiter).connect(ctx.destination);
    const reverb = ctx.createConvolver();
    reverb.normalize = true;
    reverb.buffer = genIR(ctx, 1.8, 1);
    reverb.connect(master);
    const duck = ctx.createGain();
    duck.connect(master);
    for (const c of CHANNELS) {
      if (c === "master") continue;
      const g = ctx.createGain();
      g.connect(c === "music" ? duck : master);
      this.channels.set(c, g);
      if (c === "dice" || c === "effects" || c === "ui") {
        const tap = ctx.createGain();
        tap.connect(reverb);
        this.reverbTaps.set(c, tap);
      }
    }
    if (__GLOAM_TEST__)
      for (const c of CHANNELS) {
        const a = ctx.createAnalyser();
        a.fftSize = 2048;
        (c === "master" ? master : (this.channels.get(c) as GainNode)).connect(a);
        this.meters.set(c, a);
      }
    this.ctx = ctx;
    this.master = master;
    this.musicDuck = duck;
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
    this.master.gain.setTargetAtTime(masterOn ? sliderGain(s.volumes.master) : 0, now, 0.02);
    for (const [c, g] of this.channels) {
      const v = s.channelMuted[c] ? 0 : sliderGain(s.volumes[c]);
      g.gain.setTargetAtTime(v, now, 0.02);
      this.reverbTaps.get(c)?.gain.setTargetAtTime(v, now, 0.02);
    }
  }

  channel(c: Exclude<Channel, "master">): GainNode | null {
    this.ensure();
    return this.channels.get(c) ?? null;
  }

  /** Where a music or ambience source connects: its channel's input. */
  input(c: "music" | "ambience"): GainNode | null {
    return this.channel(c);
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
      // Full scale, as the level plan measured it (sound.md §2.7): white noise is uniform on ±1.
      if (kind === "white") d[i] = w;
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
   * Plays a synthesized sound on its channel. Returns false while audio is locked or disabled, or when its channel is
   * at its voice cap. Every attempt is recorded in the test-build sound log (with whether it actually sounded and
   * where), so journeys can assert on cues.
   */
  play(name: SfxName, opts: PlayOptions = {}): boolean {
    const played = this.render(name, opts);
    logSound(name, played, opts);
    return played;
  }

  /** Test builds: the peak on a channel's output over the last ~43 ms (0 when silent or muted). */
  meter(c: Channel): number {
    const a = this.meters.get(c);
    if (!a) return 0;
    const d = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(d);
    let peak = 0;
    for (const v of d) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  /** Dips the music 4 dB for a moment so a cue is heard without being loud (sound.md §6.6). */
  duck(): void {
    const ctx = this.ctx;
    const g = this.musicDuck;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0.63, t, 0.05);
    g.gain.setTargetAtTime(1, t + 1.2, 0.3);
  }

  /**
   * A die tumbling (sound.md §2.1 "rolls/slides"): one quiet brown-noise friction bed per throw whose level follows the
   * dice's angular speed. `set(level 0–1)` each frame; `stop()` 150 ms after the last die sleeps.
   */
  rumble(pan = 0): { set(level: number): void; stop(): void } | null {
    const ctx = this.ensure();
    const bus = this.channels.get("dice");
    logSound("diceRumble", ctx?.state === "running");
    if (ctx?.state !== "running" || !bus) return null;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer("brown");
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 80;
    hp.Q.value = -3;
    const g = ctx.createGain();
    g.gain.value = 0;
    const out = ctx.createGain();
    out.gain.value = 0.08;
    const p = ctx.createStereoPanner();
    p.pan.value = stereoPan(pan);
    src.connect(hp).connect(lpf(ctx, 700)).connect(g).connect(out).connect(p).connect(bus);
    src.start(ctx.currentTime, Math.random() * 9);
    let stopped = false;
    return {
      set(level: number) {
        if (stopped) return;
        g.gain.setTargetAtTime(Math.max(0, Math.min(1, level)), ctx.currentTime, 0.03);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        src.stop(ctx.currentTime + 0.4);
        src.onended = () => {
          for (const n of [src, hp, g, out, p]) n.disconnect();
        };
      },
    };
  }

  private render(name: SfxName, opts: PlayOptions): boolean {
    const ctx = this.ensure();
    if (ctx?.state !== "running") return false;
    const recipe: Recipe = RECIPES[name];
    const bus = this.channels.get(recipe.channel);
    if (!bus) return false;
    const t = ctx.currentTime + 0.005 + Math.max(0, opts.delay ?? 0);
    // The channel's voice cap: a sound that would pass it is dropped, unless it's a hero sound.
    const live = (this.voices.get(recipe.channel) ?? []).filter((end) => end > ctx.currentTime);
    if (live.length >= VOICE_CAP[recipe.channel] && !recipe.hero) {
      this.voices.set(recipe.channel, live);
      return false;
    }
    live.push(t + recipe.dur);
    this.voices.set(recipe.channel, live);
    // After the recipe: [pan → distance] → the channel, and the reverb send (post-fader) where the recipe has one.
    const post = ctx.createGain();
    post.connect(bus);
    if (recipe.reverb) {
      const send = ctx.createGain();
      send.gain.value = recipe.reverb;
      post.connect(send).connect(this.reverbTaps.get(recipe.channel) as GainNode);
    }
    let dest: AudioNode = post;
    if (opts.pan !== undefined || opts.distanceFt !== undefined) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = stereoPan(opts.pan ?? 0);
      const dist = ctx.createGain();
      dist.gain.value = distanceGain(opts.distanceFt ?? 0);
      pan.connect(dist).connect(post);
      dest = pan;
    }
    if (opts.gain !== undefined && opts.gain !== 1) {
      const g = ctx.createGain();
      g.gain.value = opts.gain;
      g.connect(dest);
      dest = g;
    }
    const rate = opts.rate ?? 1 + (Math.random() * 2 - 1) * recipe.variation;
    recipe.play(ctx, dest, t, rate, this, opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    return true;
  }
}

export const audio = new AudioEngine();
export type { AudioEngine };
