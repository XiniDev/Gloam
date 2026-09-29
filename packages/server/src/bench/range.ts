/**
 * `pnpm bench` — the movement range field (SPEC §16.6: "target under 30 ms for a 60-ft budget"; AC-MOV-10): on the
 * benchmark scene (200 × 150 ft, 500 walls — rooms, doors, pillars), a Medium creature's field for 60 ft of movement
 * from 200 places across it, after warming up (the first field builds the world's corner nodes, as the first
 * request after a scene loads does). What the overlay's worker runs, with the same shared code. Prints JSON; exits 1
 * when p95 is over budget.
 */
import { buildMoveWorld, clearanceRadius, rangeField } from "@gloam/shared/movement";
import { BENCH_SIZE, buildVisionScene, rng, SCENE_ID } from "./visionScene.ts";

const BUDGET_MS = 30;
const FIELDS = 200;
const WARM = 10;

const round = (ms: number) => Math.round(ms * 100) / 100;

export function rangeBench(): {
  p50: number;
  p95: number;
  max: number;
  first: number;
  fields: number;
  ok: boolean;
} {
  const scene = buildVisionScene(BENCH_SIZE);
  const walls = scene.model.inScene("wall", SCENE_ID).map((w) => ({
    id: w.id,
    a: w.a,
    b: w.b,
    kind: w.kind,
    doorState: w.doorState,
  }));
  const world = buildMoveWorld({
    walls,
    zones: [],
    bounds: { minX: 0, minY: 0, maxX: BENCH_SIZE.w, maxY: BENCH_SIZE.h },
  });
  const rc = clearanceRadius(5);
  const r = rng(7);
  const at = () => ({ x: 10 + r() * (BENCH_SIZE.w - 20), y: 10 + r() * (BENCH_SIZE.h - 20) });
  const t0 = performance.now();
  rangeField(world, at(), { rc, budget: 60 });
  const first = performance.now() - t0;
  for (let i = 0; i < WARM; i++) rangeField(world, at(), { rc, budget: 60 });
  const times: number[] = [];
  for (let i = 0; i < FIELDS; i++) {
    const s = performance.now();
    rangeField(world, at(), { rc, budget: 60 });
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))] as number;
  const p95 = pct(0.95);
  return {
    p50: round(pct(0.5)),
    p95: round(p95),
    max: round(times[times.length - 1] as number),
    first: round(first),
    fields: FIELDS,
    ok: p95 < BUDGET_MS,
  };
}

if (import.meta.main) {
  const res = rangeBench();
  console.log(JSON.stringify({ budgetMs: BUDGET_MS, ...res }));
  process.exit(res.ok ? 0 : 1);
}
