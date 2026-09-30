/**
 * `pnpm bench` — server command handling (SPEC §37: "Server command handling: p95 < 5 ms"; AC-PERF-03). A real server
 * (the test harness: its database, its services) and the campaign's real command bus, on a scene of the benchmark's
 * size — 200 × 150 ft, 300 walls with 12 doors, 40 creatures, 20 lights — then 600 commands as play makes them:
 * creatures moving along paths (most), damage and healing, doors, lights, conditions, token edits. Each timed as the
 * bus times it (validate, authorise, plan, apply, history row). Prints JSON; exits 1 when p95 is over budget.
 */
import { campaignBus } from "../http/campaignBus.ts";
import { createCampaign, setupAdmin, startTestServer } from "../test/harness.ts";
import { rng } from "./visionScene.ts";

const BUDGET_MS = 5;
const COMMANDS = 600;
const W = 200;
const H = 150;

const round = (ms: number) => Math.round(ms * 100) / 100;
const quantile = (xs: number[], q: number) => {
  const s = xs.slice().sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor(q * s.length))] as number);
};

export async function commandsBench(): Promise<{
  p50: number;
  p95: number;
  max: number;
  commands: number;
  ok: boolean;
  byType: Record<string, { n: number; p50: number; p95: number }>;
}> {
  const t = await startTestServer();
  try {
    const admin = await setupAdmin(t);
    const campaignId = await createCampaign(admin, "Bench");
    const bus = campaignBus(t.server.ctx, campaignId);
    const adminUser = t.server.ctx.profiles.admin();
    if (!adminUser) throw new Error("no admin");
    const actor = { userId: adminUser.id, role: "admin" as const, name: "Bench", actingAs: null };
    const run = <T>(type: string, payload: unknown) => bus.execute<T>(type, payload, actor);
    const r = rng(37);

    // ── The scene ──
    const { sceneId } = run<{ sceneId: string }>("scene.create", {
      name: "Benchmark",
      mapKind: "procedural",
      floorStyle: "stone",
      widthFt: W,
      heightFt: H,
      fogMode: "dynamic",
    });
    // Rooms on a 25-ft grid: each cell's north and west walls, broken by gaps, 12 of them doors.
    const walls: { a: { x: number; y: number }; b: { x: number; y: number }; kind?: string }[] = [];
    for (let gx = 0; gx < W; gx += 25)
      for (let gy = 0; gy < H; gy += 25) {
        walls.push(
          { a: { x: gx, y: gy }, b: { x: gx + 10, y: gy } },
          { a: { x: gx + 15, y: gy }, b: { x: gx + 25, y: gy } },
        );
        walls.push(
          { a: { x: gx, y: gy }, b: { x: gx, y: gy + 10 } },
          { a: { x: gx, y: gy + 15 }, b: { x: gx, y: gy + 25 } },
        );
      }
    while (walls.length < 300) {
      const x = 5 + r() * (W - 10);
      const y = 5 + r() * (H - 10);
      walls.push({ a: { x, y }, b: { x: x + 3, y: y + 3 } });
    }
    for (let i = 0; i < 12; i++) (walls[i * 7] as { kind?: string }).kind = "door";
    const wallIds: string[] = [];
    for (let i = 0; i < walls.length; i += 150)
      wallIds.push(
        ...run<{ wallIds: string[] }>("wall.create", { sceneId, walls: walls.slice(i, i + 150) }).wallIds,
      );
    const doors = wallIds.filter((_, i) => i % 7 === 0 && i < 84);
    const tokens: string[] = [];
    /** Where each creature stands (a move starts there). */
    const at = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < 40; i++)
      tokens.push(
        run<{ tokenId: string }>("token.create", {
          sceneId,
          name: `Creature ${i + 1}`,
          pos: { x: 12.5 + 25 * (i % 8), y: 12.5 + 25 * Math.floor(i / 8) },
          stats: { hp: 30, hpMax: 30, ac: 13 },
        }).tokenId,
      );
    for (const [i, t] of tokens.entries())
      at.set(t, { x: 12.5 + 25 * (i % 8), y: 12.5 + 25 * Math.floor(i / 8) });
    const lights: string[] = [];
    for (let i = 0; i < 20; i++)
      lights.push(
        run<{ lightId: string }>("light.create", {
          sceneId,
          pos: { x: 5 + r() * (W - 10), y: 5 + r() * (H - 10) },
          preset: i % 3 === 0 ? "torch" : "lamp",
        }).lightId,
      );

    // ── Play ──
    const start = bus.timings.length;
    const types: string[] = [];
    const conditions = ["prone", "poisoned", "frightened", "restrained"];
    for (let i = 0; i < COMMANDS; i++) {
      const k = r();
      const tok = tokens[Math.floor(r() * tokens.length)] as string;
      let type: string;
      let payload: unknown;
      let moved: { tok: string; to: { x: number; y: number } } | null = null;
      if (k < 0.55) {
        // A move within its room (DMs move freely out of combat), from where it stands: two legs.
        const col = tokens.indexOf(tok) % 8;
        const row = Math.floor(tokens.indexOf(tok) / 8);
        const from = at.get(tok) as { x: number; y: number };
        const to = { x: 12.5 + 25 * col + (r() - 0.5) * 14, y: 12.5 + 25 * row + (r() - 0.5) * 14 };
        const via = { x: (from.x + to.x) / 2 + 1, y: (from.y + to.y) / 2 };
        type = "move.commit";
        payload = { tokenId: tok, points: [from, via, to] };
        moved = { tok, to };
      } else if (k < 0.7) {
        type = "hp.apply";
        payload = { targets: [tok], kind: r() < 0.7 ? "damage" : "heal", amount: 1 + Math.floor(r() * 6) };
      } else if (k < 0.78) {
        type = "door.toggle";
        payload = { wallId: doors[Math.floor(r() * doors.length)], action: "toggle" };
      } else if (k < 0.86) {
        type = "light.toggle";
        payload = { lightId: lights[Math.floor(r() * lights.length)] };
      } else if (k < 0.94) {
        type = "status.change";
        payload = { tokenId: tok, add: [{ id: conditions[Math.floor(r() * conditions.length)] }] };
      } else {
        type = "token.update";
        payload = { tokenId: tok, name: `Creature ${i}` };
      }
      try {
        run(type, payload);
        types.push(type);
        if (moved) at.set(moved.tok, moved.to);
      } catch {
        // (A move back onto a spot it can't take, a toggle refused: not counted — only work the bus did.)
      }
    }
    const raw = bus.timings.slice(start);
    const byType: Record<string, { n: number; p50: number; p95: number }> = {};
    for (const ty of new Set(types)) {
      const xs = raw.filter((_, i) => types[i] === ty);
      if (xs.length) byType[ty] = { n: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) };
    }
    const p95 = quantile(raw, 0.95);
    return {
      p50: quantile(raw, 0.5),
      p95,
      max: round(Math.max(...raw)),
      commands: raw.length,
      ok: p95 < BUDGET_MS && raw.length > COMMANDS * 0.8,
      byType,
    };
  } finally {
    await t.stop();
  }
}

if (import.meta.main) {
  // Warm up (JIT), then the measured run.
  await commandsBench();
  const res = await commandsBench();
  console.log(JSON.stringify({ commands: { ...res, budgetP95Ms: BUDGET_MS } }));
  process.exit(res.ok ? 0 : 1);
}
