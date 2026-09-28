import {
  COLLECTIONS,
  type CollectionName,
  type EffectView,
  type LightView,
  type PrepPatch,
  type PrepSnapshot,
  type SceneView,
  type TokenView,
  type WallView,
  type ZoneView,
} from "@gloam/shared/state";
import { create } from "zustand";

/** A tremorsense marker (SPEC §15.4): an opaque id and a position to 1 ft — nothing else about the creature. */
export interface SensedMark {
  id: string;
  x: number;
  y: number;
}

/** One scene's worth of board data, in the shared view shapes (SPEC §13.3). */
export interface SceneData {
  scene: SceneView | null;
  tokens: Map<string, TokenView>;
  walls: Map<string, WallView>;
  lights: Map<string, LightView>;
  zones: Map<string, ZoneView>;
  effects: Map<string, EffectView>;
  /** The creatures this viewer senses but doesn't see (the live scene only). */
  sensed: Map<string, SensedMark>;
}

export type PrepMeta = PrepSnapshot["sceneMeta"];

interface EntitiesStore {
  /** The active scene, mirrored from the synchronised state. */
  live: SceneData;
  /** A DM's prep scene (SPEC §13.7), or null. */
  prep: (SceneData & { meta: PrepMeta }) | null;
  /** Bumps on every applied change (cheap subscription key). */
  version: number;
  /**
   * Scene travel (SPEC §8.3 Scene activation): set when the live scene changes. The board switches at once; the
   * transition covers it with a freeze-frame of the old scene (captured by `beforeTravel` just before the switch),
   * fades that to black with the new scene's name, and fades in once the new scene has drawn.
   */
  travel: { sceneId: string; name: string; startedAt: number } | null;
  /** Travel transitions play once the first-load intro is over (the intro covers the first scene). */
  armed: boolean;
  setLive(next: SceneData): void;
  endTravel(): void;
  arm(): void;
  setPrep(snapshot: PrepSnapshot | null): void;
  applyPrepPatch(patch: PrepPatch): void;
  reset(): void;
}

export const emptyScene = (): SceneData => ({
  scene: null,
  tokens: new Map(),
  walls: new Map(),
  lights: new Map(),
  zones: new Map(),
  effects: new Map(),
  sensed: new Map(),
});

export const useEntities = create<EntitiesStore>((set, get) => ({
  live: emptyScene(),
  prep: null,
  version: 0,
  travel: null,
  armed: false,
  setLive(live) {
    const s = get();
    const from = s.live.scene?.id ?? null;
    const to = live.scene?.id ?? null;
    // A DM preparing another scene stays there; everyone else travels — from one scene to another only: the first
    // scene arriving (after the intro on a slow join, or a reconnect's fresh sync) just appears.
    if (s.armed && from && to && from !== to && !s.prep) {
      // Still showing the old scene: let the transition freeze it before the board switches.
      travelHooks.beforeTravel?.();
      set({
        live,
        travel: { sceneId: to, name: live.scene?.name ?? "", startedAt: performance.now() },
        version: s.version + 1,
      });
      return;
    }
    set({ live, version: s.version + 1 });
  },
  endTravel: () => set({ travel: null, version: get().version + 1 }),
  arm: () => set({ armed: true }),
  setPrep(snapshot) {
    if (!snapshot) {
      set({ prep: null, version: get().version + 1 });
      return;
    }
    const data: SceneData & { meta: PrepMeta } = {
      scene: snapshot.scene,
      meta: snapshot.sceneMeta,
      tokens: new Map(snapshot.tokens.map((t) => [t.id, t])),
      walls: new Map(snapshot.walls.map((w) => [w.id, w])),
      lights: new Map(snapshot.lights.map((l) => [l.id, l])),
      zones: new Map(snapshot.zones.map((z) => [z.id, z])),
      effects: new Map(snapshot.effects.map((e) => [e.id, e])),
      sensed: new Map(),
    };
    set({ prep: data, version: get().version + 1 });
  },
  applyPrepPatch(patch) {
    const cur = get().prep;
    if (!cur || cur.scene?.id !== patch.sceneId) return;
    const next = { ...cur };
    if (patch.scene === null) {
      set({ prep: null, version: get().version + 1 });
      return;
    }
    if (patch.scene) next.scene = patch.scene;
    if (patch.sceneMeta) next.meta = patch.sceneMeta;
    for (const c of COLLECTIONS) {
      const up = patch.upsert[c] as { id: string }[] | undefined;
      const rm = patch.remove[c];
      if (!up?.length && !rm?.length) continue;
      const map = new Map(cur[c] as Map<string, { id: string }>);
      for (const id of rm ?? []) map.delete(id);
      for (const v of up ?? []) map.set(v.id, v);
      (next as Record<CollectionName, unknown>)[c] = map;
    }
    set({ prep: next, version: get().version + 1 });
  },
  reset: () => set({ live: emptyScene(), prep: null, travel: null, version: get().version + 1 }),
}));

/** Which scene the board shows: a DM's prep scene when one is open, otherwise the live one. */
export function boardData(s: EntitiesStore): SceneData {
  return s.prep ?? s.live;
}

export const useBoard = <T>(sel: (d: SceneData) => T): T => useEntities((s) => sel(boardData(s)));

/** Called synchronously just before the live scene switches for travel (the board still shows the old scene). */
export const travelHooks: { beforeTravel: (() => void) | null } = { beforeTravel: null };
