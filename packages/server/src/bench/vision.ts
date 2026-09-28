/**
 * `pnpm bench` — server vision (SPEC §37: "Vision recomputation (8 players): p95 < 10 ms"; AC-VIS-12, AC-PERF-03).
 * The benchmark scene's server side: 200 × 150 ft, 500 walls (rooms, corridors and pillars, 12 doors), 50 lights
 * (fixed and carried), 8 players each seeing through a darkvision token, 32 other creatures; dynamic fog. Then 400
 * events as play makes them — creatures moving (most), carried torches moving with them, a door now and then — each
 * recomputed by the real vision service (views, sensed markers, light raster, explored memory) over a real database.
 * Prints JSON; exits 1 when p95 is over budget.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.ts";
import { VisionService } from "../vision/visionService.ts";
import { BENCH_SIZE, buildVisionScene } from "./visionScene.ts";

const BUDGET_MS = 10;
const EVENTS = 400;

const round = (ms: number) => Math.round(ms * 100) / 100;

export async function visionBench(): Promise<{
  p50: number;
  p95: number;
  max: number;
  events: number;
  ok: boolean;
  byKind: Record<string, { n: number; p50: number; p95: number }>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "gloam-bench-"));
  const log = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const { sqlite, db } = await openDatabase(join(dir, "bench.db"), dir, log);
  sqlite.pragma("foreign_keys = OFF"); // the model lives in memory; explored rasters are written as they would be
  const scene = buildVisionScene(BENCH_SIZE);
  const service = new VisionService(scene.model, db, {
    players: () => scene.players,
    toUser() {},
    toOverseers() {},
  });
  const start = service.timings.length;
  const kinds: string[] = [];
  for (let e = 0; e < EVENTS; e++) {
    const { ops, kind } = scene.step(e);
    kinds.push(kind);
    service.onCommitted(ops);
  }
  service.flush();
  service.dispose();
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
  const raw = service.timings.slice(start);
  const quantile = (xs: number[], q: number) => {
    const s = xs.slice().sort((a, b) => a - b);
    return round(s[Math.min(s.length - 1, Math.floor(q * s.length))] as number);
  };
  const byKind: Record<string, { n: number; p50: number; p95: number }> = {};
  for (const k of new Set(kinds)) {
    const xs = raw.filter((_, i) => kinds[i] === k);
    byKind[k] = { n: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) };
  }
  const p95 = quantile(raw, 0.95);
  return {
    p50: quantile(raw, 0.5),
    p95,
    max: round(Math.max(...raw)),
    events: raw.length,
    ok: p95 < BUDGET_MS,
    byKind,
  };
}

if (import.meta.main) {
  // Warm up (JIT), then the measured run.
  await visionBench();
  const res = await visionBench();
  console.log(JSON.stringify({ vision: { ...res, budgetP95Ms: BUDGET_MS } }));
  process.exit(res.ok ? 0 : 1);
}
