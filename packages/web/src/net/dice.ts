/**
 * Rolls on the wire (SPEC §8.9, §18.3): the feed fetched on each connection (`dice.feed`), then every `roll.result`
 * and `roll.masked` as they come; rolling goes through `dice.roll` / `dice.manual`, the server deciding every die.
 */
import type { MaskedRoll, RollRecord, RollVisibility } from "@gloam/shared/dice";
import { type FeedRoll, useRolls } from "../dice/state.ts";
import { useSettings } from "../state/settings.ts";
import { request, tableEvents, useTable } from "./table.ts";

let asked = "";
let seq = 0;

export async function loadFeed(): Promise<void> {
  const my = ++seq;
  try {
    const list = await request<FeedRoll[]>("dice.feed", {});
    if (my !== seq) return;
    useRolls.getState().reset(list);
  } catch {
    // Not connected any more; the next connection asks again.
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
  useRolls.getState().add(r, useSettings.getState().diceAnimation);
}

export interface RollRequest {
  formula: string;
  label?: string;
  visibility: RollVisibility;
  purpose?: string;
  tokenId?: string;
}

export function rollDice(p: RollRequest): Promise<RollRecord> {
  return request<RollRecord>("dice.roll", p);
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
