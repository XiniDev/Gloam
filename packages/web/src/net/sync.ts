import type { SceneView, TableState, TokenView } from "@gloam/shared/state";
import { COLLECTIONS, type CollectionName } from "@gloam/shared/state";
import { type SceneData, useEntities } from "../state/entities.ts";

/**
 * Mirrors the synchronised state into the `entities` store once per server patch (SPEC §13.6: batch store writes
 * so React re-renders at most once per patch). Each item's JSON is compared with the previous patch's, so only
 * changed items get new object identities. Collections marked `.view()` may be undefined until the server first
 * adds something to this client's view; tagged sub-objects the client doesn't hold are normalised to absent.
 */

type Json = Record<string, unknown>;
const cache = new Map<string, string>();

/** Tagged children exist on decoded instances even without the tag; an empty one means "not visible to me". */
function normalise(c: CollectionName, j: Json): Json {
  if (c === "tokens") {
    const t = j as unknown as TokenView;
    if (typeof t.hp?.hp !== "number") delete j.hp;
    if (typeof t.own?.ac !== "number") delete j.own;
    if (typeof t.vis?.darkvision !== "number") delete j.vis;
    if (typeof t.dm?.dmHidden !== "boolean") delete j.dm;
  } else if (c === "lights" || c === "effects") {
    const l = j.link as { tokenId?: string; casterId?: string } | undefined;
    if (!l?.tokenId && !l?.casterId) delete j.link;
  } else if (c === "walls") {
    if (typeof j.dmKind !== "string") delete j.dmKind;
    if (typeof j.dmHidden !== "boolean") delete j.dmHidden;
  }
  return j;
}

export function syncLive(state: TableState): void {
  const prev = useEntities.getState().live;
  const next: SceneData = { ...prev };
  let changed = false;
  const scene = (state.scene?.toJSON?.() ?? {}) as SceneView;
  const sj = JSON.stringify(scene);
  if (cache.get("scene") !== sj) {
    cache.set("scene", sj);
    next.scene = scene.id ? scene : null;
    changed = true;
  }
  const root = state as unknown as Record<
    CollectionName,
    { forEach(fn: (item: { toJSON(): Json }, id: string) => void): void } | undefined
  >;
  for (const c of COLLECTIONS) {
    const prevMap = prev[c] as Map<string, unknown>;
    let map: Map<string, unknown> | null = null;
    const seen = new Set<string>();
    root[c]?.forEach((item, id) => {
      seen.add(id);
      const json = normalise(c, item.toJSON());
      const s = JSON.stringify(json);
      const key = `${c}:${id}`;
      if (cache.get(key) !== s) {
        cache.set(key, s);
        map ??= new Map(prevMap);
        map.set(id, json);
      }
    });
    for (const id of prevMap.keys()) {
      if (seen.has(id)) continue;
      map ??= new Map(prevMap);
      map.delete(id);
      cache.delete(`${c}:${id}`);
    }
    if (map) {
      (next as unknown as Record<CollectionName, unknown>)[c] = map;
      changed = true;
    }
  }
  if (changed) useEntities.getState().setLive(next);
}

/** Forget everything (leaving the table, or before a fresh join). */
export function resetSync(): void {
  cache.clear();
  useEntities.getState().reset();
  useEntities.getState().setPrep(null);
}
