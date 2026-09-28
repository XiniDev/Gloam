import type { AudioEngine, Channel } from "./engine.ts";
import { buildSamples, type ZzfxParams } from "./zzfx.ts";

/**
 * Sound recipes (SPEC §31, recipes from docs/research/sound.md §2). "WA" recipes are small Web Audio graphs;
 * "ZzFX" recipes render once into a cached buffer. Each plays into `dest` starting at `t`.
 */
export interface Recipe {
  channel: Exclude<Channel, "master">;
  /** Per-play pitch variation (±4 % by default, SPEC §25.2). */
  variation: number;
  play(ctx: AudioContext, dest: AudioNode, t: number, rate: number, engine: AudioEngine): void;
}

const bufferCache = new Map<string, AudioBuffer>();

function zzfxBuffer(
  ctx: BaseAudioContext,
  key: string,
  layers: { at: number; p: ZzfxParams }[],
): AudioBuffer {
  const cached = bufferCache.get(key);
  if (cached && cached.sampleRate === ctx.sampleRate) return cached;
  const parts = layers.map((l) => ({
    off: Math.round((l.at / 1000) * ctx.sampleRate),
    s: buildSamples(l.p, ctx.sampleRate),
  }));
  const len = Math.max(1, ...parts.map((p) => p.off + p.s.length));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (const p of parts)
    for (let i = 0; i < p.s.length; i++) ch[p.off + i] = (ch[p.off + i] ?? 0) + (p.s[i] ?? 0);
  bufferCache.set(key, buf);
  return buf;
}

function zzfx(
  key: string,
  channel: Recipe["channel"],
  layers: { at: number; p: ZzfxParams }[],
  variation = 0.04,
): Recipe {
  return {
    channel,
    variation,
    play(ctx, dest, t, rate) {
      const src = ctx.createBufferSource();
      src.buffer = zzfxBuffer(ctx, key, layers);
      src.playbackRate.value = rate;
      src.connect(dest);
      src.start(t);
      src.onended = () => src.disconnect();
    },
  };
}

/** env(A, P, τ): linear attack to P, then exponential decay with time constant τ. */
function env(ctx: BaseAudioContext, t: number, a: number, p: number, tau: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(p, t + a);
  g.gain.setTargetAtTime(0, t + a, tau);
  return g;
}

function noiseSrc(
  ctx: AudioContext,
  engine: AudioEngine,
  kind: "white" | "pink" | "brown",
  t: number,
  dur: number,
) {
  const src = ctx.createBufferSource();
  src.buffer = engine.noiseBuffer(kind);
  src.loop = true;
  src.start(t, Math.random() * 9);
  src.stop(t + dur + 0.02);
  src.onended = () => src.disconnect();
  return src;
}

function bpf(ctx: BaseAudioContext, f: number, q: number): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = "bandpass";
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

/** Small-speaker exciter: tanh saturation + two high-passes so low thumps survive phone speakers. */
function exciter(
  ctx: BaseAudioContext,
  input: AudioNode,
  out: AudioNode,
  drive: number,
  fc: number,
  gain: number,
): void {
  const ws = ctx.createWaveShaper();
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  ws.curve = curve;
  ws.oversample = "2x";
  const h1 = ctx.createBiquadFilter();
  h1.type = "highpass";
  h1.frequency.value = fc;
  h1.Q.value = -3;
  const h2 = ctx.createBiquadFilter();
  h2.type = "highpass";
  h2.frequency.value = fc;
  h2.Q.value = -3;
  const g = ctx.createGain();
  g.gain.value = gain;
  input.connect(ws).connect(h1).connect(h2).connect(g).connect(out);
}

/** One knock on wood (sound.md §2.2). */
function knockOnce(
  ctx: AudioContext,
  engine: AudioEngine,
  out: AudioNode,
  t: number,
  k: number,
  g: number,
): void {
  const low = ctx.createOscillator();
  low.frequency.setValueAtTime(140 * k, t);
  low.frequency.exponentialRampToValueAtTime(100 * k, t + 0.04);
  const lowEnv = env(ctx, t, 0.001, g, 0.025);
  low.connect(lowEnv).connect(out);
  exciter(ctx, lowEnv, out, 4, 200, 1.0);
  const h = ctx.createOscillator();
  h.frequency.setValueAtTime(280 * k, t);
  h.frequency.exponentialRampToValueAtTime(200 * k, t + 0.04);
  h.connect(env(ctx, t, 0.001, 0.25 * g, 0.025)).connect(out);
  for (const [f, q, p, tau] of [
    [1200 * k, 1.5, 0.5, 0.003],
    [250 * k, 4, 0.8, 0.03],
    [395 * k, 4, 0.6, 0.03],
  ] as const) {
    noiseSrc(ctx, engine, "white", t, 0.25)
      .connect(bpf(ctx, f, q))
      .connect(env(ctx, t, tau < 0.01 ? 0.0003 : 0.001, p * g, tau))
      .connect(out);
  }
  for (const o of [low, h]) {
    o.start(t);
    o.stop(t + 0.3);
    o.onended = () => o.disconnect();
  }
}

