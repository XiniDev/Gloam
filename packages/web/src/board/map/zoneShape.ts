import type { WorldZoneShape } from "@gloam/shared/movement";

/** A zone's shape from its synced JSON, or null. */
export function parseZoneShape(json: string): WorldZoneShape | null {
  try {
    const s = JSON.parse(json) as WorldZoneShape;
    return s && typeof s === "object" && "kind" in s ? s : null;
  } catch {
    return null;
  }
}
