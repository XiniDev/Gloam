import type { P } from "@gloam/shared/geometry";
import type { MoveWorld, RangeField, RangeOptions } from "@gloam/shared/movement";

/**
 * The range field's worker, from the main thread (SPEC §16.6): one worker, made on first use; each world is sent to
 * it once (known by identity — the client's movement world is rebuilt only when walls, zones or the creatures'
 * spaces change), then only an origin and a budget per request. A newer request supersedes an older one still out.
 */
let worker: Worker | null = null;
let seq = 0;
let sentWorld: MoveWorld | null = null;
const keys = new WeakMap<MoveWorld, number>();
let nextKey = 0;
const pending = new Map<number, { ok: (f: RangeField | null) => void; fail: (e: Error) => void }>();

function ensure(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./range.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (
    e: MessageEvent<{ id: number; field?: RangeField; stale?: true; error?: string; ms?: number }>,
  ) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.fail(new Error(e.data.error));
    else {
      if (e.data.ms !== undefined) lastMs = e.data.ms;
      p.ok(e.data.field ?? null);
    }
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.fail(new Error(e.message || "range worker failed"));
    pending.clear();
    worker = null;
    sentWorld = null;
  };
  worker = w;
  return w;
}

/** How long the last field took in the worker (ms; diagnostics). */
export let lastMs = 0;

/** The field for a creature at `origin` in `world` (null when a newer request took over or the world moved on). */
export function requestRange(world: MoveWorld, origin: P, opts: RangeOptions): Promise<RangeField | null> {
  let key = keys.get(world);
  if (key === undefined) {
    key = ++nextKey;
    keys.set(world, key);
  }
  const w = ensure();
  const id = ++seq;
  // Only the newest request matters: older ones resolve empty.
  for (const [old, p] of pending) {
    pending.delete(old);
    p.ok(null);
  }
  return new Promise((ok, fail) => {
    pending.set(id, { ok, fail });
    const send = sentWorld !== world;
    sentWorld = world;
    w.postMessage({
      id,
      key,
      origin,
      opts,
      ...(send
        ? {
            world: {
              walls: world.walls,
              solids: world.solids,
              regions: world.regions,
              bounds: world.bounds,
            },
          }
        : {}),
    });
  });
}
