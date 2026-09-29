import { create } from "zustand";

/** The drag payload type for putting a Library item on the board (read by the Board's drop handler). */
export const ASSET_DRAG_TYPE = "application/x-gloam-asset";
export interface AssetDragPayload {
  id: string;
  purpose: AssetItem["purpose"];
  cls: AssetItem["cls"];
  name: string;
}

/** A Library item as the server describes it (SPEC §8.16; server `AssetDto`). */
export interface AssetItem {
  id: string;
  name: string;
  purpose: "map" | "mini" | "token" | "portrait" | "handout" | "art" | "audio";
  cls: "image" | "model" | "audio";
  status: "pending" | "approved" | "rejected";
  uploaderId: string;
  uploaderName: string;
  tags: string[];
  createdAt: number;
  deleted: boolean;
  bytes: number;
  width?: number;
  height?: number;
  dominant?: string;
  glb?: {
    triangles: number;
    trianglesIn: number;
    textures: number;
    animations: string[];
    bounds: { min: [number, number, number]; max: [number, number, number] };
  };
  overrides: { scale?: number; rotationYDeg?: number; offsetY?: number };
  variants: { name: string; mime: string; bytes: number; width?: number; height?: number }[];
  usage?: number;
  /** Audio: its length and loudness, once a DM's browser has measured them. */
  durationMs?: number;
  loudnessLufs?: number;
}

/**
 * What drawing an asset needs (the server's render view): players only ever get this — no name, tags or uploader.
 * A full AssetItem (DMs, and a player's own uploads) is a superset.
 */
export type AssetRender = Pick<
  AssetItem,
  "id" | "purpose" | "cls" | "width" | "height" | "dominant" | "overrides" | "variants"
> & { glb?: { bounds: NonNullable<AssetItem["glb"]>["bounds"]; animations: string[] } };

export interface SceneListItem {
  id: string;
  name: string;
  sort: number;
  mapKind: "image" | "model" | "procedural" | "blank";
  mapAssetId: string | null;
  thumbnailAssetId: string | null;
  active: boolean;
  archived: boolean;
  deleted: boolean;
  tokenCount: number;
  updatedAt: number;
  calibration: { ftPerPx?: number; imageW?: number; imageH?: number; sliceFt?: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface LibraryStore {
  /** Everything this client has seen, keyed by id (lists, notifications, uploads). */
  assets: Map<string, AssetItem>;
  scenes: SceneListItem[];
  /** Render views of every asset this client has seen (kept current by asset.changed / asset.render). */
  renders: Map<string, AssetRender>;
  upsert(items: AssetItem[]): void;
  upsertRenders(items: AssetRender[]): void;
  remove(ids: string[]): void;
  setScenes(s: SceneListItem[]): void;
}

export const useLibrary = create<LibraryStore>((set, get) => ({
  assets: new Map(),
  renders: new Map(),
  scenes: [],
  upsert(items) {
    const m = new Map(get().assets);
    const r = new Map(get().renders);
    for (const a of items) {
      m.set(a.id, a);
      r.set(a.id, a);
    }
    set({ assets: m, renders: r });
  },
  upsertRenders(items) {
    const r = new Map(get().renders);
    for (const a of items) r.set(a.id, a);
    set({ renders: r });
  },
  remove(ids) {
    const m = new Map(get().assets);
    for (const id of ids) m.delete(id);
    set({ assets: m });
  },
  setScenes: (scenes) => set({ scenes }),
}));

export const pendingCount = (s: LibraryStore) =>
  [...s.assets.values()].filter((a) => a.status === "pending" && !a.deleted).length;