/** Stick-slip door creak (Farnell) plus a latch (sound.md §2.2 "Admitted"). */
/** A door's creak alone: the body of creakAndLatch without its latch. */
function creak(ctx: AudioContext, engine: AudioEngine, out: AudioNode, t: number, dur: number): void {
  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  const pts = 16;
  for (let i = 0; i < pts; i++) {
    const u = i / (pts - 1);
    saw.frequency.setValueAtTime(
      (42 + 50 * Math.sin(u * Math.PI)) * (1 + (Math.random() * 2 - 1) * 0.12),
      t + u * dur,
    );
  }
  const body = ctx.createGain();
  for (const [f, q, g] of [
    [250, 2, 1],
    [560, 3, 0.6],
  ] as const) {
    const gg = ctx.createGain();
    gg.gain.value = g;
    saw
      .connect(bpf(ctx, f, q))
      .connect(gg)
      .connect(body);
  }
  const hiss = bpf(ctx, 1100, 10);
  noiseSrc(ctx, engine, "pink", t, dur).connect(hiss).connect(body);
  const e = ctx.createGain();
  e.gain.setValueAtTime(0, t);
  e.gain.linearRampToValueAtTime(1, t + 0.05);
  e.gain.setValueAtTime(1, t + dur - 0.1);
  e.gain.linearRampToValueAtTime(0, t + dur);
  body.connect(e).connect(out);
  saw.start(t);
  saw.stop(t + dur + 0.05);
  saw.onended = () => saw.disconnect();
}

function creakAndLatch(ctx: AudioContext, engine: AudioEngine, out: AudioNode, t: number, dur: number): void {
  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  const pts = 24;
  for (let i = 0; i < pts; i++) {
    const u = i / (pts - 1);
    const base = u < 0.55 ? 38 + (90 - 38) * (u / 0.55) : 90 - (90 - 55) * ((u - 0.55) / 0.45);
    saw.frequency.setValueAtTime(base * (1 + (Math.random() * 2 - 1) * 0.15), t + u * dur);
  }
  const body = ctx.createGain();
  for (const [f, q, g] of [
    [250, 2, 1],
    [395, 2, 0.8],
    [560, 3, 0.6],
    [790, 3, 0.4],
  ] as const) {
    const gg = ctx.createGain();
    gg.gain.value = g;
    saw
      .connect(bpf(ctx, f, q))
      .connect(gg)
      .connect(body);
  }
  const squeal = bpf(ctx, 900, 12);
  squeal.frequency.setValueAtTime(900, t);
  squeal.frequency.exponentialRampToValueAtTime(1600, t + dur * 0.55);
  squeal.frequency.exponentialRampToValueAtTime(1200, t + dur);
  const sg = ctx.createGain();
  sg.gain.value = 0.5;
  noiseSrc(ctx, engine, "pink", t, dur).connect(squeal).connect(sg).connect(body);
  const e = ctx.createGain();
  e.gain.setValueAtTime(0, t);
  e.gain.linearRampToValueAtTime(1, t + 0.06);
  e.gain.setValueAtTime(1, t + dur - 0.15);
  e.gain.linearRampToValueAtTime(0, t + dur);
  body.connect(e).connect(out);
  saw.start(t);
  saw.stop(t + dur + 0.05);
  saw.onended = () => saw.disconnect();
  const lt = t + 0.62;
  for (const off of [0, 0.025]) {
    noiseSrc(ctx, engine, "white", lt + off, 0.05)
      .connect(bpf(ctx, 3000, 5))
      .connect(env(ctx, lt + off, 0.0002, 0.6, 0.0015))
      .connect(out);
  }
  const thud = ctx.createOscillator();
  thud.frequency.value = 110;
  thud.connect(env(ctx, lt + 0.025, 0.001, 0.5, 0.03)).connect(out);
  thud.start(lt + 0.025);
  thud.stop(lt + 0.3);
  thud.onended = () => thud.disconnect();
}

