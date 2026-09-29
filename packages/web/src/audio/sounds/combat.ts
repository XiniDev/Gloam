import type { AudioEngine } from "../engine.ts";
import { bpf, env, exciter, lpf, noiseSrc, osc, outGain, type Recipe, zzfx } from "../synth.ts";

/**
 * Tokens, combat, death saves and conditions (SPEC §31; docs/research/sound.md §2.3–2.4, §2.6 "Initiative start").
 */

/** thump(t, f0 → f1, τ, g): a low sine drop with its octave, a brown-noise body and the exciter (death saves). */
function thump(
  ctx: AudioContext,
  engine: AudioEngine,
  out: AudioNode,
  t: number,
  f0: number,
  f1: number,
  tau: number,
  g: number,
): void {
  const low = osc(ctx, "sine", f0, t, 0.5);
  low.frequency.exponentialRampToValueAtTime(f1, t + 0.06);
  const lowEnv = env(ctx, t, 0.003, g, tau);
  low.connect(lowEnv).connect(out);
  exciter(ctx, lowEnv, out, 4, 180, 1.4);
  const oct = osc(ctx, "sine", 2 * f0, t, 0.5);
  oct.frequency.exponentialRampToValueAtTime(2 * f1, t + 0.06);
  oct.connect(env(ctx, t, 0.003, 0.3 * g, tau)).connect(out);
  noiseSrc(ctx, engine, "brown", t, 0.3)
    .connect(lpf(ctx, 200))
    .connect(env(ctx, t, 0.003, 0.8 * g, 0.04))
    .connect(out);
}

/** One hit of a war drum (sound.md §2.6): a membrane's modes (1, 1.593, 2.135, 2.295 ×), the skin's slap, a beater. */
function drumHit(
  ctx: AudioContext,
  engine: AudioEngine,
  out: AudioNode,
  t: number,
  g: number,
  k: number,
): void {
  const low = osc(ctx, "sine", 95 * k, t, 1.2);
  low.frequency.exponentialRampToValueAtTime(68 * k, t + 0.06);
  const lowEnv = env(ctx, t, 0.0015, g, 0.22);
  low.connect(lowEnv).connect(out);
  exciter(ctx, lowEnv, out, 5, 200, 1.5);
  for (const [f, p, tau] of [
    [111.5, 0.5, 0.12],
    [149.5, 0.35, 0.08],
    [160.7, 0.25, 0.07],
  ] as const)
    osc(ctx, "sine", f * k, t, 0.6)
      .connect(env(ctx, t, 0.0015, p * g, tau))
      .connect(out);
  const n = noiseSrc(ctx, engine, "white", t, 0.2);
  n.connect(bpf(ctx, 900, 1.2))
    .connect(env(ctx, t, 0.0005, 0.5 * g, 0.012))
    .connect(out);
  n.connect(lpf(ctx, 1500))
    .connect(env(ctx, t, 0.0005, 0.6 * g, 0.025))
    .connect(out);
}

/** The eight condition families (§27.2 badge colours): one glassy timbre, told apart by contour and rhythm. */
const CONDITION_BLIPS = {
  conditionVital: [
    0.089, 0, 523.25, 0.002, 0.05, 0.12, 0, 1, 0, 0, -83.25, 0.06, 0, 0, 0, 0, 0, 0.6, 0.02, 0, 0,
  ],
  conditionIncapacity: [
    0.088, 0, 587.33, 0.002, 0.04, 0.12, 0, 1, -1.2, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.02, 0, 0,
  ],
  conditionBody: [0.105, 0, 659.26, 0.001, 0.02, 0.09, 1, 1, 0, 0, 0, 0, 0, 0.2, 0, 0, 0, 0.5, 0.01, 0, 0],
  conditionAffliction: [
    0.096, 0, 783.99, 0.002, 0.06, 0.1, 0, 1, 0, 0, 0, 0, 0.025, 0.6, 0, 0, 0, 0.7, 0.02, 0.5, 0,
  ],
  conditionTactical: [0.105, 0, 880, 0.001, 0, 0.05, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.008, 0, 0],
  conditionSenses: [
    0.151, 0, 1046.5, 0.002, 0.02, 0.08, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.6, 0.015, 0, 0,
  ],
  conditionMind: [0.122, 0, 1174.66, 0.002, 0.1, 0.1, 0, 1, 0, 0, 0, 0, 0.083, 0, 0, 0, 0, 0.7, 0.02, 0.6, 0],
  conditionBoon: [
    0.089, 0, 1318.51, 0.002, 0.05, 0.14, 0, 1, 0, 0, 441.49, 0.05, 0, 0, 0, 0, 0, 0.6, 0.02, 0, 0,
  ],
} as const;
const GLASS = 2.756;

