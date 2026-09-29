import type { AudioEngine } from "../engine.ts";
import { exciter, hpf, lpf, noiseSrc } from "../synth.ts";
import type { NoteEvent } from "./gen.ts";
import { midiHz } from "./gen.ts";

/**
 * The generative presets' instruments (docs/research/sound.md §4.6–4.9). Each plays one event starting at ctx time
 * `t0` — which may already be past (a late joiner, or a pad that began before its bar): sustained voices come in at
 * their envelope's value by then (the attack or decay worked out analytically), short ones that are over are skipped.
 */
export interface VoiceOut {
  /** The preset's bus (dry). */
  dry: AudioNode;
  /** Its reverb send. */
  wet: AudioNode;
  /** The preset's slow movements at a ctx time (filters, sways — the same for everyone at the same moment). */
  drift(ctxTime: number): Record<string, number>;
}

/** Everything a voice starts, so a stop can silence it at once. */
export type Started = { stop(at: number): void };

/** A linear attack–hold–release on `param`, from `t0` (maybe past) as seen at `now`. */
function ahr(
  param: AudioParam,
  t0: number,
  now: number,
  a: number,
  peak: number,
  h: number,
  r: number,
): void {
  const at = Math.max(t0, now);
  const e = at - t0;
  const value = e < a ? (peak * e) / a : e < a + h ? peak : e < a + h + r ? peak * (1 - (e - a - h) / r) : 0;
  param.cancelScheduledValues(at);
  param.setValueAtTime(value, at);
  if (e < a) param.linearRampToValueAtTime(peak, t0 + a);
  if (e < a + h) param.setValueAtTime(peak, t0 + a + h);
  if (e < a + h + r) param.linearRampToValueAtTime(0, t0 + a + h + r);
}

/** A struck envelope: a linear attack, then exponential decay with time constant τ. */
function strike(param: AudioParam, t0: number, now: number, a: number, peak: number, tau: number): void {
  const at = Math.max(t0, now);
  const e = at - t0;
  const value = e < a ? (peak * e) / a : peak * Math.exp(-(e - a) / tau);
  param.setValueAtTime(value, at);
  if (e < a) param.linearRampToValueAtTime(peak, t0 + a);
  param.setTargetAtTime(0, Math.max(at, t0 + a), tau);
}

function gainNode(ctx: BaseAudioContext, v = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function oscAt(ctx: BaseAudioContext, type: OscillatorType, f: number, t0: number, now: number, end: number) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.start(Math.max(t0, now));
  o.stop(end);
  o.onended = () => o.disconnect();
  return o;
}

// ── Karplus–Strong plucks (sound.md §4.5), rendered once per note and brightness ─────────────────────────

const ksCache = new Map<string, AudioBuffer>();

function ksPluck(ctx: BaseAudioContext, midi: number, bright: number, t60: number): AudioBuffer {
  const key = `${ctx.sampleRate}|${midi}|${bright}|${t60.toFixed(2)}`;
  const hit = ksCache.get(key);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const f0 = midiHz(midi);
  const P = sr / f0;
  const N = Math.max(2, Math.floor(P - 0.5 - 1e-6));
  const d = P - 0.5 - N;
  const C = (1 - d) / (1 + d);
  const rho = 0.001 ** (1 / (f0 * t60));
  // Excitation: seeded noise, darkened by a one-pole low-pass, combed by the pick's position, DC removed.
  let seed = (midi * 2654435761) >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  const line = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp += bright * (rnd() - lp);
    line[i] = lp;
  }
  const pick = Math.max(1, Math.round(0.13 * N));
  const combed = line.map((v, i) => v - (i >= pick ? (line[i - pick] as number) : 0));
  const mean = combed.reduce((a, b) => a + b, 0) / N;
  for (let i = 0; i < N; i++) line[i] = (combed[i] as number) - mean;
  const len = Math.ceil((t60 + 0.05) * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  let idx = 0;
  let prev = 0;
  let x1 = 0;
  let y1 = 0;
  let peak = 0;
  for (let n = 0; n < len; n++) {
    const cur = line[idx] as number;
    out[n] = cur;
    peak = Math.max(peak, Math.abs(cur));
    const avg = 0.5 * (cur + prev);
    prev = cur;
    const ap = C * avg + x1 - C * y1;
    x1 = avg;
    y1 = ap;
    line[idx] = rho * ap;
    idx = (idx + 1) % N;
  }
  if (peak > 0) for (let n = 0; n < len; n++) out[n] = (out[n] as number) / peak;
  ksCache.set(key, buf);
  return buf;
}

