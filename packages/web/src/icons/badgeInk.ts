import { BOARD_COLORS } from "@gloam/shared";

/** WCAG relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The ink a glyph takes on a badge of a DM's chosen colour (a custom marker): bone on a dark badge, ink on a light
 * one — whichever reads more (bone on Citrine or Silver is barely 1.2:1). The category badges are dark by design and
 * always take bone. Anything but #RRGGBB: bone.
 */
export function glyphInk(badge: string): "bone" | "ink" {
  if (!HEX.test(badge)) return "bone";
  return contrastRatio(BOARD_COLORS.bone100, badge) >= contrastRatio(BOARD_COLORS.ink950, badge)
    ? "bone"
    : "ink";
}
