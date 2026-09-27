import { create } from "zustand";

/** What the board is showing right now — read by the test hooks (SPEC §23.7) and the perf overlay. */
export const boardDiag: {
  map: {
    kind: string;
    assetId?: string;
    variant?: string;
    width?: number;
    height?: number;
    style?: string;
  } | null;
  postfx: { bloom: boolean; ao: boolean; smaa: boolean; composer: boolean };
  firstFrameAt: number | null;
  tokenModes: Map<string, { mode: string; coin: number; standee: number }>;
} = {
  map: null,
  postfx: { bloom: false, ao: false, smaa: false, composer: false },
  firstFrameAt: null,
  tokenModes: new Map(),
};

/**
 * Board asset loads in flight (SPEC §8.3 Scene activation): a batch runs from the first load until nothing is pending;
 * `done / total` is its progress. A slow batch shows the parchment bar after 400 ms.
 */
interface LoadingStore {
  pending: number;
  total: number;
  done: number;
  since: number | null;
  begin(): () => void;
}
export const useLoading = create<LoadingStore>((set, get) => ({
  pending: 0,
  total: 0,
  done: 0,
  since: null,
  begin() {
    const s = get();
    set({ pending: s.pending + 1, total: s.total + 1, since: s.since ?? performance.now() });
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const cur = get();
      const pending = Math.max(0, cur.pending - 1);
      if (pending === 0) set({ pending: 0, total: 0, done: 0, since: null });
      else set({ pending, done: cur.done + 1 });
    };
  },
}));
