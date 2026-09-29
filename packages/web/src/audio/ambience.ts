import {
  AMBIENCE_LAYERS,
  type AmbienceLayer,
  type AmbienceState,
  DEFAULT_AMBIENCE,
} from "@gloam/shared/protocol";
import { serverNow } from "../net/clock.ts";
import { audio } from "./engine.ts";
import { RECIPES, type Recipe } from "./recipes.ts";
import { genIR, hash32, lpf, mulberry32u } from "./synth.ts";

/**
 * Ambience (SPEC §8.17, §25.4; docs/research/sound.md §3): seven procedural layers — rain, wind, fire, flowing water,
 * cave drips, night insects and a room's murmur — each synthesized here from noise and a few oscillators, mixed as the
 * DM sets them (the same mix for everyone; each client makes its own sound). Busy events (droplets, crackles, bubbles,
 * chirps, drips, syllables) are rendered once into loop buffers whose lengths are co-prime, so the whole doesn't
 * realign for minutes; nothing is scheduled note by note.
 */

/** Each layer's gain for level 1 (≈ −24 LUFS at the channel, sound.md §3.3); a slider sets normGain · level². */
const NORM: Record<AmbienceLayer, number> = {
  rain: 0.434,
  wind: 1.37,
  fire: 0.41,
  water: 0.796,
  drips: 0.833,
  insects: 0.158,
  murmur: 0.788,
};

interface Built {
  out: GainNode;
  stop(): void;
}

/** A buffer of `sec` seconds filled by `fill(data, sampleRate, r)` (r: a seeded uniform in [0, 1)). */
function render(
  ctx: BaseAudioContext,
  sec: number,
  seed: number,
  fill: (d: Float32Array, sr: number, r: () => number) => void,
): AudioBuffer {
  const b = ctx.createBuffer(1, Math.round(sec * ctx.sampleRate), ctx.sampleRate);
  const u = mulberry32u(seed);
  fill(b.getChannelData(0), ctx.sampleRate, () => u() / 4294967296);
  return b;
}

/** Events at Poisson times (rate per second) across the buffer, each drawn by `draw` at its sample offset. */
function poisson(
  d: Float32Array,
  sr: number,
  r: () => number,
  rate: number,
  draw: (d: Float32Array, at: number, sr: number, r: () => number) => void,
): void {
  let t = 0;
  const len = d.length / sr;
  for (;;) {
    t += -Math.log(1 - r()) / rate;
    if (t >= len) break;
    draw(d, Math.floor(t * sr), sr, r);
  }
}

/** A short resonant tick: a decaying sine at `f` (a band-passed click's ring). */
function ping(
  d: Float32Array,
  at: number,
  sr: number,
  f: number,
  amp: number,
  tau: number,
  riseTo = 1,
): void {
  const n = Math.min(d.length - at, Math.ceil(tau * 7 * sr));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fi = riseTo === 1 ? f : f * riseTo ** Math.min(1, t / 0.025);
    phase += (2 * Math.PI * fi) / sr;
    d[at + i] = (d[at + i] ?? 0) + amp * Math.sin(phase) * Math.exp(-t / tau);
  }
}

function loop(ctx: AudioContext, buf: AudioBuffer): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.start(ctx.currentTime, buf.duration * Math.random());
  return s;
}

function noiseLoop(ctx: AudioContext, kind: "white" | "pink" | "brown"): AudioBufferSourceNode {
  return loop(ctx, audio.noiseBuffer(kind));
}

/** A GainNode whose gain is driven by a looping envelope buffer (audio-rate AM). */
function modulated(
  ctx: AudioContext,
  env: AudioBuffer,
  base = 0,
): { gain: GainNode; src: AudioBufferSourceNode } {
  const g = ctx.createGain();
  g.gain.value = base;
  const src = loop(ctx, env);
  src.connect(g.gain);
  return { gain: g, src };
}

/** A stepped envelope (a new value every `stepMs` range), smoothed by a one-pole of time constant `tau`. */
function steppedEnvelope(
  ctx: BaseAudioContext,
  sec: number,
  seed: number,
  stepMin: number,
  stepMax: number,
  value: (r: () => number) => number,
  tau: number,
): AudioBuffer {
  return render(ctx, sec, seed, (d, sr, r) => {
    let target = value(r);
    let next = 0;
    let v = target;
    const k = 1 - Math.exp(-1 / (tau * sr));
    for (let i = 0; i < d.length; i++) {
      if (i >= next) {
        target = value(r);
        next = i + Math.round((stepMin + r() * (stepMax - stepMin)) * sr);
      }
      v += k * (target - v);
      d[i] = v;
    }
  });
}

