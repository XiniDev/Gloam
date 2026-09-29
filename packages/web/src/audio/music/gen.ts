import type { MusicPreset } from "@gloam/shared/protocol";
import { hash32, rngFor } from "../synth.ts";

/**
 * The generative music presets' notes (SPEC §25.5, docs/research/sound.md §4.2 and §4.6–4.9). Every decision is a pure
 * function of (seed, preset, layer, bar) — integer arithmetic on counter-based hashes, no `Math.random`, no
 * transcendental functions — so every client generates the same notes, in any order, from any bar: a late joiner
 * starts mid-piece, and nothing depends on having played what came before. Where a rule needs history (no progression
 * twice running, a chord walk) the look-back is bounded (the previous phrase, the start of the section).
 */

export type VoiceKind =
  | "padSaw" // Dungeon: detuned saws through a slowly swept low-pass
  | "padSawHigh"
  | "subPulse" // Dungeon: a low sine thump
  | "bell" // Dungeon: a distant additive bell
  | "pluck" // Tavern: Karplus–Strong
  | "pluckBass"
  | "frameDrum" // Tavern: x (low), s (slap), g (ghost)
  | "ostinato" // Battle: filtered square
  | "tom" // Battle: low / mid tom, and the big hit
  | "swell" // Battle: layered saws with a slow attack
  | "sinePad" // Wonder: sine stack
  | "fmBell" // Wonder: glassy FM bell motifs
  | "twinkle"; // Wonder: a high sine sparkle

export interface NoteEvent {
  /** Seconds from its bar's start (a pad may begin before its bar: it fades in across the change). */
  t: number;
  voice: VoiceKind;
  /** MIDI note numbers (one, or a chord). */
  notes: number[];
  /** Its length in seconds (envelopes, sustained voices). */
  dur: number;
  /** 0–1. */
  vel: number;
  /** Stereo position −1…1. */
  pan?: number;
  /** A drum's stroke ("x", "s", "g" / "L", "M", "B"). */
  stroke?: string;
}

export interface Layer {
  id: number;
  /** The bars before now whose notes may still be sounding (pads, bells): a late start plays them from part-way. */
  lookback: number;
  gen(seed: number, bar: number): NoteEvent[];
}

export interface PresetDef {
  id: MusicPreset;
  /** A bar in seconds (Dungeon's "bar" is its 4-s slot). */
  barSec: number;
  /** Reverb (RT60 s, sound.md §4.4). */
  rt60: number;
  layers: Layer[];
}

const PRESET_ID: Record<MusicPreset, number> = { dungeon: 1, tavern: 2, battle: 3, wonder: 4 };

/** A uint32 stream for one set of coordinates, and integer helpers over it. */
function rand(...k: number[]) {
  const r = rngFor(...k);
  return {
    /** 0…n−1. */
    int: (n: number) => r() % n,
    /** True with pct % chance. */
    chance: (pct: number) => r() % 100 < pct,
    /** A float in [0, 1) (for timing and levels, never for a decision). */
    unit: () => r() / 4294967296,
  };
}

/** A pick by weights (integers summing to 100). */
function weighted(roll: number, weights: [number, number][]): number {
  let acc = 0;
  for (const [v, w] of weights) {
    acc += w;
    if (roll < acc) return v;
  }
  return (weights.at(-1) as [number, number])[0];
}

// ── Dungeon drone — D Aeolian, free time (sound.md §4.6) ─────────────────────────────────────────────────────

const SLOT = 4;
const SECTION = 12;
/** i, iv, v, VI, VII: root in octave 2 and whether the triad is minor. */
const DUNGEON_CHORDS = [
  { root: 38, minor: true }, // i  Dm
  { root: 43, minor: true }, // iv Gm
  { root: 45, minor: true }, // v  Am
  { root: 46, minor: false }, // VI B♭
  { root: 36, minor: false }, // VII C
];
/** The walk from each chord (percent). */
const DUNGEON_WALK: [number, number][][] = [
  [
    [0, 35],
    [1, 20],
    [2, 10],
    [3, 25],
    [4, 10],
  ],
  [
    [0, 50],
    [2, 25],
    [3, 25],
  ],
  [
    [0, 60],
    [3, 40],
  ],
  [
    [0, 40],
    [1, 30],
    [4, 30],
  ],
  [
    [0, 50],
    [3, 50],
  ],
];

