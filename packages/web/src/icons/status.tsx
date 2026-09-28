import { type IconCategory, STATUS_ICONS, type StatusIconSource } from "@gloam/shared/icons";
import { useId } from "react";

const BY_ID = new Map<string, StatusIconSource>(STATUS_ICONS.map((i) => [i.id, i]));

/** An icon's source: a condition or marker id ("custom:…" markers and unknown ids draw the custom glyph). */
export function statusIcon(id: string): StatusIconSource {
  return BY_ID.get(id) ?? (BY_ID.get("custom") as StatusIconSource);
}

/** A badge's colour token (SPEC Appendix G categories). */
export const badgeColour = (c: IconCategory) => `var(--badge-${c})`;

/**
 * A condition or status icon (SPEC §30, Appendix G): the reference glyph, drawn in currentColor at 16–24 px; on a
 * badge of its category's colour where it marks a creature. Mask ids are made unique per instance (the same icon may
 * appear many times on a page).
 */
export function StatusIcon({
  id,
  size = 20,
  badge = false,
  label,
  className = "",
  glyph: glyphId,
  color,
}: {
  id: string;
  size?: number;
  badge?: boolean;
  /** A DM's custom marker: the icon it borrows and its own badge colour. */
  glyph?: string | undefined;
  color?: string | undefined;
  /** Its accessible name; defaults to the icon's name. Pass "" when a text label sits beside it. */
  label?: string;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const src = statusIcon(glyphId || id);
  const glyph = badge ? Math.round(size * 0.78) : size;
  const svg = src.svg
    .replaceAll('id="gx-', `id="gx-${uid}-`)
    .replaceAll("url(#gx-", `url(#gx-${uid}-`)
    .replace(
      'width="24" height="24"',
      `width="${glyph}" height="${glyph}" aria-hidden="true" focusable="false"`,
    );
  const name = label ?? (id.startsWith("custom:") ? id.slice(7).replaceAll("-", " ") : src.name);
  const cls = `inline-grid shrink-0 place-items-center ${badge ? "rounded-chip text-bone" : ""} ${className}`;
  const style = badge
    ? { width: size, height: size, background: color || badgeColour(src.category) }
    : { width: size, height: size };
  return name ? (
    <span role="img" aria-label={name} data-icon={src.id} className={cls} style={style}>
      <Glyph svg={svg} />
    </span>
  ) : (
    <span aria-hidden data-icon={src.id} className={cls} style={style}>
      <Glyph svg={svg} />
    </span>
  );
}

/** The glyph's markup: static SVG from the spec's own icon set (generated from Appendix G), never user content. */
function Glyph({ svg }: { svg: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the icons are the project's own SVG, not input
  return <span className="contents" dangerouslySetInnerHTML={{ __html: svg }} />;
}
