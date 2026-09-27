import type { SceneView } from "@gloam/shared/state";

/** Parsed scene fields (the synchronised Scene schema carries its nested documents as JSON). */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface Calibration {
  ftPerPx?: number;
  imageW?: number;
  imageH?: number;
  position?: { x: number; y: number; z: number };
  rotationYDeg?: number;
  scale?: number;
  sliceFt?: number;
}
export type FloorStyle = "stone" | "wood" | "grass" | "sand" | "parchment" | "cavern";

const parse = <T>(s: string | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const DEFAULT_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 60, maxY: 40 };

export const sceneBounds = (s: SceneView | null): Bounds => boundsFromJson(s?.boundsJson);

export function boundsFromJson(json: string | undefined): Bounds {
  const b = parse<Partial<Bounds>>(json, {});
  if (
    typeof b.minX === "number" &&
    typeof b.minY === "number" &&
    typeof b.maxX === "number" &&
    typeof b.maxY === "number" &&
    b.maxX > b.minX &&
    b.maxY > b.minY
  )
    return b as Bounds;
  return DEFAULT_BOUNDS;
}

export const calibrationFromJson = (json: string | undefined): Calibration => parse<Calibration>(json, {});
export const sceneCalibration = (s: SceneView | null): Calibration => calibrationFromJson(s?.calibJson);

export function sceneFloor(s: SceneView | null): FloorStyle {
  const f = parse<{ style?: FloorStyle }>(s?.floorJson, {});
  return f.style ?? "parchment";
}

export const boundsCenter = (b: Bounds) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
export const boundsSize = (b: Bounds) => ({ w: b.maxX - b.minX, h: b.maxY - b.minY });
