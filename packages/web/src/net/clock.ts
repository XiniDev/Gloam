import { provideTestHook } from "../test/hooks.ts";
import { request, useTable } from "./table.ts";

/**
 * The server's clock, as this page reckons it (SPEC §13.8): `clock.sync` five times on joining and once a minute
 * after; the sample with the shortest round trip wins, `offset = serverNow − (t0 + rtt/2)`. Local time is the page's
 * monotonic clock (`performance.timeOrigin + performance.now()`), not the wall clock, which can jump. A later sample
 * doesn't jump the offset music is playing to: it slews toward it by at most 2 ms a second (an inaudible 0.2 %).
 */

/** This page's monotonic time in ms (comparable with the server's `Date.now()` once offset). */
export const localNow = () => performance.timeOrigin + performance.now();

let measured: number | null = null;
let working: number | null = null;
let slewAt = 0;
let bestRtt = Number.POSITIVE_INFINITY;

/** The offset to add to local time for the server's, slewed; null until the first sample. */
export function clockOffset(): number | null {
  if (measured === null) return null;
  if (working === null) {
    working = measured;
    slewAt = localNow();
    return working;
  }
  const now = localNow();
  const maxStep = ((now - slewAt) / 1000) * 2;
  slewAt = now;
  const d = measured - working;
  working += Math.max(-maxStep, Math.min(maxStep, d));
  return working;
}

/** The server's time now (ms), or local time before the first sample. */
export function serverNow(): number {
  return localNow() + (clockOffset() ?? 0);
}

async function sample(): Promise<{ offset: number; rtt: number } | null> {
  const t0 = localNow();
  try {
    const r = await request<{ t0: number; serverNow: number }>("clock.sync", { t0 });
    const t1 = localNow();
    const rtt = t1 - t0;
    return { offset: r.serverNow - (t0 + rtt / 2), rtt };
  } catch {
    return null;
  }
}

/** A burst of samples: the best of them becomes the measured offset. */
async function measure(n: number): Promise<void> {
  let best: { offset: number; rtt: number } | null = null;
  for (let i = 0; i < n; i++) {
    const s = await sample();
    if (s && (!best || s.rtt < best.rtt)) best = s;
  }
  if (!best) return;
  // A fresh burst on joining replaces the estimate; a minute's sample only improves it (or follows a real drift).
  if (n > 1 || best.rtt <= bestRtt * 1.5) {
    measured = best.offset;
    bestRtt = Math.min(bestRtt, best.rtt);
  }
}

let started = "";
let timer: ReturnType<typeof setInterval> | null = null;

/** Starts keeping the clock for the table connection (once per page; again for each new room session). */
export function watchClock(): () => void {
  if (__GLOAM_TEST__)
    provideTestHook("clock", () => ({
      offset: clockOffset(),
      measured,
      rtt: bestRtt,
      serverNow: serverNow(),
    }));
  const check = () => {
    const t = useTable.getState();
    const key = t.room && t.connection === "open" ? `${t.room.roomId}|${t.room.sessionId}` : "";
    if (!key || key === started) return;
    started = key;
    bestRtt = Number.POSITIVE_INFINITY;
    void measure(5);
  };
  const off = useTable.subscribe(check);
  check();
  timer = setInterval(() => void measure(1), 60_000);
  return () => {
    off();
    if (timer) clearInterval(timer);
    timer = null;
    started = "";
  };
}
