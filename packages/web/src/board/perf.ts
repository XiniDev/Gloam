/**
 * Main-thread work per board frame while editing (AC-WAL-07; test builds and the bench switch it on). A frame's
 * editing cost is the pointer handling since the previous frame — the handler plus the React commits it causes,
 * which run in the same task's microtasks — plus the frame itself: every `useFrame` callback and the render
 * submission (the rAF callback, up to its microtask checkpoint). The GPU's raster work isn't main-thread time: in the
 * browser it happens in the GPU process, so this is the number a slow edit would show up in whatever the GPU.
 */
export const editPerf = {
  on: false,
  /** Pointer-task time accumulated since the last frame. */
  pending: 0,
  /** Per-frame totals (ms), newest last; capped. */
  frames: [] as number[],
  /** The same frames split: pointer-task time and the frame's own time. */
  parts: [] as [number, number][],
};

/** Runs a pointer handler, counting it (and the commits it triggers) toward the next frame. */
export function measureTask(fn: () => void): void {
  if (!editPerf.on) {
    fn();
    return;
  }
  const t0 = performance.now();
  try {
    fn();
  } finally {
    // After React's own microtasks (queued while fn ran), so its render and commit are included.
    queueMicrotask(() => {
      editPerf.pending += performance.now() - t0;
    });
  }
}

/** Counts main-thread work that began at `t0` (and the commits it triggered) toward the next frame. */
export function measureSince(t0: number): void {
  if (!editPerf.on) return;
  queueMicrotask(() => {
    editPerf.pending += performance.now() - t0;
  });
}

/** Called first thing in each board frame. */
export function frameStarted(): void {
  if (!editPerf.on) return;
  const t0 = performance.now();
  queueMicrotask(() => {
    const own = performance.now() - t0;
    editPerf.frames.push(editPerf.pending + own);
    editPerf.parts.push([editPerf.pending, own]);
    editPerf.pending = 0;
    if (editPerf.frames.length > 2000) {
      editPerf.frames.splice(0, 1000);
      editPerf.parts.splice(0, 1000);
    }
  });
}