function conditionBlip(name: keyof typeof CONDITION_BLIPS): Recipe {
  const main = CONDITION_BLIPS[name];
  const f = main[2];
  const glassVol = main[0] * 0.18;
  // Pitch carries the family: ±1 % only.
  return zzfx(
    name,
    "ui",
    [
      { at: 0, p: [...main] },
      {
        at: 0,
        p: [glassVol, 0, f * GLASS, 0.001, 0, 0.05, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.01, 0, 0],
      },
    ],
    0.01,
  );
}

export const COMBAT_SOUNDS = {
  /** A mini lifted off the felt (effects): rising and light. */
  tokenPickUp: zzfx("tokenPickUp", "effects", [
    { at: 0, p: [0.074, 0, 260, 0.002, 0, 0.035, 0, 1, 2, 0, 0, 0, 0, 1.2, 0, 0, 0, 0.35, 0.01, 0, -700] },
  ]),
  /** …and set down: falling and firmer. */
  tokenPutDown: zzfx("tokenPutDown", "effects", [
    {
      at: 0,
      p: [0.094, 0, 170, 0.001, 0, 0.05, 0, 0.5, -1.5, 0, 0, 0, 0, 1.2, 0, 0, 0, 0.35, 0.012, 0, -700],
    },
  ]),
  /** A melee hit (effects): a noisy contact transient, a low body thump and its harmonic for small speakers. */
  meleeHit: zzfx("meleeHit", "effects", [
    { at: 0, p: [0.17, 0, 600, 0, 0, 0.07, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 0.012, 0, -1400] },
    {
      at: 0,
      p: [0.213, 0, 95, 0.002, 0.02, 0.12, 0, 0.5, -0.6, 0, 0, 0, 0, 0.4, 0, 0, 0, 0.6, 0.03, 0, -600],
    },
    { at: 0, p: [0.074, 0, 190, 0.002, 0, 0.08, 0, 1, -1.2, 0, 0, 0, 0, 0.4, 0, 0, 0, 0.6, 0.02, 0, 0] },
  ]),
  /** A death save's success (UI): a heartbeat — still alive. */
  deathSaveSuccess: {
    channel: "ui",
    variation: 0.02,
    dur: 0.5,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.256);
      thump(ctx, engine, out, t, 75 * rate, 55 * rate, 0.07, 1);
      thump(ctx, engine, out, t + 0.15, 90 * rate, 65 * rate, 0.05, 0.75);
    },
  },
  /** …and its failure: one hollow knock — emptiness. */
  deathSaveFail: {
    channel: "ui",
    variation: 0.02,
    dur: 0.65,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.843);
      const n = noiseSrc(ctx, engine, "white", t, 0.6);
      const tube = env(ctx, t, 0.001, 1, 0.11);
      n.connect(bpf(ctx, 220 * rate, 12))
        .connect(tube)
        .connect(out);
      const upper = env(ctx, t, 0.001, 0.6, 0.11);
      n.connect(bpf(ctx, 500 * rate, 10))
        .connect(upper)
        .connect(out);
      const drive = ctx.createGain();
      drive.gain.value = 4;
      tube.connect(drive);
      exciter(ctx, drive, out, 3, 250, 0.5);
      osc(ctx, "sine", 220 * rate, t, 0.4)
        .connect(env(ctx, t, 0.001, 0.3, 0.06))
        .connect(out);
      n.connect(bpf(ctx, 1500, 2))
        .connect(env(ctx, t, 0.0003, 0.3, 0.002))
        .connect(out);
    },
  },
  ...(Object.fromEntries(
    (Object.keys(CONDITION_BLIPS) as (keyof typeof CONDITION_BLIPS)[]).map((k) => [k, conditionBlip(k)]),
  ) as Record<keyof typeof CONDITION_BLIPS, Recipe>),
  /** Initiative (effects): a war drum's "da-DUM" into the hall — combat begins. */
  initiativeStart: {
    channel: "effects",
    variation: 0.03,
    dur: 1.5,
    reverb: 0.3,
    hero: true,
    play(ctx, dest, t, rate, engine) {
      // (0.30 in the research mock; calibrated in /dev/sounds to the plan's −6 dBFS.)
      const out = outGain(ctx, dest, 0.247);
      drumHit(ctx, engine, out, t, 0.8, rate);
      drumHit(ctx, engine, out, t + 0.38, 1, rate);
    },
  },
} satisfies Record<string, Recipe>;

export type ConditionSound = keyof typeof CONDITION_BLIPS;
