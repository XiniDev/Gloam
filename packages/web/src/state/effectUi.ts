import type { P } from "@gloam/shared/geometry";
import { create } from "zustand";

/** An effect being dragged by its handle: where it stood, where it would go, its reach a move (players). */
export interface EffectDrag {
  effectId: string;
  from: P;
  to: P;
  maxFt: number | null;
}

/** Striking again at a point in an effect (Call Lightning's next bolt): its radius, where the pointer is. */
export interface EffectStrike {
  effectId: string;
  radius: number;
  at: P | null;
}

/**
 * The board's lasting-effect handles (SPEC §8.13 Persistent effects "movement rules"): which one is picked (its chip
 * shows what can be done with it), a drag under way, a strike being aimed.
 */
export const useEffectUi = create<{
  selected: string | null;
  drag: EffectDrag | null;
  strike: EffectStrike | null;
  set(p: Partial<{ selected: string | null; drag: EffectDrag | null; strike: EffectStrike | null }>): void;
}>((set) => ({
  selected: null,
  drag: null,
  strike: null,
  set: (p) => set(p),
}));
