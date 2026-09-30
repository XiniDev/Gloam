/**
 * Rolls on the wire (SPEC §8.9, §18.3): the feed fetched on each connection (`dice.feed`), then every `roll.result`
 * and `roll.masked` as they come; rolling goes through `dice.roll` / `dice.manual`, the server deciding every die.
 */
import type { MaskedRoll, RollRecord, RollVisibility } from "@gloam/shared/dice";
import { create } from "zustand";
import { type FeedRoll, useRolls } from "../dice/state.ts";
import { useSettings } from "../state/settings.ts";
import { provideTestHook } from "../test/hooks.ts";
import type { LoadState, LoadStatus } from "../ui/Loadable.tsx";
import { request, tableEvents, useTable } from "./table.ts";

let asked = "";
let seq = 0;

/** The feed's fetch for this connection (the Rolls panel's loading and failed states, AC-DS-05). */
const useFeedLoad = create<{ status: LoadStatus; error: string | null }>(() => ({
  status: "loading",
  error: null,
}));

export function useFeedState(): LoadState {
  const status = useFeedLoad((s) => s.status);
  const error = useFeedLoad((s) => s.error);
  return { status, error, retry: () => void loadFeed() };
}

export async function loadFeed(): Promise<void> {
  const my = ++seq;
  useFeedLoad.setState({ status: "loading", error: null });
  try {
    const list = await request<FeedRoll[]>("dice.feed", {});
    if (my !== seq) return;
    useRolls.getState().reset(list);
    useFeedLoad.setState({ status: "ready" });
  } catch (e) {
    // (Asked again on the next connection, or with Try again.)
    if (my === seq) useFeedLoad.setState({ status: "error", error: (e as Error).message || null });
  }
}

function check(): void {
  const room = useTable.getState().room;
  const k = room ? `${room.roomId}|${room.sessionId}` : "";
  if (k === asked) return;
  asked = k;
  if (k) void loadFeed();
}

/** Starts watching (once per page): the feed on each connection, rolls as they come. */
export function watchDice(): () => void {
  if (__GLOAM_TEST__) {
    provideTestHook("rollArrivals", () => rollArrivals.slice());
    provideTestHook("rollFeed", () => useRolls.getState().feed);
    provideTestHook("reloadFeed", () => loadFeed());
  }
  const off = useTable.subscribe(check);
  const offMsg = tableEvents.on("message", ({ type, payload }) => {
    if (type === "roll.result" || type === "roll.masked") onRoll(payload as RollRecord | MaskedRoll);
  });
  check();
  return () => {
    off();
    offMsg();
  };
}

/**
 * A roll or masked card arrived: into the feed, and onto the tray unless dice animation is off (then the total shows
 * at once). Reduced motion still shows the dice, resting (the overlay's choice).
 */
export function onRoll(r: RollRecord | MaskedRoll): void {
  // How long after the server decided it this client had it (test hooks; same machine, same clock).
  if (__GLOAM_TEST__) {
    rollArrivals.push({ id: r.id, lagMs: Date.now() - r.at });
    if (rollArrivals.length > 50) rollArrivals.shift();
  }
  useRolls.getState().add(r, useSettings.getState().diceAnimation);
}
export const rollArrivals: { id: string; lagMs: number }[] = [];

export interface RollRequest {
  formula: string;
  label?: string;
  visibility: RollVisibility;
  purpose?: string;
  /** Rolled for a creature: its `@` references answer from its token and sheet. */
  tokenId?: string;
  /** Rolled from a character's sheet. */
  actorId?: string;
}

export function rollDice(p: RollRequest): Promise<RollRecord> {
  const { tokenId, actorId, ...rest } = p;
  const context = { ...(tokenId ? { tokenId } : {}), ...(actorId ? { actorId } : {}) };
  return request<RollRecord>("dice.roll", { ...rest, ...(tokenId || actorId ? { context } : {}) });
}

export function enterManual(p: {
  formula: string;
  values?: number[];
  total?: number;
  label?: string;
  visibility: RollVisibility;
}): Promise<RollRecord> {
  return request<RollRecord>("dice.manual", p);
}