function outGain(ctx: BaseAudioContext, dest: AudioNode, k: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = k;
  g.connect(dest);
  return g;
}

/**
 * Dice skins' contact sounds (docs/research/sound.md §2.1): a band-passed noise click whose centre is randomised per
 * contact (no machine-gun), the tray's wooden knock under it, and the skin's ring (gem, metal, obsidian). The caller
 * brightens harder hits through `rate` (0.85 + 0.3·v) and scales the loudness by v^1.5 through the gain.
 */
type DiceMaterial = "resin" | "gemstone" | "metal" | "bone" | "obsidian";
const DICE_MATERIALS: Record<
  DiceMaterial,
  { fMul: number; q: number; tau: number; body: number; k: number; ring: [number, number, number][] }
> = {
  resin: { fMul: 1, q: 3.5, tau: 0.0035, body: 0.5, k: 1.3, ring: [] },
  gemstone: { fMul: 1.3, q: 5, tau: 0.0035, body: 0.5, k: 0.89, ring: [[3800, 0.2, 0.008]] },
  metal: {
    fMul: 1,
    q: 3.5,
    tau: 0.0035,
    body: 0.5,
    k: 0.57,
    // 2.756 × the fundamental: the second free–free bar mode, so it reads as metal, not a beep.
    ring: [
      [2500, 0.35, 0.015],
      [6890, 0.12, 0.006],
    ],
  },
  bone: { fMul: 0.7, q: 2.5, tau: 0.005, body: 0.6, k: 1.48, ring: [] },
  obsidian: { fMul: 1.15, q: 4.5, tau: 0.0035, body: 0.5, k: 1.07, ring: [[4200, 0.15, 0.007]] },
};

/** A die striking the tray (`die` false: with the tray's wooden knock) or another die (brighter, shorter, no knock). */
function dieHit(material: DiceMaterial, die: boolean): Recipe {
  const m = DICE_MATERIALS[material];
  return {
    channel: "dice",
    variation: 0,
    play(ctx, dest, t, rate, engine) {
      // Die on die sits ~2 dB under die on tray (peak 0.25 against 0.32).
      const out = outGain(ctx, dest, die ? m.k * 0.815 : m.k);
      const tau = die ? 0.0025 : m.tau;
      const f = (1800 + Math.random() * 1400) * rate * m.fMul * (die ? 1.25 : 1);
      const src = noiseSrc(ctx, engine, "white", t, 0.08);
      src
        .connect(bpf(ctx, f, m.q))
        .connect(env(ctx, t, 0.0005, 1, tau))
        .connect(out);
      if (!die)
        src
          .connect(bpf(ctx, 620, 2.5))
          .connect(env(ctx, t, 0.0005, m.body, 1.4 * tau))
          .connect(out);
      for (const [hz, p, rt] of m.ring) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = hz * (0.98 + Math.random() * 0.04);
        o.connect(env(ctx, t, 0.001, p, rt)).connect(out);
        o.start(t);
        o.stop(t + 0.08);
        o.onended = () => o.disconnect();
      }
    },
  };
}