/** A section's chords: [start slot, length in slots, chord], walked from its first (random access by section). */
function dungeonSection(seed: number, section: number): { at: number; len: number; chord: number }[] {
  const r = rand(seed, 1, 0xc40d, section);
  let chord = section % 3 === 0 ? 0 : ([0, 3, 1][r.int(3)] as number);
  const out: { at: number; len: number; chord: number }[] = [];
  let at = 0;
  while (at < SECTION) {
    const len = Math.min([4, 5, 6][r.int(3)] as number, SECTION - at);
    out.push({ at, len, chord });
    at += len;
    chord = weighted(r.int(100), DUNGEON_WALK[chord] as [number, number][]);
  }
  return out;
}

function dungeonChordAt(seed: number, slot: number): (typeof DUNGEON_CHORDS)[number] {
  const section = Math.floor(slot / SECTION);
  const inSection = slot - section * SECTION;
  const c = dungeonSection(seed, section).find((x) => inSection >= x.at && inSection < x.at + x.len);
  return DUNGEON_CHORDS[c?.chord ?? 0] as (typeof DUNGEON_CHORDS)[number];
}

/** A section's sub pulses (seconds into it): the first at 0–3 s, then 6–10 s apart, only before 42 s. */
function dungeonPulses(seed: number, section: number): number[] {
  const r = rand(seed, 1, 0x5b, section);
  const out: number[] = [];
  let t = r.int(4);
  while (t < 42) {
    out.push(t);
    t += 6 + r.int(5);
  }
  return out;
}

const dungeon: PresetDef = {
  id: "dungeon",
  barSec: SLOT,
  rt60: 4.5,
  layers: [
    {
      // The pads: each chord fades in over 6 s, starting 3 s before it, and out across the next.
      id: 1,
      lookback: 7,
      gen(seed, slot) {
        const section = Math.floor(slot / SECTION);
        const inSection = slot - section * SECTION;
        const c = dungeonSection(seed, section).find((x) => x.at === inSection);
        if (!c) return [];
        const ch = DUNGEON_CHORDS[c.chord] as (typeof DUNGEON_CHORDS)[number];
        const third = ch.minor ? 3 : 4;
        const dur = c.len * SLOT + 6;
        return [
          { t: -3, voice: "padSaw", notes: [ch.root, ch.root + 7, ch.root + 12], dur, vel: 1 },
          {
            t: -3,
            voice: "padSawHigh",
            notes: [ch.root + 12 + third, ch.root + 19, ch.root + 24],
            dur,
            vel: 1,
          },
        ];
      },
    },
    {
      // The sub pulse: at least 6 s apart across section boundaries, without looking back.
      id: 2,
      lookback: 1,
      gen(seed, slot) {
        const section = Math.floor(slot / SECTION);
        const base = (slot - section * SECTION) * SLOT;
        const ch = dungeonChordAt(seed, slot);
        let root = ch.root;
        while (440 * 2 ** ((root - 69) / 12) > 82) root -= 12;
        return dungeonPulses(seed, section)
          .filter((t) => t >= base && t < base + SLOT)
          .map((t) => ({ t: t - base, voice: "subPulse" as const, notes: [root], dur: 3, vel: 1 }));
      },
    },
    {
      // A distant bell: seven sections in ten, somewhere between 4 and 40 s in, on the chord's root or fifth.
      id: 3,
      lookback: 2,
      gen(seed, slot) {
        const section = Math.floor(slot / SECTION);
        const r = rand(seed, 1, 0xbe11, section);
        if (!r.chance(70)) return [];
        const at = 4 + r.int(36) + r.int(1000) / 1000;
        const base = (slot - section * SECTION) * SLOT;
        if (at < base || at >= base + SLOT) return [];
        const ch = dungeonChordAt(seed, section * SECTION + Math.floor(at / SLOT));
        const note = ch.root + 24 + (r.chance(50) ? 0 : 7);
        return [{ t: at - base, voice: "bell", notes: [note], dur: 7, vel: 0.8 }];
      },
    },
  ],
};

