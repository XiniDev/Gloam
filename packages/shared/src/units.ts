import { FT_EPSILON } from "./constants.ts";

/** Display units for a campaign. All internal maths is in feet (SPEC §8.6 Units). */
export type Units = "ft" | "m";

/** The official convention: 5 ft = 1.5 m, so 1 ft = 0.3 m. */
export const METRES_PER_FOOT = 0.3;

/** Feet rounded to the nearest 0.5 ft. */
export function roundFeet(ft: number): number {
  const r = Math.round(ft * 2) / 2;
  return Object.is(r, -0) ? 0 : r;
}

/** Metres (5 ft = 1.5 m) rounded to 0.1 m. */
export function feetToMetres(ft: number): number {
  const r = Math.round(ft * METRES_PER_FOOT * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** "30 ft" or "9 m" (SPEC AC-MOV-12). */
export function formatDistance(ft: number, units: Units = "ft"): string {
  if (units === "m") return `${trimNumber(feetToMetres(ft))} m`;
  return `${trimNumber(roundFeet(ft))} ft`;
}

/** Just the number part, for compact labels. */
export function formatDistanceValue(ft: number, units: Units = "ft"): string {
  return units === "m" ? trimNumber(feetToMetres(ft)) : trimNumber(roundFeet(ft));
}

/** Budget comparison with the 0.05-ft epsilon: a 30.00001-ft path still fits a 30-ft budget. */
export function withinBudget(cost: number, budget: number): boolean {
  return cost <= budget + FT_EPSILON;
}

/** Converts user-entered metres back to feet (1.5 m = 5 ft). */
export function metresToFeet(m: number): number {
  return m / METRES_PER_FOOT;
}
