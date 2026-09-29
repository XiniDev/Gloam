import type { AudioEngine } from "./engine.ts";
import { COMBAT_SOUNDS } from "./sounds/combat.ts";
import { FLAVOUR_SOUNDS } from "./sounds/flavour.ts";
import { SPELL_SOUNDS } from "./sounds/spells.ts";
import {
  bpf,
  env,
  envAHR,
  exciter,
  lpf,
  noiseSrc,
  osc,
  outGain,
  type Recipe,
  rngFor,
  zzfx,
} from "./synth.ts";

export type { Recipe } from "./synth.ts";

/**
 * Sound recipes (SPEC §31, recipes from docs/research/sound.md §2). "WA" recipes are small Web Audio graphs;
 * "ZzFX" recipes render once into a cached buffer. Each plays into `dest` starting at `t`.
 */
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

/**
 * Stick-slip door creak (Farnell; sound.md §2.2 "Admitted"): friction pulses at a rate that climbs and falls (a 24-point
 * curve, each point jittered ±15 % from `seed` — a door's id gives each door its own voice) exciting the door's
 * formants, and a pink-noise squeal swept through a narrow band.
 */
export function creak(
  ctx: AudioContext,
  engine: AudioEngine,
  out: AudioNode,
  t: number,
  dur: number,
  seed: number,
): void {
  const r = rngFor(seed, 0xc4ea);
  const saw = osc(ctx, "sawtooth", 38, t, dur + 0.05);
  const pts = 24;
  for (let i = 0; i < pts; i++) {
    const u = i / (pts - 1);
    const base = u < 0.55 ? 38 + (90 - 38) * (u / 0.55) : 90 - (90 - 55) * ((u - 0.55) / 0.45);
    saw.frequency.setValueAtTime(base * (1 + ((r() / 2 ** 32) * 2 - 1) * 0.15), t + u * dur);
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
  body.connect(envAHR(ctx, t, 0.06, 1, Math.max(0, dur - 0.21), 0.15)).connect(out);
}

/** A latch (sound.md §2.2): two bright clicks 25 ms apart and the bolt's low knock. */
export function latch(ctx: AudioContext, engine: AudioEngine, out: AudioNode, t: number, g: number): void {
  for (const off of [0, 0.025])
    noiseSrc(ctx, engine, "white", t + off, 0.05)
      .connect(bpf(ctx, 3000, 5))
      .connect(env(ctx, t + off, 0.0002, 0.6 * g, 0.0015))
      .connect(out);
  osc(ctx, "sine", 110, t + 0.025, 0.28)
    .connect(env(ctx, t + 0.025, 0.001, 0.5 * g, 0.03))
    .connect(out);
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
    dur: 0.08,
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
    dur: 0.45,
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
    dur: 0.95,
    play(ctx, dest, t, _rate, engine, seed) {
      const out = outGain(ctx, dest, 0.165);
      creak(ctx, engine, out, t, 0.6, seed);
      latch(ctx, engine, out, t + 0.62, 1);
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
  /** Turn passes to someone else (UI, sound.md §2.2): the quietest UI sound — an atonal wooden tick. */
  turnPass: zzfx("turnPass", "ui", [
    { at: 0, p: [0.085, 0, 740, 0, 0, 0.035, 1, 1, -3, 0, 0, 0, 0, 0.3, 0, 0, 0, 0.25, 0.006, 0, 0] },
  ]),
  /** Soft rising chime (UI): a friendly notification (also the "Test sound" in the waiting room). */
  chime: {
    channel: "ui",
    variation: 0.015,
    dur: 1.7,
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
  /**
   * Your turn (UI, SPEC §31 "Warm bell"): two sines (660 Hz + 990 Hz) struck together with a 1.2-s decay, into a
   * soft room — a short, damped feedback delay — so it rings on without shouting.
   */
  yourTurn: {
    channel: "ui",
    variation: 0.015,
    dur: 3.5,
    play(ctx, dest, t, rate) {
      const out = outGain(ctx, dest, 0.22);
      // The room: a damped feedback delay the bell rings into (and out of, softly).
      const room = ctx.createDelay(0.5);
      room.delayTime.value = 0.09;
      const fb = ctx.createGain();
      fb.gain.value = 0.38;
      const damp = ctx.createBiquadFilter();
      damp.type = "lowpass";
      damp.frequency.value = 2400;
      const wet = ctx.createGain();
      wet.gain.value = 0.3;
      room.connect(damp).connect(fb).connect(room);
      damp.connect(wet).connect(out);
      for (const [f, p] of [
        [660, 1],
        [990, 0.6],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f * rate;
        const e = env(ctx, t, 0.004, p, 1.2 / 3);
        o.connect(e);
        e.connect(out);
        e.connect(room);
        o.start(t);
        o.stop(t + 3);
        o.onended = () => o.disconnect();
      }
      // The room's own nodes go when the tail has died away.
      const done = ctx.createConstantSource();
      done.offset.value = 0;
      done.connect(out);
      done.start(t);
      done.stop(t + 3.5);
      done.onended = () => {
        for (const n of [room, fb, damp, wet, done]) n.disconnect();
      };
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
    dur: 1.9,
    reverb: 0.35,
    hero: true,
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
  /**
   * A muffled footstep (effects, sound.md §2.3): a low, near-square thump — quiet, low and varied, since it's the most
   * repeated sound (±8 %; the caller alternates feet and pans it along the path).
   */
  footstep: zzfx(
    "footstep",
    "effects",
    [
      {
        at: 0,
        p: [0.097, 0, 105, 0.004, 0, 0.07, 0, 0.4, -0.6, 0, 0, 0, 0, 2, 0, 0, 0, 0.45, 0.02, 0, -450],
      },
    ],
    0.08,
  ),
  /** A door opening (effects, sound.md §2.3): its creak — each door its own, seeded by its id. */
  doorOpen: {
    channel: "effects",
    variation: 0.04,
    dur: 0.75,
    play(ctx, dest, t, _rate, engine, seed) {
      creak(ctx, engine, outGain(ctx, dest, 0.196), t, 0.7, seed);
    },
  },
  /** A door shutting (effects, sound.md §2.3): a low wooden thud with its octave, a brown-noise body and the latch. */
  doorClose: {
    channel: "effects",
    variation: 0.03,
    dur: 0.45,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.234);
      const low = osc(ctx, "sine", 110 * rate, t, 0.4);
      low.frequency.exponentialRampToValueAtTime(60 * rate, t + 0.1);
      const lowEnv = env(ctx, t, 0.002, 1, 0.07);
      low.connect(lowEnv).connect(out);
      exciter(ctx, lowEnv, out, 4, 200, 1.2);
      const oct = osc(ctx, "sine", 220 * rate, t, 0.4);
      oct.frequency.exponentialRampToValueAtTime(120 * rate, t + 0.1);
      oct.connect(env(ctx, t, 0.002, 0.3, 0.07)).connect(out);
      noiseSrc(ctx, engine, "brown", t, 0.35)
        .connect(lpf(ctx, 400))
        .connect(env(ctx, t, 0.002, 1.2, 0.05))
        .connect(out);
      latch(ctx, engine, out, t + 0.06, 0.4);
    },
  },
  /** A locked door rattling (effects, sound.md §2.3): an irregular triple metallic click and the bolt against the frame. */
  lockRattle: {
    channel: "effects",
    variation: 0.04,
    dur: 0.3,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.272);
      for (const [off, g, k] of [
        [0, 1, 1],
        [0.07, 0.8, 1.06],
        [0.125, 0.9, 0.95],
      ] as const) {
        const src = noiseSrc(ctx, engine, "white", t + off, 0.03);
        src
          .connect(bpf(ctx, 3000 * k * rate, 6))
          .connect(env(ctx, t + off, 0.0003, g, 0.004))
          .connect(out);
        src
          .connect(bpf(ctx, 4700 * k * rate, 8))
          .connect(env(ctx, t + off, 0.0003, 0.6 * g, 0.004))
          .connect(out);
      }
      osc(ctx, "sine", 140, t, 0.25)
        .connect(env(ctx, t, 0.001, 0.5, 0.025))
        .connect(out);
      osc(ctx, "sine", 280, t, 0.25)
        .connect(env(ctx, t, 0.001, 0.15, 0.025))
        .connect(out);
    },
  },
  /**
   * A ping (UI, sound.md §2.6): an 880 Hz sine with its metallic 2.756× partial into a 180-ms delay loop through a
   * low-pass — decaying echoes that say "look here". Panned and distance-attenuated like a board sound.
   */
  ping: {
    channel: "ui",
    variation: 0.02,
    dur: 1.4,
    play(ctx, dest, t, rate) {
      const out = outGain(ctx, dest, 0.123);
      const dry = ctx.createGain();
      dry.connect(out);
      osc(ctx, "sine", 880 * rate, t, 0.9)
        .connect(env(ctx, t, 0.002, 1, 0.12))
        .connect(dry);
      osc(ctx, "sine", 2425 * rate, t, 0.3)
        .connect(env(ctx, t, 0.002, 0.15, 0.03))
        .connect(dry);
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.18;
      const lp = lpf(ctx, 3000);
      const fb = ctx.createGain();
      fb.gain.value = 0.35;
      dry.connect(delay);
      delay.connect(lp).connect(fb).connect(delay);
      fb.connect(out);
      const done = ctx.createConstantSource();
      done.offset.value = 0;
      done.connect(out);
      done.start(t);
      done.stop(t + 1.5);
      done.onended = () => {
        for (const n of [dry, delay, lp, fb, done]) n.disconnect();
      };
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
  nat20: zzfx(
    "nat20",
    "dice",
    [
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
      {
        at: 180,
        p: [0.074, 0, 2000, 0.04, 0.15, 0.55, 4, 1, 0, 0, 0, 0, 0.035, 0, 0, 0, 0, 1, 0, 0.8, 3500],
      },
    ],
    0.04,
    { hero: true },
  ),
  /** Natural 1: a soft, brassy deflating "womp" — quieter and shorter than the natural 20. */
  nat1: zzfx("nat1", "dice", [
    { at: 0, p: [0.113, 0, 196, 0.02, 0.18, 0.4, 2, 1, -0.2, -0.5, 0, 0, 0, 0.1, 0, 0, 0, 1, 0, 0, -450] },
    { at: 0, p: [0.079, 0, 198, 0.02, 0.18, 0.4, 2, 1, -0.2, -0.5, 0, 0, 0, 0.1, 0, 0, 0, 1, 0, 0, -450] },
  ]),
  ...COMBAT_SOUNDS,
  ...SPELL_SOUNDS,
  ...FLAVOUR_SOUNDS,
} satisfies Record<string, Recipe>;

export type SfxName = keyof typeof RECIPES;