function build(ctx: AudioContext, layer: AmbienceLayer, dest: AudioNode, seed: number): Built {
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(dest);
  const sources: AudioScheduledSourceNode[] = [];
  const keep = <T extends AudioScheduledSourceNode>(s: T) => {
    sources.push(s);
    return s;
  };
  switch (layer) {
    case "rain": {
      const bed = keep(noiseLoop(ctx, "pink"));
      const gust = ctx.createGain();
      gust.gain.value = 1;
      const lfo = keep(ctx.createOscillator());
      lfo.frequency.value = 0.07;
      const depth = ctx.createGain();
      depth.gain.value = 0.15;
      lfo.connect(depth).connect(gust.gain);
      lfo.start();
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 400;
      hp.Q.value = -3;
      bed.connect(hp).connect(lpf(ctx, 9000)).connect(gust).connect(out);
      // Droplets: 30 a second, bright resonant ticks, in a 7.3-s loop.
      const drops = render(ctx, 7.3, seed ^ 0x7a1, (d, sr, r) =>
        poisson(d, sr, r, 30, (dd, at, s, rr) =>
          ping(dd, at, s, 2500 + rr() * 4500, (0.2 + 0.8 * rr()) ** 2, 0.0006),
        ),
      );
      const dropGain = ctx.createGain();
      dropGain.gain.value = 3;
      keep(loop(ctx, drops)).connect(dropGain).connect(out);
      break;
    }
    case "wind": {
      const src = keep(noiseLoop(ctx, "brown"));
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 3;
      const whistle = ctx.createBiquadFilter();
      whistle.type = "bandpass";
      whistle.Q.value = 10;
      const wg = ctx.createGain();
      wg.gain.value = 0.15;
      const level = ctx.createGain();
      src.connect(band).connect(level);
      src.connect(whistle).connect(wg).connect(level);
      level.connect(out);
      // lfo(t) = 0.6·sin(2π·0.05t) + 0.4·sin(2π·0.13t + 1): the gusts, their pitch and their strength, every 2 s.
      let alive = true;
      const lfoAt = (t: number) =>
        0.6 * Math.sin(2 * Math.PI * 0.05 * t) + 0.4 * Math.sin(2 * Math.PI * 0.13 * t + 1);
      const follow = () => {
        if (!alive) return;
        const t0 = ctx.currentTime;
        const pts = 21;
        const fc = new Float32Array(pts);
        const fw = new Float32Array(pts);
        const g = new Float32Array(pts);
        for (let i = 0; i < pts; i++) {
          const l = lfoAt(serverNow() / 1000 + (2 * i) / (pts - 1));
          fc[i] = 350 * 2 ** (1.5 * l);
          fw[i] = (fc[i] as number) * 4;
          g[i] = 0.55 + (0.45 * (l + 1)) / 2;
        }
        for (const [p, c] of [
          [band.frequency, fc],
          [whistle.frequency, fw],
          [level.gain, g],
        ] as const) {
          p.cancelScheduledValues(t0);
          p.setValueCurveAtTime(c, t0, 2);
        }
        setTimeout(follow, 1900);
      };
      follow();
      sources.push({
        stop() {
          alive = false;
        },
      } as unknown as AudioScheduledSourceNode);
      break;
    }
    case "fire": {
      const roarAm = steppedEnvelope(ctx, 9.1, seed ^ 0xf1, 0.08, 0.08, (r) => 0.8 + 0.4 * r(), 0.04);
      const roar = modulated(ctx, roarAm);
      keep(roar.src);
      keep(noiseLoop(ctx, "brown")).connect(lpf(ctx, 900)).connect(roar.gain).connect(out);
      const crackles = render(ctx, 9.1, seed ^ 0xc2, (d, sr, r) =>
        poisson(d, sr, r, 5, (dd, at, s, rr) =>
          ping(dd, at, s, 1500 + rr() * 4500, (0.3 + 0.7 * rr()) ** 2, 0.001 + rr() * 0.005),
        ),
      );
      const cg = ctx.createGain();
      cg.gain.value = 3;
      keep(loop(ctx, crackles)).connect(cg).connect(out);
      const hissAm = steppedEnvelope(ctx, 8.3, seed ^ 0x415, 0.12, 0.12, (r) => 0.05 * r() ** 4, 0.02);
      const hiss = modulated(ctx, hissAm);
      keep(hiss.src);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2000;
      hp.Q.value = -3;
      keep(noiseLoop(ctx, "white")).connect(hp).connect(hiss.gain).connect(out);
      break;
    }
    case "water": {
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1095;
      band.Q.value = 0.78;
      const am = ctx.createGain();
      am.gain.value = 0.8;
      for (const [f, dep, ph] of [
        [0.3, 0.12, 0],
        [0.47, 0.08, 2],
      ] as const) {
        const o = keep(ctx.createOscillator());
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = dep;
        o.connect(g).connect(am.gain);
        o.start(ctx.currentTime + ph / (2 * Math.PI * f));
      }
      keep(noiseLoop(ctx, "pink")).connect(band).connect(am).connect(out);
      const bubbles = render(ctx, 8.3, seed ^ 0xb0b, (d, sr, r) =>
        poisson(d, sr, r, 25, (dd, at, s, rr) =>
          ping(dd, at, s, 500 + rr() * 1000, 0.1 + 0.4 * rr(), 0.008, 1.5),
        ),
      );
      const bg = ctx.createGain();
      bg.gain.value = 0.5;
      keep(loop(ctx, bubbles)).connect(bg).connect(out);
      break;
    }
    case "drips": {
      const cave = ctx.createConvolver();
      cave.normalize = true;
      cave.buffer = genIR(ctx, 3.5, seed ^ 0xca5e);
      const wet = ctx.createGain();
      wet.gain.value = 0.7;
      cave.connect(wet).connect(out);
      const dry = ctx.createGain();
      dry.gain.value = 0.5;
      dry.connect(out);
      // Three steady drippers (a real cave's few, not a uniform patter), each its own loop.
      for (const [period, f, n] of [
        [1.9, 1450, 7],
        [2.7, 1870, 5],
        [3.4, 2310, 4],
      ] as const) {
        const buf = render(ctx, period * n, seed ^ Math.round(f), (d, sr, r) => {
          for (let k = 0; k < n; k++)
            ping(
              d,
              Math.floor((k * period + period * 0.08 * (r() * 2 - 1) + 0.1) * sr),
              sr,
              f,
              0.6 + 0.4 * r(),
              0.025,
              1.6,
            );
        });
        const s = keep(loop(ctx, buf));
        s.connect(dry);
        s.connect(cave);
      }
      break;
    }
    case "insects": {
      for (const [f, period, g, pan] of [
        [4500, 0.7, 1, -0.5],
        [4800, 0.61, 0.7, 0.3],
        [4200, 0.83, 0.8, -0.1],
        [5100, 0.97, 0.5, 0.6],
      ] as const) {
        // A chirp: three 20-ms pulses 34 ms apart, once a period.
        const env = render(ctx, period * 7, seed ^ Math.round(f), (d, sr) => {
          for (let k = 0; k < 7; k++)
            for (let p = 0; p < 3; p++) {
              const at = Math.floor((k * period + p * 0.034) * sr);
              for (let i = 0; i < Math.round(0.02 * sr) && at + i < d.length; i++) {
                const t = i / sr;
                d[at + i] = t < 0.002 ? t / 0.002 : t < 0.014 ? 1 : Math.max(0, 1 - (t - 0.014) / 0.006);
              }
            }
        });
        const o = keep(ctx.createOscillator());
        o.frequency.value = f;
        o.start();
        const am = modulated(ctx, env);
        keep(am.src);
        const level = ctx.createGain();
        level.gain.value = g;
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        o.connect(am.gain).connect(level).connect(p).connect(out);
      }
      break;
    }
    case "murmur": {
      const sum = ctx.createGain();
      sum.connect(lpf(ctx, 2500)).connect(out);
      for (let v = 0; v < 4; v++) {
        // Syllables: a new level every 120–260 ms (≈ 4–5 Hz, speech's rhythm), a quarter of them near silent.
        const env = steppedEnvelope(
          ctx,
          [7.3, 9.1, 8.3, 13.7][v] as number,
          seed ^ (0x5a + v),
          0.12,
          0.26,
          (r) => (r() < 0.25 ? 0.03 : 0.3 + 0.7 * r()),
          0.02,
        );
        const am = modulated(ctx, env);
        keep(am.src);
        const src = keep(noiseLoop(ctx, "pink"));
        const f1 = ctx.createBiquadFilter();
        f1.type = "bandpass";
        f1.frequency.value = 450 + 150 * v;
        f1.Q.value = 1.2;
        const f2 = ctx.createBiquadFilter();
        f2.type = "bandpass";
        f2.frequency.value = 1400 + 200 * v;
        f2.Q.value = 2;
        const f2g = ctx.createGain();
        f2g.gain.value = 0.5;
        src.connect(f1).connect(am.gain);
        src.connect(f2).connect(f2g).connect(am.gain);
        am.gain.connect(sum);
      }
      break;
    }
  }
  return {
    out,
    stop() {
      for (const s of sources)
        try {
          s.stop();
        } catch {
          // already stopped
        }
      setTimeout(() => out.disconnect(), 100);
    },
  };
}

