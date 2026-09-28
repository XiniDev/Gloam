import type { TokenView } from "@gloam/shared/state";

export interface ElevationViewer {
  userId: string;
  dm: boolean;
}

/** Who may raise or lower this token: a DM always; its controller when it can fly (SPEC §8.6 Speeds and modes). */
export function canRaise(t: TokenView, viewer: ElevationViewer): boolean {
  if (viewer.dm) return true;
  return t.ownerIds.includes(viewer.userId) && (t.own?.speedFly ?? 0) > 0;
}

/** Whether the elevation control is worth showing: a flyer, or anything already off the ground. */
export function showsElevation(t: TokenView): boolean {
  return (t.own?.speedFly ?? 0) > 0 || Math.abs(t.elevation) > 0.01;
}

/** A height as §8.5 writes it: "+15 ft", "−5 ft" (a true minus), "0 ft". */
export function heightLabel(elevation: number): string {
  const n = Math.round(elevation);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)} ft`;
}
