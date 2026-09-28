/// <reference lib="webworker" />
/**
 * The dice physics worker (SPEC §18.4): Rapier loads here, lazily, off the main thread; each throw comes back as its
 * recorded frames (transferred, not copied), the landed markers and the contacts.
 */
import { initPhysics, simulate, type ThrowInput } from "./simulate.ts";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<{ id: number; input: ThrowInput } | { id: number; warm: true }>) => {
  const { id } = e.data;
  try {
    if ("warm" in e.data) {
      await initPhysics();
      self.postMessage({ id, warm: true });
      return;
    }
    const result = await simulate(e.data.input);
    self.postMessage({ id, result }, [result.frames.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
