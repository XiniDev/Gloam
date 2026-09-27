import { BOARD_COLORS, CB_BOARD_COLORS, DISPOSITION_COLORS } from "@gloam/shared";
import type { TokenView } from "@gloam/shared/state";
import { Color } from "three";

/** Board colours come from the shared constants (SPEC §27.2: shader code imports the same values as the tokens). */
export const C = BOARD_COLORS;

const cache = new Map<string, Color>();
/** A linear-space THREE.Color for a hex string (cached; don't mutate the result). */
export function col(hex: string): Color {
  let c = cache.get(hex);
  if (!c) {
    c = new Color(hex);
    cache.set(hex, c);
  }
  return c;
}

/** The base ring colour: the owner's player colour for party tokens, else the disposition colour. */
export function ringColorOf(t: Pick<TokenView, "ringColor" | "disposition">, colorBlind: boolean): string {
  if (t.ringColor) return t.ringColor;
  if (t.disposition === "party") return C.brass400;
  const d = (t.disposition === "friendly" || t.disposition === "neutral" ? t.disposition : "hostile") as
    | "hostile"
    | "friendly"
    | "neutral";
  return colorBlind ? CB_BOARD_COLORS[d] : DISPOSITION_COLORS[d];
}

/** HP fill colour by fraction (SPEC §8.5: verdigris above 50 %, brass 26–50 %, ember at 25 % and below). */
export function hpColor(frac: number, colorBlind: boolean): string {
  if (frac > 0.5) return colorBlind ? CB_BOARD_COLORS.hpHigh : C.verdigris400;
  if (frac > 0.25) return colorBlind ? CB_BOARD_COLORS.hpMid : C.brass400;
  return colorBlind ? CB_BOARD_COLORS.hpLow : C.ember400;
}

/** Walls overlay colours by kind (SPEC §8.7): the DM's view, from the board palette. */
export const WALL_COLORS = {
  wall: C.bone100,
  door: C.brass400,
  window: C.ice300,
  curtain: C.hex400,
  invisible: C.arcane400,
  secret: C.ember400,
  occluder: C.bone100,
} as const;