/** Plays one event. Returns a handle to stop it, or null when it's over (or too late to play) already. */
export function playVoice(
  ctx: AudioContext,
  engine: AudioEngine,
  out: VoiceOut,
  e: NoteEvent,
  t0: number,
): Started | null {
  const now = ctx.currentTime;
  const end = t0 + e.dur + 0.1;
  if (end <= now) return null;
  const late = now - t0;
  const sources: (AudioScheduledSourceNode | null)[] = [];
  const dest = (send: number, g = 1): GainNode => {
    const v = gainNode(ctx, g);
    v.connect(out.dry);
    if (send > 0) v.connect(gainNode(ctx, send)).connect(out.wet);
    return v;
  };
  const panned = (node: AudioNode, pan: number | undefined): AudioNode => {
    if (pan === undefined) return node;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(node);
    return p;
  };
  /** A cutoff that follows the preset's drift over the event (one point a second). */
  const sweep = (param: AudioParam, key: string, scale = 1) => {
    const from = Math.max(t0, now);
    const pts = Math.max(2, Math.ceil(end - from) + 1);
    const curve = new Float32Array(pts);
    for (let i = 0; i < pts; i++)
      curve[i] = (out.drift(from + ((end - from) * i) / (pts - 1))[key] ?? 1000) * scale;
    param.setValueCurveAtTime(curve, from, Math.max(0.01, end - from));
  };
  const short = late > 0.05; // a strike already past its onset: skipped

  switch (e.voice) {
    case "padSaw":
    case "padSawHigh": {
      const high = e.voice === "padSawHigh";
      const f = lpf(ctx, 400, 4);
      sweep(f.frequency, high ? "cutB" : "cutA");
      const env = gainNode(ctx, 0);
      ahr(env.gain, t0, now, 6, 1, Math.max(0, e.dur - 12), 6);
      f.connect(env).connect(dest(0.35, (high ? 0.03 : 0.05) * e.vel));
      for (const m of e.notes)
        for (const cents of high ? [-5, 5] : [-7, 7]) {
          const o = oscAt(ctx, "sawtooth", midiHz(m), t0, now, end);
          o.detune.value = cents;
          o.connect(f);
          sources.push(o);
        }
      break;
    }
    case "subPulse": {
      if (short) return null;
      const o = oscAt(ctx, "sine", midiHz(e.notes[0] as number), t0, now, end);
      const env = gainNode(ctx, 0);
      strike(env.gain, t0, now, 0.03, 1, 1.1);
      const bus = dest(0.1, 0.12);
      o.connect(env).connect(bus);
      exciter(ctx, env, bus, 4, 180, 1.2);
      const n = noiseSrc(ctx, engine, "brown", t0, 0.6);
      const ne = gainNode(ctx, 0);
      strike(ne.gain, t0, now, 0.005, 0.6, 0.15);
      n.connect(lpf(ctx, 150)).connect(ne).connect(bus);
      sources.push(o, n);
      break;
    }
    case "bell": {
      const f = midiHz(e.notes[0] as number);
      const lp = lpf(ctx, 2500);
      // Distant: dry 0.4 to wet 0.6.
      lp.connect(dest(1.5, 0.03 * e.vel));
      for (const [ratio, g, tau] of [
        [0.25, 0.5, 3.5],
        [0.5, 0.6, 3],
        [0.5946, 0.45, 2.2],
        [0.7492, 0.25, 1.8],
        [1, 1, 2],
        [1.5, 0.3, 0.8],
        [2, 0.2, 0.6],
      ] as const) {
        const o = oscAt(ctx, "sine", f * ratio, t0, now, end);
        const env = gainNode(ctx, 0);
        strike(env.gain, t0, now, 0.002, g, tau);
        o.connect(env).connect(lp);
        sources.push(o);
      }
      break;
    }
    case "pluck":
    case "pluckBass": {
      if (short) return null;
      const bass = e.voice === "pluckBass";
      const m = e.notes[0] as number;
      const t60 = bass ? 1.8 : 1.4 * (196 / midiHz(m)) ** 0.4;
      const src = ctx.createBufferSource();
      src.buffer = ksPluck(ctx, m, bass ? 0.25 : 0.55, t60);
      const g = gainNode(ctx, (bass ? 0.2 : 0.2) * e.vel);
      src.connect(g).connect(panned(dest(bass ? 0 : 0.18), e.pan));
      src.start(Math.max(t0, now));
      src.stop(Math.min(end, t0 + t60 + 0.05));
      src.onended = () => src.disconnect();
      sources.push(src);
      break;
    }
    case "frameDrum": {
      if (short) return null;
      const bus = dest(0.08, 0.2 * e.vel);
      if (e.stroke === "x") {
        const o = oscAt(ctx, "sine", 105, t0, now, t0 + 0.8);
        o.frequency.setValueAtTime(105, t0);
        o.frequency.exponentialRampToValueAtTime(78, t0 + 0.05);
        const env = gainNode(ctx, 0);
        strike(env.gain, t0, now, 0.001, 1, 0.16);
        o.connect(env).connect(bus);
        exciter(ctx, env, bus, 4, 200, 1.2);
        for (const [fr, g, tau] of [
          [167, 0.45, 0.09],
          [224, 0.3, 0.06],
        ] as const) {
          const m = oscAt(ctx, "sine", fr, t0, now, t0 + 0.5);
          const me = gainNode(ctx, 0);
          strike(me.gain, t0, now, 0.001, g, tau);
          m.connect(me).connect(bus);
          sources.push(m);
        }
        const n = noiseSrc(ctx, engine, "white", t0, 0.2);
        const ne = gainNode(ctx, 0);
        strike(ne.gain, t0, now, 0.001, 0.5, 0.02);
        n.connect(lpf(ctx, 1000)).connect(ne).connect(bus);
        sources.push(o, n);
      } else {
        const n = noiseSrc(ctx, engine, "white", t0, 0.3);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = e.stroke === "s" ? 1800 : 2500;
        bp.Q.value = e.stroke === "s" ? 1.2 : 2;
        const ne = gainNode(ctx, 0);
        strike(ne.gain, t0, now, 0.0005, e.stroke === "s" ? 0.8 : 0.35, e.stroke === "s" ? 0.035 : 0.015);
        n.connect(bp).connect(ne).connect(bus);
        sources.push(n);
        if (e.stroke === "s") {
          const o = oscAt(ctx, "sine", 220, t0, now, t0 + 0.3);
          const oe = gainNode(ctx, 0);
          strike(oe.gain, t0, now, 0.001, 0.3, 0.05);
          o.connect(oe).connect(bus);
          sources.push(o);
        }
      }
      break;
    }
    case "ostinato": {
      if (short) return null;
      const o = oscAt(ctx, "square", midiHz(e.notes[0] as number), t0, now, t0 + 0.15);
      const f = lpf(ctx, 2400, 6);
      const k = out.drift(t0).cutFactor ?? 1;
      f.frequency.setValueAtTime(2400 * k, t0);
      f.frequency.exponentialRampToValueAtTime(450 * k, t0 + 0.09);
      const env = gainNode(ctx, 0);
      strike(env.gain, t0, now, 0.002, 0.12 * e.vel, 0.11);
      o.connect(f).connect(env).connect(dest(0.15));
      sources.push(o);
      break;
    }
    case "tom": {
      if (short) return null;
      const big = e.stroke === "B";
      const k = e.stroke === "M" ? 1.45 : big ? 1.03 : 1;
      const bus = dest(big ? 0.3 : 0.25, (big ? 0.7 * 0.3 : 0.22) * e.vel);
      const hits = big ? [0, 0.38] : [0];
      for (const off of hits) {
        const at = t0 + off;
        const o = oscAt(ctx, "sine", 92 * k, at, now, at + 1);
        o.frequency.setValueAtTime(92 * k, at);
        o.frequency.exponentialRampToValueAtTime(62 * k, at + 0.07);
        const env = gainNode(ctx, 0);
        strike(env.gain, at, now, 0.001, 1, big ? 0.22 : 0.2);
        o.connect(env).connect(bus);
        exciter(ctx, env, bus, 4, 200, 1.3);
        for (const [ratio, g, tau] of [
          [1.593, 0.4, 0.1],
          [2.135, 0.25, 0.07],
        ] as const) {
          const m = oscAt(ctx, "sine", 92 * k * ratio, at, now, at + 0.6);
          const me = gainNode(ctx, 0);
          strike(me.gain, at, now, 0.001, g, tau);
          m.connect(me).connect(bus);
          sources.push(m);
        }
        const n = noiseSrc(ctx, engine, "white", at, 0.2);
        const ne = gainNode(ctx, 0);
        strike(ne.gain, at, now, 0.001, 0.5, 0.02);
        n.connect(lpf(ctx, 1200)).connect(ne).connect(bus);
        sources.push(o, n);
      }
      break;
    }
    case "swell": {
      const f = lpf(ctx, 1800);
      f.frequency.setValueAtTime(1800, t0);
      f.frequency.linearRampToValueAtTime(2600, t0 + 2.2);
      const env = gainNode(ctx, 0);
      ahr(env.gain, t0, now, 2.2, 1, 2.2, 2.5);
      f.connect(env).connect(dest(0.35, 0.03 * e.vel));
      const vib = oscAt(ctx, "sine", 5, t0, now, end);
      const depth = gainNode(ctx, 0);
      depth.gain.setValueAtTime(0, Math.max(t0, now));
      depth.gain.linearRampToValueAtTime(6, t0 + 1.6);
      vib.connect(depth);
      sources.push(vib);
      for (const m of e.notes)
        for (const cents of [-9, 0, 9]) {
          const o = oscAt(ctx, "sawtooth", midiHz(m), t0, now, end);
          o.detune.value = cents;
          depth.connect(o.detune);
          o.connect(f);
          sources.push(o);
        }
      break;
    }
    case "sinePad": {
      const env = gainNode(ctx, 0);
      ahr(env.gain, t0, now, 2.5, 1, Math.max(0, e.dur - 5.5), 3);
      const sway = gainNode(ctx, 1);
      const from = Math.max(t0, now);
      const pts = Math.max(2, Math.ceil(end - from) + 1);
      const curve = new Float32Array(pts);
      for (let i = 0; i < pts; i++) curve[i] = out.drift(from + ((end - from) * i) / (pts - 1)).sway ?? 1;
      sway.gain.setValueCurveAtTime(curve, from, Math.max(0.01, end - from));
      env.connect(sway).connect(dest(0.3, 0.04 * e.vel));
      for (const m of e.notes)
        for (const [mul, g] of [
          [1, 1],
          [2, 0.35],
          [3, 0.12],
        ] as const)
          for (const cents of [-4, 4]) {
            const o = oscAt(ctx, "sine", midiHz(m) * mul, t0, now, end);
            o.detune.value = cents;
            o.connect(gainNode(ctx, g)).connect(env);
            sources.push(o);
          }
      break;
    }
    case "fmBell": {
      if (short) return null;
      const f = midiHz(e.notes[0] as number);
      const car = oscAt(ctx, "sine", f, t0, now, end);
      const mod = oscAt(ctx, "sine", 3.5 * f, t0, now, end);
      const index = gainNode(ctx, 0);
      strike(index.gain, t0, now, 0.003, 4 * 3.5 * f, 1.2);
      mod.connect(index).connect(car.frequency);
      const amp = gainNode(ctx, 0);
      strike(amp.gain, t0, now, 0.003, 1, 1.2);
      const bus = dest(0.5, 0.08 * e.vel);
      car.connect(amp).connect(bus);
      // Its echo: a dotted eighth, fed back through a low-pass.
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.625;
      const fb = gainNode(ctx, 0.35);
      const lp = lpf(ctx, 4000);
      amp.connect(delay);
      delay.connect(lp).connect(fb).connect(delay);
      fb.connect(bus);
      setTimeout(
        () => {
          for (const n of [delay, fb, lp]) n.disconnect();
        },
        Math.max(0, (end - now + 3) * 1000),
      );
      sources.push(car, mod);
      break;
    }
    case "twinkle": {
      if (short) return null;
      const o = oscAt(ctx, "sine", midiHz(e.notes[0] as number), t0, now, t0 + 0.4);
      const env = gainNode(ctx, 0);
      strike(env.gain, t0, now, 0.001, e.vel, 0.06);
      o.connect(env).connect(panned(dest(0.6), e.pan));
      sources.push(o);
      break;
    }
  }
  return {
    stop(at: number) {
      for (const s of sources)
        try {
          s?.stop(at);
        } catch {
          // already stopped
        }
    },
  };
}

/** Wonder's high shimmer: continuous noise, its level swaying with the timeline (sound.md §4.9). */
export function shimmer(ctx: AudioContext, engine: AudioEngine, out: VoiceOut, from: number): Started {
  const n = noiseSrc(ctx, engine, "white", from, 3600);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 8000;
  bp.Q.value = 2;
  const g = gainNode(ctx, 0);
  n.connect(bp).connect(hpf(ctx, 3000)).connect(g).connect(out.wet);
  g.connect(out.dry);
  let alive = true;
  const follow = () => {
    if (!alive) return;
    const t = ctx.currentTime;
    g.gain.setTargetAtTime(0.02 * (out.drift(t + 0.5).shimmer ?? 0.5), t, 0.3);
    setTimeout(follow, 500);
  };
  follow();
  return {
    stop(at: number) {
      alive = false;
      try {
        n.stop(at);
      } catch {
        // already stopped
      }
    },
  };
}
