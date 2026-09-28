import type { FogMode } from "@gloam/shared/schemas";
import { rleDecode } from "@gloam/shared/vision";
import { create } from "zustand";

/** A fog raster's placement over the scene (cells of `cell` ft from (x0, y0)), as the server sends it. */
export interface FogShape {
  x0: number;
  y0: number;
  cell: number;
  w: number;
  h: number;
}

/** `fog.snapshot` (SPEC §15.8). */
export interface FogSnapshotMsg extends FogShape {
  sceneId: string;
  mode: FogMode;
  layers: { layer: string; runs: number[] }[];
  explored: number[] | null;
}

/** A rectangle of cells, run-length encoded (`fog.patch` replaces a layer's cells; `explored.patch` adds seen ones). */
export interface FogRectMsg {
  sceneId: string;
  layer?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  runs: number[];
}

interface FogStore {
  sceneId: string | null;
  mode: FogMode;
  shape: FogShape | null;
  /** Painted reveal layers this client holds (a player: `reveal:all` and its own; DMs and spectators: all). */
  layers: Map<string, Uint8Array>;
  /** Explored memory (dynamic mode): the player's, or for DMs and spectators everyone's. */
  explored: Uint8Array | null;
  /** Bumps on every change (the fog textures re-upload). */
  version: number;
  load(s: FogSnapshotMsg | null): void;
  patch(m: FogRectMsg): void;
  explore(m: FogRectMsg): void;
  reset(): void;
}

function writeRect(into: Uint8Array, shape: FogShape, m: FogRectMsg, or: boolean): boolean {
  if (m.x < 0 || m.y < 0 || m.x + m.w > shape.w || m.y + m.h > shape.h) return false;
  const cells = rleDecode(m.runs, m.w * m.h);
  for (let j = 0; j < m.h; j++) {
    const row = (m.y + j) * shape.w + m.x;
    if (or) {
      for (let i = 0; i < m.w; i++) if (cells[j * m.w + i]) into[row + i] = 1;
    } else into.set(cells.subarray(j * m.w, (j + 1) * m.w), row);
  }
  return true;
}

/**
 * The fog this client holds for the active scene (SPEC §15.8): painted reveal layers and the server's explored raster
 * — the only explored memory there is (clients never keep their own, so it can't drift between devices).
 */
export const useFog = create<FogStore>((set, get) => ({
  sceneId: null,
  mode: "off",
  shape: null,
  layers: new Map(),
  explored: null,
  version: 0,
  load(s) {
    if (!s) {
      get().reset();
      return;
    }
    const n = s.w * s.h;
    set({
      sceneId: s.sceneId,
      mode: s.mode,
      shape: { x0: s.x0, y0: s.y0, cell: s.cell, w: s.w, h: s.h },
      layers: new Map(s.layers.map((l) => [l.layer, rleDecode(l.runs, n)])),
      explored: s.explored ? rleDecode(s.explored, n) : null,
      version: get().version + 1,
    });
  },
  patch(m) {
    const s = get();
    if (m.sceneId !== s.sceneId || !s.shape || !m.layer) return;
    const layers = new Map(s.layers);
    const cur = layers.get(m.layer) ?? new Uint8Array(s.shape.w * s.shape.h);
    const next = cur.slice();
    if (!writeRect(next, s.shape, m, false)) return;
    layers.set(m.layer, next);
    set({ layers, version: s.version + 1 });
  },
  explore(m) {
    const s = get();
    if (m.sceneId !== s.sceneId || !s.shape) return;
    const next = (s.explored ?? new Uint8Array(s.shape.w * s.shape.h)).slice();
    if (!writeRect(next, s.shape, m, true)) return;
    set({ explored: next, version: s.version + 1 });
  },
  reset: () =>
    set({
      sceneId: null,
      mode: "off",
      shape: null,
      layers: new Map(),
      explored: null,
      version: get().version + 1,
    }),
}));

/**
 * Whether a table point is known to this client in painted or dynamic fog: revealed to it, or explored (which includes
 * what its viewers see now: the server marks it in the same commit). Always true with fog off, and for the DM.
 */
export function knownAt(x: number, y: number, mine: string | null): boolean {
  const s = useFog.getState();
  if (s.mode === "off" || !s.shape) return true;
  const sh = s.shape;
  const i = Math.floor((x - sh.x0) / sh.cell);
  const j = Math.floor((y - sh.y0) / sh.cell);
  if (i < 0 || j < 0 || i >= sh.w || j >= sh.h) return false;
  const k = j * sh.w + i;
  if (s.explored?.[k]) return true;
  for (const [name, l] of s.layers)
    if ((name === "reveal:all" || name === `reveal:${mine}`) && l[k]) return true;
  return false;
}