// ── Tavern — G major pentatonic, 96 BPM, 6/8 (sound.md §4.7) ───────────────────────────────────────────────

const TAVERN_BAR = 1.25;
const EIGHTH = TAVERN_BAR / 6;
/** I, IV, V, vi: the bass root and the chord's pentatonic tones (pitch classes). */
const TAVERN_CHORDS = [
  { bass: 43, tones: [7, 11, 2] }, // I  (G B D)
  { bass: 48, tones: [4, 7, 9] }, // IV (E G A over C)
  { bass: 50, tones: [2, 9, 11] }, // V  (D A B)
  { bass: 40, tones: [4, 7, 11] }, // vi (E G B)
];
const TAVERN_PROGS = [
  [0, 1, 0, 2],
  [0, 3, 1, 2],
  [3, 1, 0, 2],
  [0, 2, 3, 1],
  [1, 0, 2, 0],
];
const PENTA = [7, 9, 11, 2, 4]; // G A B D E

/** A phrase's progression: hashed, never the previous phrase's own pick twice running. */
function progPick(seed: number, preset: number, phrase: number, n: number): number {
  const raw = (p: number) => hash32(seed, preset, 0x9a, p) % n;
  const mine = raw(phrase);
  if (phrase > 0 && mine === raw(phrase - 1))
    return (mine + 1 + (hash32(seed, preset, 0x9b, phrase) % (n - 1))) % n;
  return mine;
}

/** The pentatonic notes of a chord between two MIDI notes, as a ladder. */
function ladder(tones: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (tones.includes(m % 12)) out.push(m);
  return out;
}

function tavernChord(seed: number, bar: number) {
  const prog = TAVERN_PROGS[progPick(seed, 2, Math.floor(bar / 4), TAVERN_PROGS.length)] as number[];
  return TAVERN_CHORDS[prog[bar % 4] as number] as (typeof TAVERN_CHORDS)[number];
}

const ARP_PATTERNS = [
  [0, 1, 2, 3, 2, 1],
  [0, 2, 1, 3, 2, 4],
  [0, 1, 2, 1, 3, 2],
  [0, 2, 4, 3, 1, 2],
  [2, 1, 0, 1, 2, 3],
];
const DRUM_PATTERNS = ["x.gs.g", "xggs.g", "x.gsgg"];

