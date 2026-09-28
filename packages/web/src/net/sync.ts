import { $values, type DataChange } from "@colyseus/schema";
import type { SceneView, TableState, TokenView } from "@gloam/shared/state";
import { COLLECTIONS, type CollectionName } from "@gloam/shared/state";
import { type SceneData, useEntities } from "../state/entities.ts";

/**
 * Mirrors the synchronised state into the `entities` store once per server patch (SPEC §13.6: collect changes in
 * the patch's callbacks, write the store once, so React re-renders at most once per patch).
 *
 * Only what the patch changed is read: every schema object in the state is mapped to the entity it belongs to (a
 * token's `hp` block to that token), the decoder's per-patch change list marks those entities dirty, and only they
 * are re-read into new objects — everything else keeps its identity. Re-reading the whole state on each patch cost
 * O(everything) twenty times a second: with a thousand walls, moving one token re-serialised every wall, and a DM
 * moving all of them held every client's main thread for hundreds of milliseconds. Anything the map doesn't
 * recognise, a full state (join, resync) or a view collection appearing falls back to the full pass, which compares
 * each item with its last JSON — slower, never wrong.
 */

type Json = Record<string, unknown>;
type Owner = { c: CollectionName; id: string } | { c: "scene" } | { c: "other" };

/** The last JSON of each item (the full pass's change test). */
const cache = new Map<string, string>();
/** Schema object → the entity it belongs to. */
let owner = new WeakMap<object, Owner>();
/** Dirty entities since the last store write, or `full` for a complete pass. */
let dirty = new Map<CollectionName, Set<string>>();
let sceneDirty = false;
let full = true;

/** Sync work done (test builds read it; SPEC §23.7). */
export const syncStats = { full: 0, partial: 0, items: 0, lastMs: 0 };

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
    if (typeof j.dmDoor !== "string") delete j.dmDoor;
  } else if (c === "zones") {
    if (typeof j.dmHidden !== "boolean") delete j.dmHidden;
    if (typeof j.dmJson !== "string" || !j.dmJson) delete j.dmJson;
  }
  return j;
}

/** Maps a schema object and everything under it to `o`. */
function claim(obj: unknown, o: Owner): void {
  if (!obj || typeof obj !== "object") return;
  owner.set(obj, o);
  const values = (obj as { [$values]?: unknown[] })[$values];
  if (values) for (const v of values) claim(v, o);
  const coll = obj as { forEach?: (fn: (v: unknown) => void) => void };
  if (!values && typeof coll.forEach === "function")
    coll.forEach((v) => {
      claim(v, o);
    });
}

function mark(c: CollectionName, id: string): void {
  const set = dirty.get(c);
  if (set) set.add(id);
  else dirty.set(c, new Set([id]));
}

type Root = Record<string, unknown> &
  Record<CollectionName, { forEach(fn: (v: unknown, k: string) => void): void }>;

/** Maps the whole state (after a full state, or when collections appear). */
function claimAll(state: TableState): void {
  owner = new WeakMap();
  const root = state as unknown as Root;
  for (const c of COLLECTIONS) {
    const coll = root[c];
    if (!coll) continue;
    owner.set(coll, { c: "other" });
    coll.forEach((item, id) => {
      claim(item, { c, id });
    });
  }
  claim(root.scene, { c: "scene" });
  // Everything else on the root (presence and the like): not board data.
  for (const v of (root as { [$values]?: unknown[] })[$values] ?? [])
    if (v && typeof v === "object" && !owner.has(v)) claim(v, { c: "other" });
}

/**
 * The decoder's change list for one patch (installed by the table connection): marks what changed. Called before
 * `onStateChange`, which then writes the store.
 */
