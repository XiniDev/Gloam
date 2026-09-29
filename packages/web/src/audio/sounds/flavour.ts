import { bpf, env, envAHR, hpf, noiseSrc, osc, outGain, type Recipe, zzfx } from "../synth.ts";

/** Table flavour (SPEC §31; docs/research/sound.md §2.6): emotes, the raised hand, handouts and scene travel. */

/** A paper swish: pink noise through a band swept up then down, over its own envelope. */
function swish(
  ctx: AudioContext,
  engine: Parameters<Recipe["play"]>[4],
  out: AudioNode,
  t: number,
  a: number,
  r: number,
  g: number,
): void {
  const b = bpf(ctx, 1200, 0.9);
  b.frequency.setValueAtTime(1200, t);
  b.frequency.exponentialRampToValueAtTime(2400, t + a);
  b.frequency.exponentialRampToValueAtTime(1500, t + a + r);
  noiseSrc(ctx, engine, "pink", t, a + r)
    .connect(b)
    .connect(envAHR(ctx, t, a, g, 0, r))
    .connect(out);
}

export const FLAVOUR_SOUNDS = {
  /** An emote popping up (UI, panned to its token or portrait): a tiny rising bubble "bloop". */
  emotePop: zzfx("emotePop", "ui", [
    { at: 0, p: [0.125, 0, 380, 0.001, 0, 0.07, 0, 1, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.01, 0, 0] },
  ]),
  /** A raised hand (UI, the DM only, once): a single soft bell that won't talk over anyone on voice. */
  handRaised: zzfx(
    "handRaised",
    "ui",
    [
      { at: 0, p: [0.24, 0, 783.99, 0.003, 0.03, 0.9, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0.09, 0.45, 0.05, 0, 0] },
      { at: 0, p: [0.048, 0, 2160.6764, 0.001, 0, 0.25, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.02, 0, 0] },
    ],
    0.02,
  ),
  /** A handout unfurling (UI): three paper swishes and a fine rustle fading out — parchment laid on the table. */
  handoutReveal: {
    channel: "ui",
    variation: 0.03,
    dur: 0.8,
    play(ctx, dest, t, _rate, engine) {
      // (0.465 in the research mock; calibrated in /dev/sounds to the plan's −12 dBFS.)
      const out = outGain(ctx, dest, 0.613);
      swish(ctx, engine, out, t, 0.08, 0.18, 1);
      swish(ctx, engine, out, t + 0.15, 0.06, 0.15, 0.8);
      swish(ctx, engine, out, t + 0.3, 0.08, 0.25, 0.6);
      for (let i = 0; i < 40; i++) {
        const u = Math.random() * 0.6;
        noiseSrc(ctx, engine, "white", t + u, 0.02)
          .connect(hpf(ctx, 2500))
          .connect(env(ctx, t + u, 0.0002, (0.2 + Math.random() * 0.6) * (1 - u / 0.8) * 0.6, 0.001))
          .connect(out);
      }
    },
  },
  /** Travelling to another scene (UI): a low whoosh sweeping down with the fade through black. */
  sceneTravel: {
    channel: "ui",
    variation: 0.03,
    dur: 1.25,
    play(ctx, dest, t, rate, engine) {
      const out = outGain(ctx, dest, 0.464);
      const b = bpf(ctx, 1800 * rate, 1.2);
      b.frequency.setValueAtTime(1800 * rate, t);
      b.frequency.exponentialRampToValueAtTime(250 * rate, t + 1.1);
      noiseSrc(ctx, engine, "pink", t, 1.2)
        .connect(b)
        .connect(envAHR(ctx, t, 0.35, 1, 0.1, 0.7))
        .connect(out);
      for (const [f, p] of [
        [55, 0.3],
        [110, 0.15],
      ] as const)
        osc(ctx, "sine", f * rate, t, 1.15)
          .connect(envAHR(ctx, t, 0.4, p, 0, 0.7))
          .connect(out);
    },
  },
} satisfies Record<string, Recipe>;