const tavern: PresetDef = {
  id: "tavern",
  barSec: TAVERN_BAR,
  rt60: 1.1,
  layers: [
    {
      // The arpeggio: a 5-bar cycle of patterns with a hashed rotation, rests and grace notes.
      id: 1,
      lookback: 1,
      gen(seed, bar) {
        const ch = tavernChord(seed, bar);
        const lad = ladder(ch.tones, 55, 76);
        const pat = ARP_PATTERNS[(bar + (hash32(seed, 2, 0xa1, Math.floor(bar / 5)) % 5)) % 5] as number[];
        const r = rand(seed, 2, 0xa2, bar);
        const out: NoteEvent[] = [];
        pat.forEach((step, i) => {
          if (r.chance(15)) return;
          const note = lad[Math.min(step, lad.length - 1)] as number;
          const vel = ((60 + r.int(30)) / 127) ** 2 * 0.9;
          if (r.chance(10)) {
            const up = lad[Math.min(step + 1, lad.length - 1)] as number;
            out.push({
              t: Math.max(0, i * EIGHTH - EIGHTH / 2),
              voice: "pluck",
              notes: [up],
              dur: 0.8,
              vel: vel * 0.6,
            });
          }
          out.push({ t: i * EIGHTH, voice: "pluck", notes: [note], dur: 1.2, vel });
        });
        return out;
      },
    },
    {
      // The melody: fragments an octave up in bars 0–3 of a 7-bar cycle; its last note rings.
      id: 2,
      lookback: 1,
      gen(seed, bar) {
        if (bar % 7 > 3) return [];
        const ch = tavernChord(seed, bar);
        const r = rand(seed, 2, 0xe1, bar);
        const scale = ladder(PENTA, 67, 88);
        const root = scale.findIndex((m) => m % 12 === (ch.tones[0] as number));
        const out: NoteEvent[] = [];
        for (let i = 0; i < 6; i++) {
          if (!r.chance(55)) continue;
          const idx = Math.max(0, Math.min(scale.length - 1, root + r.int(5)));
          out.push({ t: i * EIGHTH, voice: "pluck", notes: [scale[idx] as number], dur: 0.7, vel: 0.35 });
        }
        const lastNote = out.at(-1);
        if (lastNote && bar % 7 === 3) lastNote.dur = 1.6;
        return out;
      },
    },
    {
      // The frame drum: a 3-bar cycle of 6/8 patterns, a fill on the last bar of every eight, humanised.
      id: 3,
      lookback: 1,
      gen(seed, bar) {
        const pattern = bar % 8 === 7 ? "xgssgs" : (DRUM_PATTERNS[bar % 3] as string);
        const r = rand(seed, 2, 0xd1, bar);
        const out: NoteEvent[] = [];
        [...pattern].forEach((c, i) => {
          if (c === ".") return;
          const human = (r.int(17) - 8) / 1000;
          const vel = c === "x" ? 0.9 : c === "s" ? 0.75 : 0.45 + r.int(20) / 100;
          out.push({
            t: Math.max(0, i * EIGHTH + human),
            voice: "frameDrum",
            notes: [],
            dur: 0.4,
            vel,
            stroke: c,
          });
        });
        return out;
      },
    },
    {
      // The bass: the root on the first eighth, the fifth on the fourth (seven bars in ten).
      id: 4,
      lookback: 1,
      gen(seed, bar) {
        const ch = tavernChord(seed, bar);
        const r = rand(seed, 2, 0xba, bar);
        const out: NoteEvent[] = [{ t: 0, voice: "pluckBass", notes: [ch.bass], dur: 1.8, vel: 0.8 }];
        if (r.chance(70))
          out.push({ t: 3 * EIGHTH, voice: "pluckBass", notes: [ch.bass + 7], dur: 1.2, vel: 0.6 });
        return out;
      },
    },
  ],
};

// ── Battle — E Phrygian, 110 BPM, 4/4 (sound.md §4.8) ─────────────────────────────────────────────────────

const BATTLE_BAR = (60 / 110) * 4;
const SIXTEENTH = BATTLE_BAR / 16;
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
/** Chords by scale degree of their root: i = 0, ♭II = 1, iv = 3, ♭VI = 5, ♭VII = 6. */
const BATTLE_PROGS = [
  [0, 1, 0, 6],
  [0, 5, 6, 0],
  [0, 3, 1, 0],
  [5, 6, 0, 0],
];
const OSTINATO = [
  [0, 0, 7, 0, 0, 0, 1, 0, 0, 0, 7, 0, 0, 1, 0, 2],
  [0, 7, 0, 0, 1, 0, 0, 7, 0, 0, 2, 0, 1, 0, 0, -1],
  [0, 0, 1, 0, 0, 0, 2, 1, 0, 0, 1, 0, 4, 3, 2, 1],
];
const ACCENTS = new Set([0, 3, 6, 8, 11, 14]);
const TOMS: Record<string, string> = {
  A: "L..L..M.L..L..MM",
  B: "L...M.L.L..M..L.",
  C: "L.M.L.M.L..LM.L.",
};
const TOM_SEQUENCE = "ABAACBA";
const TOM_FILL = "L.M.LM.MLLMMLMLM";

/** A Phrygian degree (0 = E, may run past an octave or below) as MIDI, from E2. */
const phrygian = (d: number) => 40 + 12 * Math.floor(d / 7) + (PHRYGIAN[((d % 7) + 7) % 7] as number);

function battleChord(seed: number, bar: number): number {
  const phrase = Math.floor(bar / 8);
  const prog = BATTLE_PROGS[progPick(seed, 3, phrase, BATTLE_PROGS.length)] as number[];
  return prog[Math.floor((bar % 8) / 2)] as number;
}

