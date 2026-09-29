import { MUSIC_PRESETS } from "@gloam/shared/protocol";
import { describe, expect, it } from "vitest";
import { drift, genBar, PRESETS } from "./gen.ts";

/** One bar of a preset as heard: its notes (every layer) and where its slow movements stand. */
function barSignature(
  preset: (typeof MUSIC_PRESETS)[number],
  seed: number,
  bar: number,
  withDrift = true,
): string {
  const def = PRESETS[preset];
  const notes = def.layers.map((l) =>
    genBar(preset, seed, l, bar)
      .map((e) => `${e.voice}:${e.notes.join(",")}@${e.t.toFixed(3)}~${e.vel.toFixed(2)}${e.stroke ?? ""}`)
      .join(" "),
  );
  const d = withDrift ? drift(preset, seed, bar * def.barSec) : {};
  const moving = Object.entries(d)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(",");
  return `${notes.join(" | ")} || ${moving}`;
}

/**
 * The generative presets' notes (AC-AUD-06; docs/research/sound.md §4.10): pure — the same bar the same, whatever
 * order it's made in (a late joiner starts mid-piece) and on every client (one seed) — and without audible loop
 * points for ten minutes: no 8-bar stretch comes round again, and nineteen bars in twenty differ.
 */
describe("P11 — generative music presets (AUD-06)", () => {
  for (const preset of MUSIC_PRESETS) {
    const def = PRESETS[preset];
    const bars = Math.ceil(600 / def.barSec);
    it(`${preset}: forward and backward alike, and the same for the same seed; another seed plays other notes`, () => {
      const seed = 918273;
      const forward = Array.from({ length: bars }, (_, b) => barSignature(preset, seed, b));
      const backward = Array.from({ length: bars }, (_, i) =>
        barSignature(preset, seed, bars - 1 - i),
      ).reverse();
      expect(backward).toEqual(forward);
      const other = Array.from({ length: bars }, (_, b) => barSignature(preset, 4242, b));
      expect(other).not.toEqual(forward);
      // It isn't silent: every layer plays in ten minutes.
      for (const l of def.layers) {
        const n = Array.from({ length: bars }, (_, b) => genBar(preset, seed, l, b).length).reduce(
          (a, b) => a + b,
        );
        expect(n, `layer ${l.id}`).toBeGreaterThan(0);
      }
    });
    it(`${preset}: ten minutes (${bars} bars of ${def.barSec.toFixed(2)} s) without a repeated 8-bar stretch; ≥ 95 % of bars distinct`, () => {
      for (const seed of [1, 777, 2026]) {
        const sig = Array.from({ length: bars }, (_, b) => barSignature(preset, seed, b));
        expect(new Set(sig).size / bars, `seed ${seed}`).toBeGreaterThanOrEqual(0.95);
        // The notes alone, too — the filters' slow sweeps aside: no 8-bar stretch of them comes round again.
        const notes = Array.from({ length: bars }, (_, b) => barSignature(preset, seed, b, false));
        const noteWindows = new Set<string>();
        for (let b = 0; b + 8 <= bars; b++) {
          const w = notes.slice(b, b + 8).join("\n");
          expect(noteWindows.has(w), `seed ${seed}: the notes of bars ${b}–${b + 7} repeat`).toBe(false);
          noteWindows.add(w);
        }
        const windows = new Set<string>();
        for (let b = 0; b + 8 <= bars; b++) {
          const w = sig.slice(b, b + 8).join("\n");
          expect(windows.has(w), `seed ${seed}: bars ${b}–${b + 7} repeat an earlier stretch`).toBe(false);
          windows.add(w);
        }
      }
    });
  }

  it("keeps its notes in their scales and registers", () => {
    const pcs = (preset: (typeof MUSIC_PRESETS)[number], voices: string[]) => {
      const out = new Set<number>();
      const def = PRESETS[preset];
      for (let b = 0; b < 200; b++)
        for (const l of def.layers)
          for (const e of genBar(preset, 5, l, b))
            if (voices.includes(e.voice)) for (const n of e.notes) out.add(n % 12);
      return [...out].sort((a, b) => a - b);
    };
    // Tavern's plucks: G major pentatonic (G A B D E), and the bass's C of IV.
    expect(pcs("tavern", ["pluck"])).toEqual([2, 4, 7, 9, 11]);
    // Battle: E Phrygian (E F G A B C D).
    for (const pc of pcs("battle", ["ostinato", "swell"])) expect([4, 5, 7, 9, 11, 0, 2]).toContain(pc);
    // Wonder: A Lydian (A B C♯ D♯ E F♯ G♯).
    for (const pc of pcs("wonder", ["sinePad", "fmBell"])) expect([9, 11, 1, 3, 4, 6, 8]).toContain(pc);
    // Dungeon: D Aeolian (D E F G A B♭ C).
    for (const pc of pcs("dungeon", ["padSaw", "padSawHigh", "bell", "subPulse"]))
      expect([2, 4, 5, 7, 9, 10, 0]).toContain(pc);
  });
});
