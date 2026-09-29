import {
  bpf,
  env,
  envAHR,
  exciter,
  hpf,
  lpf,
  noiseSrc,
  osc,
  outGain,
  type Recipe,
  stepCurve,
  zzfxVariants,
} from "../synth.ts";

/**
 * Spell sounds (SPEC §31; docs/research/sound.md §2.5): a generic cast whoosh at the caster, then the element's sound
 * where it lands — each rooted in a real sound (fire's roar and crackle, thunder's roll, acid's hiss).
 */

/** Cold's tinkle cluster: (ms, Hz, gain) blips, each a main tone and its 2.756× glass partial, over a frost hiss. */
const COLD_BLIPS: [number, number, number][] = [
  [0, 3520, 1],
  [40, 2637.02, 0.8],
  [85, 4186.01, 0.7],
  [120, 3135.96, 0.75],
  [175, 4698.63, 0.55],
  [240, 3951.07, 0.5],
  [320, 2637.02, 0.4],
  [410, 3520, 0.3],
];

/** Three fixed permutations of the cluster's (offset, pitch) pairs, rotated so the same one never plays twice running. */
function coldVariant(perm: number[]) {
  const layers = COLD_BLIPS.flatMap(([ms], i) => {
    const [, f, g] = COLD_BLIPS[perm[i] as number] as [number, number, number];
    return [
      { at: ms, p: [0.263 * g, 0, f, 0, 0, 0.07, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0.004, 0, 0] },
      { at: ms, p: [0.066 * g, 0, f * 2.756, 0, 0, 0.03, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.003, 0, 0] },
    ];
  });
  layers.push({ at: 0, p: [0.032, 0, 1000, 0.03, 0.1, 0.3, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 2500] });
  return layers;
}

/** A broadband crack (lightning, thunder). */
function crack(
  ctx: AudioContext,
  engine: Parameters<Recipe["play"]>[4],
  out: AudioNode,
  t: number,
  g: number,
) {
  noiseSrc(ctx, engine, "white", t, 0.1)
    .connect(hpf(ctx, 1000))
    .connect(env(ctx, t, 0.0005, g, 0.008))
    .connect(out);
}

