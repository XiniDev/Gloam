/**
 * Throwing dice from the main thread: one worker (made on first use, or prefetched when the table is idle — SPEC
 * §18.4 "prefetched after the table first renders"), one request per throw.
 */
import type { ThrowInput, ThrowResult } from "./simulate.ts";

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { ok: (r: ThrowResult) => void; fail: (e: Error) => void }>();

function ensure(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./physics.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<{ id: number; result?: ThrowResult; error?: string; warm?: true }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.fail(new Error(e.data.error));
    else if (e.data.result) p.ok(e.data.result);
    else p.ok(null as unknown as ThrowResult);
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.fail(new Error(e.message || "dice worker failed"));
    pending.clear();
    worker = null;
  };
  worker = w;
  return w;
}

/** Loads the physics when the browser is idle, so the first throw doesn't wait for it. */
export function prefetchDice(): void {
  const go = () => {
    const id = ++seq;
    pending.set(id, { ok: () => {}, fail: () => {} });
    ensure().postMessage({ id, warm: true });
  };
  const idle = (globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (idle) idle(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}

export function throwDice(input: ThrowInput): Promise<ThrowResult> {
  return new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ensure().postMessage({ id, input });
  });
}