export const RECIPES = {
  /** Two knocks on wood (UI). The loudest UI sound: the DM must notice a knock. */
  knock: {
    channel: "ui",
    variation: 0.02,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.282);
      knockOnce(ctx, engine, out, t, rate, 1);
      knockOnce(ctx, engine, out, t + 0.18, 0.97 * rate, 0.8);
    },
  },
  /** Door creak + latch when a player is admitted (UI). */
  admitted: {
    channel: "ui",
    variation: 0.03,
    play(ctx, dest, t, _rate, engine) {
      creakAndLatch(ctx, engine, outGain(ctx, dest, 0.165), t, 0.6);
    },
  },
  /** Muted wooden "uh-uh" (UI): error / not allowed. */
  error: zzfx("error", "ui", [
    { at: 0, p: [0.124, 0, 220, 0.001, 0, 0.06, 1, 0.6, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0.4, 0.012, 0, -700] },
    { at: 75, p: [0.105, 0, 175, 0.001, 0, 0.07, 1, 0.6, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0.4, 0.012, 0, -650] },
  ]),
  /** Quiet wooden tick (UI): small confirmations. */
  tick: zzfx("tick", "ui", [
    { at: 0, p: [0.08, 0, 1250, 0, 0.004, 0.03, 1, 1.4, 0, 0, 0, 0, 0, 0.2, 0, 0, 0, 0.6, 0.004, 0, 2600] },
  ]),
  /** Soft rising chime (UI): a friendly notification (also the "Test sound" in the waiting room). */
  chime: {
    channel: "ui",
    variation: 0.015,
    play(ctx, dest, t, rate) {
      const out = outGain(ctx, dest, 0.2);
      for (const [f, at, p] of [
        [660, 0, 1],
        [990, 0.09, 0.7],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f * rate;
        o.connect(env(ctx, t + at, 0.004, p, 0.35)).connect(out);
        o.start(t + at);
        o.stop(t + at + 1.6);
        o.onended = () => o.disconnect();
      }
    },
  },
  /** Damage taken (effects, sound.md §2.4): a crunch with a falling pitch — loss. */
  damage: zzfx("damage", "effects", [
    {
      at: 0,
      p: [0.971, 0, 360, 0, 0.03, 0.12, 2, 1, -2.2, 0, 0, 0, 0, 2.5, 0, 0.25, 0, 0.5, 0.02, 0, -1600],
    },
  ]),
  /** Heal (effects, sound.md §2.4): rising, soft and tonal — restoration — with an octave shimmer and a sparkle. */
  heal: zzfx("heal", "effects", [
    { at: 0, p: [0.237, 0, 440, 0.06, 0.12, 0.35, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.8, 0.05, 0, 0] },
    { at: 0, p: [0.071, 0, 880, 0.08, 0.1, 0.35, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.8, 0.05, 0, 0] },
    { at: 100, p: [0.024, 0, 2000, 0.06, 0.15, 0.4, 4, 1, 0, 0, 0, 0, 0.04, 0, 0, 0, 0, 1, 0, 0.8, 3500] },
  ]),
  /**
   * Down (0 HP) or dead (effects, sound.md §2.4): the heaviest non-spell sound — a long sub drop (90 → 40 Hz) with an
   * exciter so a laptop still hears it, its octave, and a brown-noise thud.
   */
  down: {
    channel: "effects",
    variation: 0.03,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.315);
      const low = ctx.createOscillator();
      low.type = "sine";
      low.frequency.setValueAtTime(90 * rate, t);
      low.frequency.exponentialRampToValueAtTime(40 * rate, t + 0.35);
      const lowEnv = env(ctx, t, 0.005, 1, 0.25);
      low.connect(lowEnv).connect(out);
      exciter(ctx, lowEnv, out, 4, 180, 1.4);
      const oct = ctx.createOscillator();
      oct.type = "sine";
      oct.frequency.setValueAtTime(180 * rate, t);
      oct.frequency.exponentialRampToValueAtTime(80 * rate, t + 0.35);
      oct.connect(env(ctx, t, 0.005, 0.3, 0.25)).connect(out);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 300;
      lp.Q.value = -3;
      noiseSrc(ctx, engine, "brown", t, 0.6)
        .connect(lp)
        .connect(env(ctx, t, 0.005, 1.5, 0.08))
        .connect(out);
      for (const o of [low, oct]) {
        o.start(t);
        o.stop(t + 1.8);
        o.onended = () => o.disconnect();
      }
    },
  },
  /** A muffled footstep thump (effects): one every 5 ft of a committed move (SPEC §31). */
  footstep: zzfx("footstep", "effects", [
    {
      at: 0,
      p: [0.16, 0.08, 70, 0.002, 0.01, 0.06, 1, 1.8, 0, 0, 0, 0, 0, 0.8, 0, 0.05, 0, 0.5, 0.02, 0, -400],
    },
  ]),
  /** A door opening (effects): the creak without the latch. */
  doorOpen: {
    channel: "effects",
    variation: 0.04,
    play(ctx, dest, t, _rate, engine) {
      creak(ctx, engine, outGain(ctx, dest, 0.14), t, 0.45);
    },
  },
  /** A door shutting (effects): a low wooden thud. */
  doorClose: {
    channel: "effects",
    variation: 0.03,
    play(ctx, dest, t, rate) {
      const out = outGain(ctx, dest, 0.3);
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(95 * rate, t);
      o.frequency.exponentialRampToValueAtTime(55 * rate, t + 0.18);
      o.connect(env(ctx, t, 0.002, 1, 0.07)).connect(out);
      o.start(t);
      o.stop(t + 0.4);
      o.onended = () => o.disconnect();
    },
  },
  /** A locked door rattling (effects): three quick metallic clicks around 3 kHz. */
  lockRattle: {
    channel: "effects",
    variation: 0.04,
    play(ctx, dest, t, _rate, engine) {
      const out = outGain(ctx, dest, 0.35);
      for (const off of [0, 0.07, 0.13])
        noiseSrc(ctx, engine, "white", t + off, 0.03)
          .connect(bpf(ctx, 3000, 6))
          .connect(env(ctx, t + off, 0.0005, 0.9, 0.008))
          .connect(out);
    },
  },
  /** A sonar ping (UI): an 880 Hz sine with a fading echo (SPEC §31, pings). */
  ping: {
    channel: "ui",
    variation: 0.02,
    play(ctx, dest, t, rate) {
      const out = outGain(ctx, dest, 0.16);
      for (const [at, g] of [
        [0, 1],
        [0.18, 0.4],
        [0.36, 0.15],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = 880 * rate;
        o.connect(env(ctx, t + at, 0.003, g, 0.12)).connect(out);
        o.start(t + at);
        o.stop(t + at + 0.7);
        o.onended = () => o.disconnect();
      }
    },
  },
  /** Dice (§31, research §2.1): a die striking the tray, per skin material… */
  diceTrayResin: dieHit("resin", false),
  diceTrayGemstone: dieHit("gemstone", false),
  diceTrayMetal: dieHit("metal", false),
  diceTrayBone: dieHit("bone", false),
  diceTrayObsidian: dieHit("obsidian", false),
  /** …and striking another die. */
  diceDieResin: dieHit("resin", true),
  diceDieGemstone: dieHit("gemstone", true),
  diceDieMetal: dieHit("metal", true),
  diceDieBone: dieHit("bone", true),
  diceDieObsidian: dieHit("obsidian", true),
  /** A small wooden tick as a die comes to rest: the "done" beat before the number lands. */
  diceSettle: zzfx("diceSettle", "dice", [
    { at: 0, p: [0.107, 0, 1400, 0, 0, 0.026, 1, 1, -4, 0, 0, 0, 0, 0.15, 0, 0, 0, 0.3, 0.004, 0, 0] },
  ]),
  /** Natural 20: C–E–G–C struck brass (each note with its 2.756× partial) and a sparkle tail. */
  nat20: zzfx("nat20", "dice", [
    { at: 0, p: [0.41, 0, 1046.5, 0.002, 0.03, 0.45, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.5, 0.03, 0, 0] },
    { at: 0, p: [0.09, 0, 2884.154, 0.001, 0, 0.12, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.02, 0, 0] },
    {
      at: 65,
      p: [0.328, 0, 1318.51, 0.002, 0.03, 0.45, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.5, 0.03, 0, 0],
    },
    { at: 65, p: [0.074, 0, 3633.8136, 0.001, 0, 0.12, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.02, 0, 0] },
    {
      at: 130,
      p: [0.349, 0, 1567.98, 0.002, 0.03, 0.45, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.5, 0.03, 0, 0],
    },
    { at: 130, p: [0.074, 0, 4321.3529, 0.001, 0, 0.12, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.02, 0, 0] },
    { at: 195, p: [0.41, 0, 2093, 0.002, 0.03, 0.9, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.5, 0.03, 0, 0] },
    { at: 195, p: [0.09, 0, 5768.308, 0.001, 0, 0.2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.02, 0, 0] },
    { at: 180, p: [0.074, 0, 2000, 0.04, 0.15, 0.55, 4, 1, 0, 0, 0, 0, 0.035, 0, 0, 0, 0, 1, 0, 0.8, 3500] },
  ]),
  /** Natural 1: a soft, brassy deflating "womp" — quieter and shorter than the natural 20. */
  nat1: zzfx("nat1", "dice", [
    { at: 0, p: [0.113, 0, 196, 0.02, 0.18, 0.4, 2, 1, -0.2, -0.5, 0, 0, 0, 0.1, 0, 0, 0, 1, 0, 0, -450] },
    { at: 0, p: [0.079, 0, 198, 0.02, 0.18, 0.4, 2, 1, -0.2, -0.5, 0, 0, 0, 0.1, 0, 0, 0, 1, 0, 0, -450] },
  ]),
} satisfies Record<string, Recipe>;

export type SfxName = keyof typeof RECIPES;
