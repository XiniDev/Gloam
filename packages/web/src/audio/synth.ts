import type { AudioEngine, Channel } from "./engine.ts";
import { buildSamples, type ZzfxParams } from "./zzfx.ts";

/**
 * The building blocks of Gloam's synthesized sounds (SPEC §25, docs/research/sound.md §2.0 "WA notation"): envelopes,
 * noise sources, filters, the small-speaker exciter, cached ZzFX buffers, a generated reverb and the counter-based
 * random numbers the music and ambience share across clients.
 */

/** A sound: which channel it plays on, how much its pitch varies per play, and its graph. */
export interface Recipe {
  channel: Exclude<Channel, "master" | "music" | "ambience">;
  /** Per-play pitch variation (±4 % by default, SPEC §25.2). */
  variation: number;
  /** Send to the SFX reverb (1.8 s stone hall), post-fader (sound.md §6.1). */
  reverb?: number;
  /** A hero sound (nat 20, fire, thunder, down, initiative) is never dropped for the channel's voice cap. */
  hero?: boolean;
  /** About how long it sounds (s): its voice is counted against the channel's cap for this long. */
  dur: number;
  /** `seed`: a stable per-source number where a sound has a voice of its own (a door's creak); random otherwise. */
  play(ctx: AudioContext, dest: AudioNode, t: number, rate: number, engine: AudioEngine, seed: number): void;
}

const bufferCache = new Map<string, AudioBuffer>();

/** Layers of ZzFX parameters mixed at offsets (ms) into one buffer, rendered once per sample rate. */
export function zzfxBuffer(
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

/** A ZzFX recipe: its buffer played at the event's rate (one factor for every layer, sound.md §6.4). */
export function zzfx(
  key: string,
  channel: Recipe["channel"],
  layers: { at: number; p: ZzfxParams }[],
  variation = 0.04,
  extra: Partial<Pick<Recipe, "reverb" | "hero">> = {},
): Recipe {
  const lastMs = Math.max(
    ...layers.map((l) => l.at + 1000 * ((l.p[3] ?? 0) + (l.p[4] ?? 0) + (l.p[5] ?? 0.1))),
  );
  return {
    channel,
    variation,
    dur: lastMs / 1000 + 0.05,
    ...extra,
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

/** Several pre-rendered variants of one ZzFX event, rotated so none plays twice in a row (sound.md §6.4, cold). */
export function zzfxVariants(
  key: string,
  channel: Recipe["channel"],
  variants: { at: number; p: ZzfxParams }[][],
  variation = 0.04,
): Recipe {
  const recipes = variants.map((v, i) => zzfx(`${key}#${i}`, channel, v, variation));
  let last = -1;
  return {
    channel,
    variation,
    dur: Math.max(...recipes.map((r) => r.dur)),
    play(ctx, dest, t, rate, engine, seed) {
      let i = Math.floor(Math.random() * recipes.length);
      if (i === last) i = (i + 1) % recipes.length;
      last = i;
      recipes[i]?.play(ctx, dest, t, rate, engine, seed);
    },
  };
}

/** env(A, P, τ): linear attack to P, then exponential decay with time constant τ. */
export function env(ctx: BaseAudioContext, t: number, a: number, p: number, tau: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(p, t + a);
  g.gain.setTargetAtTime(0, t + a, tau);
  return g;
}

/** env(A, P, H, R): a linear attack to P, a hold of H, then a linear release over R (seconds). */
export function envAHR(
  ctx: BaseAudioContext,
  t: number,
  a: number,
  p: number,
  h: number,
  r: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(p, t + a);
  g.gain.setValueAtTime(p, t + a + h);
  g.gain.linearRampToValueAtTime(0, t + a + h + r);
  return g;
}

/** A shared noise loop of a colour, from a random offset (so simultaneous events decorrelate), for `dur` seconds. */
export function noiseSrc(
  ctx: AudioContext,
  engine: AudioEngine,
  kind: "white" | "pink" | "brown",
  t: number,
  dur: number,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = engine.noiseBuffer(kind);
  src.loop = true;
  src.start(t, Math.random() * 9);
  src.stop(t + dur + 0.02);
  src.onended = () => src.disconnect();
  return src;
}

/** BPF(f, Q) with linear Q. */
export function bpf(ctx: BaseAudioContext, f: number, q: number): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = "bandpass";
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}

/** LPF(f, q dB): −3 dB is Butterworth-flat (the Web Audio low-pass Q is in dB). */
export function lpf(ctx: BaseAudioContext, f: number, qDb = -3): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = "lowpass";
  b.frequency.value = f;
  b.Q.value = qDb;
  return b;
}

/** HPF(f, q dB). */
export function hpf(ctx: BaseAudioContext, f: number, qDb = -3): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = "highpass";
  b.frequency.value = f;
  b.Q.value = qDb;
  return b;
}

