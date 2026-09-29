import { audio } from "./engine.ts";
import { RECIPES, type SfxName } from "./recipes.ts";

/**
 * Level measurement for the sound audition page (SPEC §31, docs/research/sound.md §6.7): each recipe rendered once in an
 * OfflineAudioContext at 48 kHz with its channel at unity, its sample peak and its loudest BS.1770 momentary loudness
 * (400-ms windows, K-weighted) read back — the evidence that every event sounds, and at its place in the level plan.
 */

/** The level plan (sound.md §2.7): each event's measured peak at the channel input, dBFS. */
export const PLAN_PEAK_DB: Partial<Record<SfxName, number>> = {
  diceTrayResin: -9.9,
  diceDieResin: -12,
  diceSettle: -20,
  nat20: -7.5,
  nat1: -10.5,
  yourTurn: -12,
  turnPass: -21.9,
  knock: -10.5,
  admitted: -12,
  tokenPickUp: -23.1,
  tokenPutDown: -20,
  footstep: -20,
  doorOpen: -10.5,
  doorClose: -9.1,
  lockRattle: -14,
  meleeHit: -8,
  damage: -10.5,
  heal: -14,
  down: -6,
  deathSaveSuccess: -10.5,
  deathSaveFail: -10.5,
  conditionVital: -20,
  conditionIncapacity: -20,
  conditionBody: -20,
  conditionAffliction: -20,
  conditionTactical: -20,
  conditionSenses: -20,
  conditionMind: -20,
  conditionBoon: -20,
  spellCast: -11.1,
  fire: -6,
  cold: -10.5,
  lightning: -6,
  thunder: -7.5,
  acid: -14,
  poison: -10.5,
  necrotic: -10.5,
  radiant: -14,
  force: -12,
  psychic: -17.1,
  emotePop: -18.4,
  ping: -17.1,
  handRaised: -15.9,
  handoutReveal: -12,
  initiativeStart: -6,
  sceneTravel: -12,
  error: -18.4,
};

/** BS.1770 K-weighting at 48 kHz: the shelf, then the high-pass (sound.md §6.7). */
const K1 = { b: [1.53512486, -2.69169619, 1.19839281], a: [1, -1.69065929, 0.73248077] };
const K2 = { b: [1, -2, 1], a: [1, -1.99004745, 0.99007225] };

function biquad(x: Float32Array, c: { b: number[]; a: number[] }): Float32Array {
  const y = new Float32Array(x.length);
  const [b0, b1, b2] = c.b as [number, number, number];
  const [, a1, a2] = c.a as [number, number, number];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] as number;
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = yi;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
  }
  return y;
}

/** Sample peak (dBFS) and the loudest momentary loudness (LUFS) of mono samples at 48 kHz. */
export function measureSamples(x: Float32Array, sampleRate = 48000): { peakDb: number; lufsM: number } {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const k = biquad(biquad(x, K1), K2);
  const win = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  // Short sounds are measured over one window (zero-padded), as a meter would.
  let best = 0;
  for (let s = 0; s === 0 || s + win <= k.length; s += hop) {
    let sum = 0;
    for (let i = s; i < Math.min(k.length, s + win); i++) sum += (k[i] as number) ** 2;
    best = Math.max(best, sum / win);
  }
  return {
    peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
    lufsM: best > 0 ? -0.691 + 10 * Math.log10(best) : Number.NEGATIVE_INFINITY,
  };
}

/** One recipe rendered offline at unity (rate 1: no per-play variation), mixed to mono. */
export async function renderRecipe(name: SfxName): Promise<Float32Array> {
  audio.ensure();
  const recipe = RECIPES[name];
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * (recipe.dur + 2)), sr);
  const reverbless = ctx.createGain();
  reverbless.connect(ctx.destination);
  recipe.play(ctx as unknown as AudioContext, reverbless, 0.01, 1, audio, 7);
  const buf = await ctx.startRendering();
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const mono = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) mono[i] = ((l[i] as number) + (r[i] as number)) / 2;
  return mono;
}

/**
 * A recipe's level: the median of five renders — most recipes draw on noise and random choices (a clack's band, a
 * crackle's timing), so one render's peak can land a few dB either side of the sound's typical one.
 */
export async function measureRecipe(name: SfxName): Promise<{ peakDb: number; lufsM: number }> {
  const runs: { peakDb: number; lufsM: number }[] = [];
  for (let i = 0; i < 5; i++) runs.push(measureSamples(await renderRecipe(name)));
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  return { peakDb: median(runs.map((r) => r.peakDb)), lufsM: median(runs.map((r) => r.lufsM)) };
}