/**
 * The table's ambience: follows the DM's mix as `audio.sync` delivers it. Layers are built when first heard and
 * fade (½-s time constant) as their levels move; a layer at 0 for a while is torn down.
 */
class Ambience {
  private state: AmbienceState = DEFAULT_AMBIENCE;
  private layers = new Map<AmbienceLayer, Built & { idleSince: number | null }>();
  private thunderTimer: ReturnType<typeof setInterval> | null = null;
  private lastThunderSlot = -1;

  apply(next: AmbienceState): void {
    this.state = next;
    this.mix();
  }

  /** Builds and levels the layers (again once audio unlocks). */
  mix(): void {
    const ctx = audio.ensure();
    const dest = audio.input("ambience");
    if (!ctx || !dest || ctx.state !== "running") return;
    const now = ctx.currentTime;
    for (const layer of AMBIENCE_LAYERS) {
      const level = this.state.levels[layer] ?? 0;
      let l = this.layers.get(layer);
      if (!l && level > 0) {
        l = {
          ...build(ctx, layer, dest, hash32(this.state.seed, AMBIENCE_LAYERS.indexOf(layer))),
          idleSince: null,
        };
        this.layers.set(layer, l);
      }
      if (!l) continue;
      l.out.gain.setTargetAtTime(NORM[layer] * level * level, now, 0.5);
      l.idleSince = level > 0 ? null : (l.idleSince ?? performance.now());
    }
    // Torn down after 10 s silent.
    for (const [layer, l] of this.layers)
      if (l.idleSince !== null && performance.now() - l.idleSince > 10_000) {
        l.stop();
        this.layers.delete(layer);
      }
    this.stormThunder();
  }