const battle: PresetDef = {
  id: "battle",
  barSec: BATTLE_BAR,
  rt60: 1.8,
  layers: [
    {
      // The ostinato: one of three cells (a 3-bar cycle, rotated per phrase), rests and neighbour notes, 3-3-2 accents.
      id: 1,
      lookback: 1,
      gen(seed, bar) {
        const root = battleChord(seed, bar);
        const cell = OSTINATO[(bar + (hash32(seed, 3, 0x05, Math.floor(bar / 8)) % 3)) % 3] as number[];
        const r = rand(seed, 3, 0x06, bar);
        const out: NoteEvent[] = [];
        cell.forEach((deg, i) => {
          if (r.chance(8)) return;
          const d = r.chance(10) ? deg + (r.chance(50) ? 1 : -1) : deg;
          let note = phrygian(root + d);
          while (note > 52) note -= 12;
          while (note < 40) note += 12;
          out.push({
            t: i * SIXTEENTH,
            voice: "ostinato",
            notes: [note],
            dur: 0.15,
            vel: ACCENTS.has(i) ? 1 : 0.65,
          });
        });
        return out;
      },
    },
    {
      // Low toms: a 7-bar sequence of patterns, a fill closing each phrase, the big hit opening it, ghost notes.
      id: 2,
      lookback: 1,
      gen(seed, bar) {
        const pattern = bar % 8 === 7 ? TOM_FILL : (TOMS[TOM_SEQUENCE[bar % 7] as string] as string);
        const r = rand(seed, 3, 0x70, bar);
        const out: NoteEvent[] = [];
        if (bar % 8 === 0) out.push({ t: 0, voice: "tom", notes: [], dur: 1.4, vel: 0.7, stroke: "B" });
        [...pattern].forEach((c, i) => {
          if (c === "." && r.chance(10))
            out.push({ t: i * SIXTEENTH, voice: "tom", notes: [], dur: 0.4, vel: 0.3, stroke: "M" });
          else if (c !== ".")
            out.push({ t: i * SIXTEENTH, voice: "tom", notes: [], dur: 0.5, vel: 0.9, stroke: c });
        });
        return out;
      },
    },
    {
      // The string swell: every eight bars from bar 4, cresting into the phrase's turn; its voicing rotates.
      id: 3,
      lookback: 4,
      gen(seed, bar) {
        if (bar % 8 !== 4) return [];
        const root = battleChord(seed, bar);
        const inversion = Math.floor(bar / 8) % 3;
        const tones = [0, 2, 4].map((d) => phrygian(root + d) + 12);
        const rotated = [...tones.slice(inversion), ...tones.slice(0, inversion).map((m) => m + 12)];
        return [{ t: 0, voice: "swell", notes: [phrygian(root), ...rotated], dur: 6.9, vel: 1 }];
      },
    },
  ],
};

// ── Wonder — A Lydian, 72 BPM, 4/4 (sound.md §4.9) ─────────────────────────────────────────────────────────

const WONDER_BAR = (60 / 72) * 4;
const WONDER_EIGHTH = WONDER_BAR / 8;
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
/** Chords by degree: I = 0, II = 1, iii = 2, V = 4, vi = 5. */
const WONDER_PROGS = [
  [0, 1, 0, 1],
  [0, 1, 5, 2],
  [0, 2, 1, 0],
  [5, 1, 0, 4],
];
const MOTIFS = [
  [4, 5, 6],
  [2, 3, 4, 6],
  [0, 1, 2, 4],
  [6, 4, 3, 1],
  [3, 4, 6, 7],
];
const RHYTHMS = [
  [0, 1, 2],
  [0, 2, 3, 4],
  [0, 1, 3, 4, 6],
];
/** A Lydian degree as MIDI, from A3. */
const lydian = (d: number) => 57 + 12 * Math.floor(d / 7) + (LYDIAN[((d % 7) + 7) % 7] as number);

function wonderChord(seed: number, bar: number): number {
  const prog = WONDER_PROGS[progPick(seed, 4, Math.floor(bar / 8), WONDER_PROGS.length)] as number[];
  return prog[Math.floor((bar % 8) / 2)] as number;
}