export function noteChanges(state: TableState, changes: DataChange[]): void {
  if (full) return;
  const root = state as unknown as Root;
  for (const ch of changes) {
    const ref = ch.ref as object;
    if (ref === (state as object)) {
      if (ch.field === "scene") {
        sceneDirty = true;
        claim(ch.value, { c: "scene" });
      } else if ((COLLECTIONS as string[]).includes(ch.field as string))
        full = true; // a view collection appeared
      else if (ch.value && typeof ch.value === "object") claim(ch.value, { c: "other" });
      continue;
    }
    let c: CollectionName | null = null;
    for (const name of COLLECTIONS)
      if (root[name] === ref) {
        c = name;
        break;
      }
    if (c) {
      const id = String(ch.dynamicIndex);
      mark(c, id);
      if (ch.value && typeof ch.value === "object") claim(ch.value, { c, id });
      continue;
    }
    const o = owner.get(ref);
    if (!o) {
      full = true; // something unmapped: be safe
      return;
    }
    if (o.c === "other") continue;
    if (o.c === "scene") sceneDirty = true;
    else mark(o.c, o.id);
    if (ch.value && typeof ch.value === "object") claim(ch.value, o);
  }
}

/** A full state arrived (join, resync): the next write reads everything. */
export function syncFull(): void {
  full = true;
}

export function syncLive(state: TableState): void {
  const t0 = performance.now();
  const prev = useEntities.getState().live;
  const next: SceneData = { ...prev };
  let changed = false;
  const root = state as unknown as Root;
  if (full || sceneDirty) {
    const scene = ((state.scene as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? {}) as SceneView;
    const sj = JSON.stringify(scene);
    if (cache.get("scene") !== sj) {
      cache.set("scene", sj);
      next.scene = scene.id ? scene : null;
      changed = true;
    }
  }
  let items = 0;
  if (full) {
    for (const c of COLLECTIONS) {
      const prevMap = prev[c] as Map<string, unknown>;
      let map: Map<string, unknown> | null = null;
      const seen = new Set<string>();
      root[c]?.forEach((item, id) => {
        seen.add(id);
        items++;
        const json = normalise(c, (item as { toJSON(): Json }).toJSON());
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
    claimAll(state);
    full = false;
    syncStats.full++;
  } else {
    for (const [c, ids] of dirty) {
      const prevMap = prev[c] as Map<string, unknown>;
      const map = new Map(prevMap);
      const coll = root[c] as unknown as { get(id: string): { toJSON(): Json } | undefined } | undefined;
      for (const id of ids) {
        items++;
        // The full pass's cache would be stale for this item: a later full pass treats it as changed.
        cache.delete(`${c}:${id}`);
        const item = coll?.get(id);
        if (item) map.set(id, normalise(c, item.toJSON()));
        else map.delete(id);
      }
      (next as unknown as Record<CollectionName, unknown>)[c] = map;
      changed = true;
    }
    if (dirty.size || sceneDirty) syncStats.partial++;
  }
  dirty = new Map();
  sceneDirty = false;
  if (changed) useEntities.getState().setLive(next);
  syncStats.items = items;
  syncStats.lastMs = performance.now() - t0;
}

/**
 * Test builds: compares the store with a complete re-read of the state (what the full pass would produce), and
 * returns what differs. Run after every patch in test builds, so every journey checks the incremental sync.
 */
export function auditLive(state: TableState): string[] {
  const out: string[] = [];
  const live = useEntities.getState().live;
  const root = state as unknown as Root;
  for (const c of COLLECTIONS) {
    const map = live[c] as Map<string, unknown>;
    const want = new Map<string, string>();
    root[c]?.forEach((item, id) => {
      want.set(id, JSON.stringify(normalise(c, (item as { toJSON(): Json }).toJSON())));
    });
    for (const [id, s] of want) {
      const have = map.get(id);
      if (!have) out.push(`${c}:${id} missing`);
      else if (JSON.stringify(have) !== s)
        out.push(`${c}:${id} stale: ${JSON.stringify(have).slice(0, 160)} ≠ ${s.slice(0, 160)}`);
    }
    for (const id of map.keys()) if (!want.has(id)) out.push(`${c}:${id} should be gone`);
  }
  const scene = ((state.scene as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? {}) as SceneView;
  if (JSON.stringify(live.scene ?? null) !== JSON.stringify(scene.id ? scene : null)) out.push("scene stale");
  return out;
}

/** Forget everything (leaving the table, or before a fresh join). */
export function resetSync(): void {
  cache.clear();
  owner = new WeakMap();
  dirty = new Map();
  sceneDirty = false;
  full = true;
  useEntities.getState().reset();
  useEntities.getState().setPrep(null);
}
