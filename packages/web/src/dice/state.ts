/**
 * The roll feed and the throws in flight (SPEC §8.9). The feed is what this client was sent — whole rolls or masked
 * cards (§18.3), newest first; a roll's total shows on its card once its 3D dice have settled (or at once when
 * dice are off, or for rolls older than this page).
 */
import type { MaskedRoll, RollRecord } from "@gloam/shared/dice";
import { create } from "zustand";

export type FeedRoll = RollRecord | MaskedRoll;

export const isMasked = (r: FeedRoll): r is MaskedRoll => "masked" in r && r.masked === true;

const FEED_MAX = 100;

interface RollsState {
  feed: FeedRoll[];
  /** Rolls whose dice are still tumbling: their cards wait for them. */
  rolling: ReadonlySet<string>;
  /** Throws to play, oldest first (the overlay takes them). */
  queue: FeedRoll[];
  add(r: FeedRoll, animate: boolean): void;
  settle(id: string): void;
  /** The feed as the server holds it (on joining): nothing to throw. */
  reset(list: FeedRoll[]): void;
  take(): FeedRoll | undefined;
}

/** The 3D dice are on the board (thrown, resting or fading): HUD that would take their room steps aside. */
export const useDiceStage = create<{ on: boolean }>(() => ({ on: false }));

export const useRolls = create<RollsState>((set, get) => ({
  feed: [],
  rolling: new Set(),
  queue: [],
  add(r, animate) {
    const s = get();
    if (s.feed.some((x) => x.id === r.id)) return;
    const feed = [r, ...s.feed].slice(0, FEED_MAX);
    if (!animate || r.manual || r.tumble.length === 0) {
      set({ feed });
      return;
    }
    set({ feed, rolling: new Set([...s.rolling, r.id]), queue: [...s.queue, r] });
  },
  settle(id) {
    const s = get();
    if (!s.rolling.has(id)) return;
    const rolling = new Set(s.rolling);
    rolling.delete(id);
    set({ rolling });
  },
  reset(list) {
    set({ feed: list.slice(0, FEED_MAX), rolling: new Set(), queue: [] });
  },
  take() {
    const s = get();
    const [first, ...rest] = s.queue;
    if (first) set({ queue: rest });
    return first;
  },
}));
