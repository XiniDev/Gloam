/**
 * Placing characters at a scene's party spawn point (SPEC §8.3 Scene activation, AC-SCN-06): in a spiral of 5-ft
 * steps round the spawn — nearest spots first — each character where its footprint fits inside the scene, overlaps no
 * token (nor one placed before it) and no wall that blocks movement, and can be reached from the spawn in a straight
 * line (not through a wall into the next room).
 */
import { segIntersect } from "../geometry/index.ts";
import { blocksMove, type DoorState } from "./blocking.ts";

type P = { x: number; y: number };

export interface SpawnInput {
  spawn: P;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  walls: readonly { a: P; b: P; kind: string; doorState?: DoorState | null }[];
  /** Tokens already on the scene: centre and footprint (ft). */
  occupied: readonly { x: number; y: number; size: number }[];
  /** The footprints (ft) of the characters to place, in order. */
  sizes: readonly number[];
  /** How far out to look (rings of 5 ft); beyond it a character goes on the spawn itself. */
  maxRings?: number;
}

const STEP = 5;
const EPS = 0.05;

function segmentHitsBox(a: P, b: P, x0: number, y0: number, x1: number, y1: number): boolean {
  const inside = (p: P) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1;
  if (inside(a) || inside(b)) return true;
  const c = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  for (let i = 0; i < 4; i++) if (segIntersect(a, b, c[i] as P, c[(i + 1) % 4] as P)) return true;
  return false;
}

/** Where each character goes (their centres, in the order given). */
export function spawnSpots(input: SpawnInput): P[] {
  const blocking = input.walls.filter((w) => blocksMove(w.kind, w.doorState ?? null));
  const taken = input.occupied.map((o) => ({ ...o }));
  const rings = input.maxRings ?? 20;
  // Candidates: every 5-ft step within the rings, nearest first (ties in a fixed turn order).
  const candidates: P[] = [];
  for (let dy = -rings; dy <= rings; dy++)
    for (let dx = -rings; dx <= rings; dx++)
      candidates.push({ x: input.spawn.x + dx * STEP, y: input.spawn.y + dy * STEP });
  candidates.sort((p, q) => {
    const dp = Math.hypot(p.x - input.spawn.x, p.y - input.spawn.y);
    const dq = Math.hypot(q.x - input.spawn.x, q.y - input.spawn.y);
    if (Math.abs(dp - dq) > 1e-9) return dp - dq;
    return (
      Math.atan2(p.y - input.spawn.y, p.x - input.spawn.x) -
      Math.atan2(q.y - input.spawn.y, q.x - input.spawn.x)
    );
  });
  const fits = (c: P, size: number) => {
    const h = size / 2;
    const { minX, minY, maxX, maxY } = input.bounds;
    if (c.x - h < minX - EPS || c.x + h > maxX + EPS || c.y - h < minY - EPS || c.y + h > maxY + EPS)
      return false;
    for (const o of taken) {
      const reach = (size + o.size) / 2 - EPS;
      if (Math.abs(c.x - o.x) < reach && Math.abs(c.y - o.y) < reach) return false;
    }
    for (const w of blocking) {
      if (segmentHitsBox(w.a, w.b, c.x - h + EPS, c.y - h + EPS, c.x + h - EPS, c.y + h - EPS)) return false;
      if (segIntersect(input.spawn, c, w.a, w.b)) return false;
    }
    return true;
  };
  return input.sizes.map((size) => {
    const at = candidates.find((c) => fits(c, size)) ?? { ...input.spawn };
    taken.push({ x: at.x, y: at.y, size });
    return at;
  });
}