  /**
   * A storm's distant thunder, every 20–60 s, at the same moments for everyone: one in each 40-s slot of the
   * server's clock, 10–30 s into it (so 20–60 s apart), chosen from the ambience's seed (sound.md §3.4).
   */
  private stormThunder(): void {
    const on = this.state.preset === "storm";
    if (on && !this.thunderTimer)
      this.thunderTimer = setInterval(() => {
        const t = serverNow() / 1000;
        const slot = Math.floor(t / 40);
        const at = slot * 40 + 10 + (hash32(this.state.seed, 0x7d, slot) % 20);
        if (slot !== this.lastThunderSlot && t >= at && t < at + 1.5) {
          this.lastThunderSlot = slot;
          this.distantThunder();
        }
      }, 250);
    if (!on && this.thunderTimer) {
      clearInterval(this.thunderTimer);
      this.thunderTimer = null;
    }
  }

  /** The thunder recipe, far off: without its crack, through a 400-Hz low-pass, 12 dB down, on the ambience. */
  private distantThunder(): void {
    const ctx = audio.ensure();
    const dest = audio.input("ambience");
    if (!ctx || !dest || ctx.state !== "running") return;
    const far = lpf(ctx, 400);
    const g = ctx.createGain();
    g.gain.value = 0.25;
    far.connect(g).connect(dest);
    const thunder: Recipe = RECIPES.thunder;
    thunder.play(ctx, far, ctx.currentTime + 0.01, 0.9 + Math.random() * 0.2, audio, 0);
    setTimeout(() => {
      far.disconnect();
      g.disconnect();
    }, 4000);
  }

  /** Test builds: which layers are built and their gains. */
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.layers].map(([k, l]) => [k, l.out.gain.value]));
  }
}

export const ambience = new Ambience();
