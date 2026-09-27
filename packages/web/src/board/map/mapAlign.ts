import type { Object3D } from "three";
import { create } from "zustand";

/** A 3D map's placement on the table (SPEC §8.3): move, rotate about Y, uniform scale. */
export interface MapTransform {
  position: { x: number; y: number; z: number };
  rotationYDeg: number;
  scale: number;
}

interface MapAlignStore {
  /** The GLB map object on the board (registered by the map layer). */
  object: Object3D | null;
  mode: "translate" | "rotate" | "scale";
  /** The transform while the gizmo is being dragged (the panel shows it live), else null. */
  live: MapTransform | null;
  set(p: Partial<Omit<MapAlignStore, "set">>): void;
}

export const useMapAlign = create<MapAlignStore>((set) => ({
  object: null,
  mode: "translate",
  live: null,
  set: (p) => set(p),
}));

const round = (n: number, step: number) => Math.round(n / step) * step;

/** Reads an object's placement as the calibration stores it (rotation normalised to −180…180°). */
export function transformOf(o: Object3D): MapTransform {
  let deg = (o.rotation.y * 180) / Math.PI;
  deg = ((((deg + 180) % 360) + 360) % 360) - 180;
  return {
    position: { x: round(o.position.x, 0.01), y: round(o.position.y, 0.01), z: round(o.position.z, 0.01) },
    rotationYDeg: round(deg, 0.1),
    scale: Math.max(0.001, round(o.scale.x, 0.0001)),
  };
}