export const SPELL_SOUNDS = {
  /** A spell cast (effects): pink noise swept up through a band — energy gathering; the element follows on impact. */
  spellCast: {
    channel: "effects",
    variation: 0.04,
    dur: 0.6,
    play(ctx, dest, t, rate, engine) {
      const b = bpf(ctx, 300 * rate, 1.8);
      b.frequency.setValueAtTime(300 * rate, t);
      b.frequency.exponentialRampToValueAtTime(3000 * rate, t + 0.45);
      noiseSrc(ctx, engine, "pink", t, 0.55)
        .connect(b)
        .connect(envAHR(ctx, t, 0.15, 1, 0.05, 0.3))
        .connect(outGain(ctx, dest, 1.364));
    },
  },
  /** Fire (effects): the low roar lapping up and down, a hiss, and sparse bright crackles, front-loaded. */
  fire: {
    channel: "effects",
    variation: 0.04,
    dur: 1.45,
    hero: true,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.739);
      const roar = lpf(ctx, 300 * rate, 1);
      roar.frequency.setValueAtTime(300 * rate, t);
      roar.frequency.exponentialRampToValueAtTime(1800 * rate, t + 0.25);
      roar.frequency.exponentialRampToValueAtTime(600 * rate, t + 1.2);
      const re = ctx.createGain();
      re.gain.setValueAtTime(0, t);
      re.gain.linearRampToValueAtTime(1, t + 0.25);
      re.gain.setValueAtTime(1, t + 0.35);
      re.gain.setTargetAtTime(0, t + 0.35, 0.35);
      noiseSrc(ctx, engine, "brown", t, 1.4).connect(roar).connect(re).connect(out);
      noiseSrc(ctx, engine, "white", t, 1.4)
        .connect(hpf(ctx, 2000))
        .connect(env(ctx, t, 0.15, 0.15, 0.3))
        .connect(out);
      for (let i = 0; i < 16; i++) {
        const at = t + 1.0 * Math.random() ** 1.6;
        noiseSrc(ctx, engine, "white", at, 0.05)
          .connect(bpf(ctx, 1500 + Math.random() * 3500, 3))
          .connect(env(ctx, at, 0.0005, (0.3 + Math.random() * 0.7) * 0.9, 0.006))
          .connect(out);
      }
    },
  },
  /** Cold (effects): brittle, high, fast-decaying tinkles in an irregular cluster — ice and glass. */
  cold: zzfxVariants("cold", "effects", [
    coldVariant([0, 1, 2, 3, 4, 5, 6, 7]),
    coldVariant([2, 5, 0, 7, 1, 3, 6, 4]),
    coldVariant([5, 3, 7, 1, 6, 0, 4, 2]),
  ]),
  /** Lightning (effects): a sharp crack, a second for the branch, and a flickering mains buzz dying away. */
  lightning: {
    channel: "effects",
    variation: 0.04,
    dur: 0.95,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.447);
      crack(ctx, engine, out, t, 1);
      crack(ctx, engine, out, t + 0.09, 0.6);
      const buzz = ctx.createGain();
      osc(ctx, "sawtooth", 60 * rate, t, 0.9).connect(buzz);
      const b2 = ctx.createGain();
      b2.gain.value = 0.5;
      osc(ctx, "sawtooth", 120.5 * rate, t, 0.9)
        .connect(b2)
        .connect(buzz);
      const gate = ctx.createGain();
      stepCurve(gate.gain, t, 0.9, 15, 40, (r) => (r() < 0.3 ? 0 : 0.4 + r() * 0.6));
      buzz
        .connect(hpf(ctx, 150))
        .connect(lpf(ctx, 3500))
        .connect(gate)
        .connect(envAHR(ctx, t, 0.005, 0.6, 0.15, 0.7))
        .connect(out);
    },
  },
  /** Thunder (effects): overlapping low bursts that roll, a sub drop with its octave, and the close crack. */
  thunder: {
    channel: "effects",
    variation: 0.04,
    dur: 3.2,
    hero: true,
    play(ctx, dest, t, rate, engine) {
      // (0.291 in the research mock; calibrated in /dev/sounds to the plan's −7.5 dBFS.)
      const out = outGain(ctx, dest, 0.375);
      const lp = lpf(ctx, 220 * rate);
      lp.frequency.setValueAtTime(220 * rate, t);
      lp.frequency.exponentialRampToValueAtTime(90 * rate, t + 3);
      const rum = ctx.createGain();
      rum.gain.value = 0;
      noiseSrc(ctx, engine, "brown", t, 3.2).connect(lp);
      for (const [at, a, p, tau] of [
        [0, 0.03, 1, 0.6],
        [0.35, 0.08, 0.7, 0.5],
        [0.9, 0.15, 0.5, 0.8],
      ] as const)
        lp.connect(env(ctx, t + at, a, p, tau)).connect(rum);
      rum.connect(out);
      const drive = ctx.createGain();
      drive.gain.value = 2;
      rum.connect(drive);
      exciter(ctx, drive, out, 3, 150, 1);
      const sub = osc(ctx, "sine", 60 * rate, t, 3.2);
      sub.frequency.exponentialRampToValueAtTime(42 * rate, t + 1.5);
      sub.connect(env(ctx, t, 0.02, 0.8, 0.8)).connect(out);
      const sub2 = osc(ctx, "sine", 120 * rate, t, 3.2);
      sub2.frequency.exponentialRampToValueAtTime(84 * rate, t + 1.5);
      sub2.connect(env(ctx, t, 0.02, 0.25, 0.8)).connect(out);
      noiseSrc(ctx, engine, "white", t, 0.2)
        .connect(hpf(ctx, 1500))
        .connect(env(ctx, t, 0.001, 0.4, 0.025))
        .connect(out);
    },
  },
  /** Acid (effects): a corrosive, fluttering hiss. */
  acid: {
    channel: "effects",
    variation: 0.04,
    dur: 0.7,
    play(ctx, dest, t, _rate, engine) {
      const flutter = ctx.createGain();
      stepCurve(flutter.gain, t, 0.7, 25, 25, (r) => 0.5 + r() * 0.5);
      noiseSrc(ctx, engine, "white", t, 0.7)
        .connect(hpf(ctx, 3000))
        .connect(bpf(ctx, 6000, 0.7))
        .connect(envAHR(ctx, t, 0.03, 1, 0.35, 0.3))
        .connect(flutter)
        .connect(outGain(ctx, dest, 0.216));
    },
  },
  /** Poison (effects): sickly low bubbling — bubbles rising in pitch as they form — over a murky bed. */
  poison: {
    channel: "effects",
    variation: 0.04,
    dur: 0.9,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.276);
      for (let i = 0; i < 12; i++) {
        const at = t + Math.random() * 0.7;
        const f0 = (180 + Math.random() * 240) * rate;
        const d = 0.03 + Math.random() * 0.03;
        const o = osc(ctx, "sine", f0, at, d * 4);
        o.frequency.exponentialRampToValueAtTime(1.6 * f0, at + d);
        o.connect(env(ctx, at, 0.002, 0.4 + Math.random() * 0.6, d / 3)).connect(out);
      }
      noiseSrc(ctx, engine, "brown", t, 0.8)
        .connect(lpf(ctx, 500))
        .connect(envAHR(ctx, t, 0.05, 0.3, 0.5, 0.2))
        .connect(out);
    },
  },
  /** Necrotic (effects): detuned low saws with a tritone, swelling and draining away. */
  necrotic: {
    channel: "effects",
    variation: 0.03,
    dur: 1.4,
    play(ctx, dest, t, rate) {
      const lp = lpf(ctx, 180, 6);
      lp.frequency.setValueAtTime(180, t);
      lp.frequency.exponentialRampToValueAtTime(700, t + 0.4);
      lp.frequency.exponentialRampToValueAtTime(150, t + 1.3);
      for (const [f, g] of [
        [55 * 2 ** (-14 / 1200), 1],
        [55, 1],
        [55 * 2 ** (11 / 1200), 1],
        [77.78, 0.6],
      ] as const) {
        const gg = ctx.createGain();
        gg.gain.value = g;
        osc(ctx, "sawtooth", f * rate, t, 1.35)
          .connect(gg)
          .connect(lp);
      }
      lp.connect(envAHR(ctx, t, 0.4, 1, 0.2, 0.7)).connect(outGain(ctx, dest, 0.102)); // (0.084 in the mock; calibrated to −10.5 dBFS)
    },
  },
  /** Radiant (effects): an "ah" choir — saws through /ɑ/ formants in fifths, with vibrato — and a quiet shimmer. */
  radiant: {
    channel: "effects",
    variation: 0.02,
    dur: 1.4,
    play(ctx, dest, t, rate) {
      const voices = ctx.createGain();
      const vib = osc(ctx, "sine", 5.5, t, 1.35);
      const vibDepth = ctx.createGain();
      vibDepth.gain.value = 5;
      vib.connect(vibDepth);
      for (const f of [220, 329.63, 440, 659.26])
        for (const d of [-7, 7]) {
          const o = osc(ctx, "sawtooth", f * rate, t, 1.35);
          o.detune.value = d;
          vibDepth.connect(o.detune);
          const g = ctx.createGain();
          g.gain.value = 0.5;
          o.connect(g).connect(voices);
        }
      const choir = ctx.createGain();
      voices.connect(bpf(ctx, 750, 5)).connect(choir);
      const f2 = ctx.createGain();
      f2.gain.value = 0.8;
      voices
        .connect(bpf(ctx, 940, 6))
        .connect(f2)
        .connect(choir);
      for (const [f, g] of [
        [1318.51, 0.15],
        [1760, 0.1],
      ] as const) {
        const gg = ctx.createGain();
        gg.gain.value = g;
        osc(ctx, "sine", f * rate, t, 1.35)
          .connect(gg)
          .connect(choir);
      }
      choir.connect(envAHR(ctx, t, 0.25, 1, 0.25, 0.8)).connect(outGain(ctx, dest, 0.231));
    },
  },
  /** Force (effects): a steady harmonic hum — a field — and a thump as it arrives. */
  force: {
    channel: "effects",
    variation: 0.03,
    dur: 0.8,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.117);
      const hum = ctx.createGain();
      for (const [f, g] of [
        [110, 1],
        [220, 0.5],
        [330, 0.3],
        [440, 0.15],
      ] as const) {
        const gg = ctx.createGain();
        gg.gain.value = g;
        osc(ctx, "sine", f * rate, t, 0.55)
          .connect(gg)
          .connect(hum);
      }
      hum.connect(envAHR(ctx, t, 0.08, 1, 0.2, 0.25)).connect(out);
      const at = t + 0.3;
      const th = osc(ctx, "sine", 85 * rate, at, 0.45);
      th.frequency.exponentialRampToValueAtTime(45 * rate, at + 0.12);
      const thEnv = env(ctx, at, 0.002, 1, 0.09);
      th.connect(thEnv);
      const thG = ctx.createGain();
      thG.gain.value = 1.2;
      thEnv.connect(thG).connect(out);
      exciter(ctx, thEnv, out, 4, 200, 1.2);
      const oct = osc(ctx, "sine", 170 * rate, at, 0.45);
      oct.frequency.exponentialRampToValueAtTime(90 * rate, at + 0.12);
      oct.connect(env(ctx, at, 0.002, 0.36, 0.09)).connect(out);
      noiseSrc(ctx, engine, "brown", at, 0.3)
        .connect(lpf(ctx, 350))
        .connect(env(ctx, at, 0.002, 1, 0.04))
        .connect(out);
    },
  },
  /** Psychic (effects): a warble that speeds up, beating against a second tone — purely tonal, no noise. */
  psychic: {
    channel: "effects",
    variation: 0.03,
    dur: 0.8,
    play(ctx, dest, t, rate) {
      const sum = ctx.createGain();
      const a = osc(ctx, "sine", 700 * rate, t, 0.75);
      const lfo = osc(ctx, "sine", 9, t, 0.75);
      lfo.frequency.linearRampToValueAtTime(14, t + 0.7);
      const depth = ctx.createGain();
      depth.gain.value = 60;
      lfo.connect(depth).connect(a.detune);
      a.connect(sum);
      const b = osc(ctx, "sine", 1050 * rate, t, 0.75);
      const lfo2 = osc(ctx, "sine", 7, t, 0.75);
      const depth2 = ctx.createGain();
      depth2.gain.value = 40;
      lfo2.connect(depth2).connect(b.detune);
      const bg = ctx.createGain();
      bg.gain.value = 0.5;
      b.connect(bg).connect(sum);
      sum.connect(envAHR(ctx, t, 0.1, 1, 0.35, 0.3)).connect(outGain(ctx, dest, 0.093));
    },
  },
} satisfies Record<string, Recipe>;
