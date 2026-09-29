/** The tabs' gap (`gap-0.5`). */
export const TAB_GAP = 2;

/**
 * Which tabs a row of `avail` px shows (§29.7): all of them when they fit; otherwise the first ones in their fixed
 * order while they fit beside the More button, and the section being read — when it's one of the rest — in the last
 * of those places (the others never move).
 */
export function visibleTabs(
  widths: readonly number[],
  moreW: number,
  avail: number,
  active: number,
  gap = TAB_GAP,
): number[] {
  const all = widths.map((_, k) => k);
  const w = (k: number) => (widths[k] ?? 0) + gap;
  if (all.reduce((a, k) => a + w(k), 0) <= avail) return all;
  const room = avail - moreW - gap;
  const shown: number[] = [];
  let used = 0;
  for (const k of all) {
    if (used + w(k) > room) break;
    shown.push(k);
    used += w(k);
  }
  if (shown.includes(active)) return shown;
  // The last places give way to the active one until it fits.
  while (shown.length && used + w(active) > room) used -= w(shown.pop() as number);
  return [...shown, active];
}