const wonder: PresetDef = {
  id: "wonder",
  barSec: WONDER_BAR,
  rt60: 3.5,
  layers: [
    {
      // The airy pad: each chord's stack fading in across the change (2.5 s in, 3 s out); the ♯11 on I.
      id: 1,
      lookback: 3,
      gen(seed, bar) {
        if (bar % 2 !== 0) return [];
        const d = wonderChord(seed, bar);
        const notes = [lydian(d), lydian(d + 4), lydian(d + 2) + 12, lydian(d) + 12];
        const out: NoteEvent[] = [{ t: -1.25, voice: "sinePad", notes, dur: 2 * WONDER_BAR + 2.75, vel: 1 }];
        if (d === 0)
          out.push({
            t: -1.25,
            voice: "sinePad",
            notes: [lydian(3) + 24],
            dur: 2 * WONDER_BAR + 2.75,
            vel: 0.3,
          });
        return out;
      },
    },
    {
      // Glassy bell motifs: bars 1, 3, 4 and 6 of a 7-bar cycle, four in five; placed so they start on a chord tone.
      id: 2,
      lookback: 2,
      gen(seed, bar) {
        if (![1, 3, 4, 6].includes(bar % 7)) return [];
        const r = rand(seed, 4, 0xfb, bar);
        if (!r.chance(80)) return [];
        const motif = MOTIFS[r.int(MOTIFS.length)] as number[];
        const rhythm = RHYTHMS[r.int(RHYTHMS.length)] as number[];
        const chord = wonderChord(seed, bar);
        const chordTones = [chord % 7, (chord + 2) % 7, (chord + 4) % 7];
        // Transposed so its first note is the nearest chord tone, in A5–E7.
        const first = motif[0] as number;
        const shift = (chordTones.map((c) => (c - first + 7) % 7).sort((a, b) => a - b)[0] ?? 0) + 14;
        const n = Math.min(motif.length, rhythm.length);
        const out: NoteEvent[] = [];
        for (let i = 0; i < n; i++)
          out.push({
            t: (rhythm[i] as number) * WONDER_EIGHTH,
            voice: "fmBell",
            notes: [lydian((motif[i] as number) + shift)],
            dur: 3,
            vel: 0.8 - i * 0.08,
          });
        return out;
      },
    },
    {
      // Twinkles: a fifth of the eighths, high and panned (the shimmer itself is continuous, from the timeline).
      id: 3,
      lookback: 1,
      gen(seed, bar) {
        const r = rand(seed, 4, 0x7e, bar);
        const out: NoteEvent[] = [];
        for (let i = 0; i < 8; i++)
          if (r.chance(20)) {
            const semis = r.int(12);
            out.push({
              t: i * WONDER_EIGHTH,
              voice: "twinkle",
              notes: [102 + semis],
              dur: 0.4,
              vel: 0.15,
              pan: (r.int(121) - 60) / 100,
            });
          }
        return out;
      },
    },
  ],
};

export const PRESETS: Record<MusicPreset, PresetDef> = { dungeon, tavern, battle, wonder };

/** A preset's notes for one bar of one layer. */
export function genBar(preset: MusicPreset, seed: number, layer: Layer, bar: number): NoteEvent[] {
  return layer.gen(hash32(seed, PRESET_ID[preset]), bar);
}

export const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/**
 * A preset's slow, continuous movements τ seconds into it (sound.md §4.6–4.9): filter sweeps and swells on prime or
 * odd periods, so they don't line up with the bars and the whole doesn't repeat for tens of minutes. Computed from τ
 * (not accumulated), so every client — and a late joiner — has the same at the same moment.
 */
export function drift(preset: MusicPreset, seed: number, tau: number): Record<string, number> {
  const TAU = 2 * Math.PI;
  switch (preset) {
    case "dungeon": {
      const phase = ((hash32(seed, 1, 0xf1) % 360) * Math.PI) / 180;
      return {
        cutA: 280 * 2 ** (1.7 * (0.5 + 0.5 * Math.sin((TAU * tau) / 47))),
        cutB: 600 + 2000 * (0.5 + 0.5 * Math.sin((TAU * tau) / 61 + phase)),
      };
    }
    case "battle":
      return { cutFactor: 1 + 0.3 * Math.sin((TAU * tau) / (17 * BATTLE_BAR)) };
    case "wonder":
      return {
        sway: 1 + 0.1 * Math.sin((TAU * tau) / (5 * WONDER_BAR)),
        shimmer: 0.5 + 0.5 * Math.sin((TAU * tau) / (11 * WONDER_BAR)),
      };
    default:
      return {};
  }
}
