/** One column's width, and the narrowest screen that takes two (then there's nothing to scroll). */
export const COLUMN = 340;
const TWO_COLUMNS_FROM = 1024;
export const EDGE = 12;
export const TOP = 64;
/** Room kept between the popover and a panel it stands beside. */
const GAP = 8;

type Box = { left: number; right: number; top: number; bottom: number };
export interface SettingsPlace {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  columns: 1 | 2;
  /** It stands in the open panel's place, exactly over it. */
  inPanel: boolean;
}

/**
 * Where the popover goes (critic RSP-01 r1–r2): never half over anything — a rail button or a panel's search field
 * showing at its edge read as a glitch.
 * 1. Under its gear, its right edge in line with the gear's, inside the screen with a 12-px gutter, as tall as the
 *    screen leaves; two columns from 1024 px (nothing to scroll), else one.
 * 2. Half over the dock's rail: clear to the rail's left.
 * 3. Half over an open dock panel: clear to the panel's left — in two columns or one — where that doesn't lie across
 *    the board's tool column; else it takes the panel's place, exactly over it.
 */
export function placeSettings(
  gear: { right: number },
  covers: { rail?: Box | undefined; panel?: Box | undefined; tools?: number },
  screen: { w: number; h: number },
): SettingsPlace {
  const tools = covers.tools ?? 0;
  const maxHeight = Math.max(160, screen.h - TOP - EDGE);
  const fits = (left: number) => left >= Math.max(EDGE, tools);
  const overlaps = (left: number, right: number, b: Box | undefined) =>
    Boolean(b && right > b.left && left < b.right);
  for (const columns of screen.w >= TWO_COLUMNS_FROM ? ([2, 1] as const) : ([1] as const)) {
    const width = Math.min(columns * COLUMN, screen.w - 2 * EDGE);
    let right = Math.min(gear.right, screen.w - EDGE);
    if (overlaps(right - width, right, covers.rail)) right = (covers.rail as Box).left - GAP;
    if (overlaps(right - width, right, covers.panel)) right = (covers.panel as Box).left - GAP;
    const left = Math.max(EDGE, right - width);
    if (
      fits(left) &&
      !overlaps(left, left + width, covers.panel) &&
      !overlaps(left, left + width, covers.rail)
    )
      return { left, top: TOP, width, maxHeight, columns, inPanel: false };
  }
  const p = covers.panel;
  if (p)
    return {
      left: p.left,
      top: p.top,
      width: p.right - p.left,
      maxHeight: p.bottom - p.top,
      columns: 1,
      inPanel: true,
    };
  // (No panel, and no room clear of the rail: over the rail whole, at the screen's right gutter.)
  const width = Math.min(COLUMN, screen.w - 2 * EDGE);
  return { left: screen.w - EDGE - width, top: TOP, width, maxHeight, columns: 1, inPanel: false };
}