/** An oscillator started at `t` and stopped (and disconnected) at `t + dur`. */
export function osc(
  ctx: BaseAudioContext,
  type: OscillatorType,
  f: number,
  t: number,
  dur: number,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.start(t);
  o.stop(t + dur + 0.02);
  o.onended = () => o.disconnect();
  return o;
}

/** Small-speaker exciter: tanh saturation + two high-passes so low thumps survive phone speakers. */
export function exciter(
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
  const h1 = hpf(ctx, fc);
  const h2 = hpf(ctx, fc);
  const g = ctx.createGain();
  g.gain.value = gain;
  input.connect(ws).connect(h1).connect(h2).connect(g).connect(out);
}

/** The final gain of a recipe (`out ×k`, measured so its peak lands on the level plan). */
export function outGain(ctx: BaseAudioContext, dest: AudioNode, k: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = k;
  g.connect(dest);
  return g;
}

/** A seeded step curve (a gate or flutter): segments of `minMs`–`maxMs`, each a value from `value(r)`. */
export function stepCurve(
  param: AudioParam,
  t: number,
  dur: number,
  minMs: number,
  maxMs: number,
  value: (r: () => number) => number,
): void {
  const r = Math.random;
  let at = 0;
  param.setValueAtTime(value(r), t);
  while (at < dur) {
    at += (minMs + r() * (maxMs - minMs)) / 1000;
    param.setValueAtTime(value(r), t + at);
  }
}

// ── Determinism (sound.md §4.2): the same numbers on every client ───────────────────────────────────────────

/** Wellons' lowbias32 integer hash. */
export function lowbias32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A hash of integer coordinates (seed, layer, bar…): every random decision is a pure function of where it is. */
export function hash32(...k: number[]): number {
  return k.reduce((h, v) => lowbias32(((h ^ (v >>> 0)) + 0x9e3779b9) >>> 0), 0x243f6a88);
}

/** A string's stable uint32 (FNV-1a): a seed from an id. */
export function stringSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32 returning uint32 (so `r() % n` is exact for integer decisions). */
export function mulberry32u(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** A small uint32 stream for one set of coordinates. */
export function rngFor(...k: number[]): () => number {
  return mulberry32u(hash32(...k));
}

/**
 * A generated reverb impulse (sound.md §4.4): decorrelated noise per channel, one-pole damped so high frequencies die
 * first, decaying −60 dB at `rt60`, with a few early reflections. Its length ≈ RT60 (a longer buffer only adds wet
 * energy under the convolver's normalisation).
 */
export function genIR(
  ctx: BaseAudioContext,
  rt60: number,
  seed: number,
  preDelay = 0.015,
  fStart = 9000,
  fEnd = 1800,
  er = 6,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.round((rt60 + preDelay) * sr);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const r = mulberry32u(seed * 7919 + c * 104729);
    const p0 = Math.round(preDelay * sr);
    let lp = 0;
    for (let i = p0; i < len; i++) {
      const tt = (i - p0) / sr;
      const fc = fStart * (fEnd / fStart) ** Math.min(1, tt / rt60);
      lp += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * (r() / 2 ** 31 - 1 - lp);
      d[i] = lp * Math.exp((-6.907755 * tt) / rt60);
    }
    for (let j = 0; j < er; j++) {
      const at = p0 + Math.round((0.005 + (r() / 2 ** 32) * 0.055) * sr);
      if (at < len) d[at] = (d[at] ?? 0) + (0.6 - (0.4 * j) / er) * (r() & 1 ? 1 : -1);
    }
  }
  return buf;
}
