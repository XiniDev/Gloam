export * from "./blocking.ts";
export * from "./build.ts";
export * from "./nav.ts";
export * from "./route.ts";
export * from "./spawn.ts";
export * from "./validate.ts";
export * from "./world.ts";
export * from "./zones.ts";

/** The longest one move may be (ft): the server's per-foot work on a move (§15.6) stays bounded. */
export const MAX_MOVE_FT = 2000;

/** The longest route one move may take in a scene: four times its diagonal, and never more than MAX_MOVE_FT. */
export function maxMoveLength(bounds: { minX: number; minY: number; maxX: number; maxY: number }): number {
  const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  return Math.min(MAX_MOVE_FT, 4 * diag);
}
