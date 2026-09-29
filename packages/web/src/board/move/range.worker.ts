/// <reference lib="webworker" />
/**
 * The movement range field off the main thread (SPEC §16.6 "Run it in a Web Worker; target under 30 ms for a 60-ft
 * budget"): the world arrives once per change (walls, zones, the creatures' spaces), each request is an origin and a
 * budget. The field's costs go back as a transferred buffer.
 */
import type { P } from "@gloam/shared/geometry";
import {
  MoveWorld,
  type MoveWorldInput,
  type RangeOptions,
  rangeDisplay,
  rangeField,
} from "@gloam/shared/movement";

interface Request {
  id: number;
  /** Which world it's for; `world` comes with it when the worker hasn't got it yet. */
  key: number;
  world?: MoveWorldInput;
  origin: P;
  opts: RangeOptions;
}

let held: { key: number; world: MoveWorld } | null = null;

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, key, origin, opts } = e.data;
  try {
    if (e.data.world) held = { key, world: new MoveWorld(e.data.world) };
    if (!held || held.key !== key) {
      self.postMessage({ id, stale: true });
      return;
    }
    const t0 = performance.now();
    const field = rangeField(held.world, origin, opts);
    const ms = performance.now() - t0;
    // What the overlay draws: flush to walls and bases, its edge smoothed (drawing only; not timed as the field).
    const display = rangeDisplay(held.world, field, opts.rc);
    self.postMessage({ id, field, display, ms }, [
      field.cost.buffer,
      display.cost.buffer,
      display.reach.buffer,
    ]);
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
